/**
 * Performance diagnostics checks (no LLM, no server — SQLite demo DB).
 *
 * Verifies: core-tool registration (performance_report / explain_query are
 * always on, system tools stay gated), the per-dialect diagnostic SQL
 * catalog, the live report on demo.db (including graceful section
 * degradation), dialect-aware explain (plan rows, write rejection before any
 * connection attempt), and an agent round-trip through both tools.
 */

import { createDatabaseDriver } from '../dist/db/factory.js';
import { buildTools } from '../dist/tools/index.js';
import { performanceQueries, runPerformanceReport, runExplain } from '../dist/system/perf.js';
import { Agent } from '../dist/core/agent.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
};
const sqlOf = (list, name) => list.find((s) => s.name === name)?.sql ?? '';
const expectReject = async (name, promise, pattern) => {
  try {
    await promise;
    check(name, false, 'expected rejection, got success');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, pattern.test(msg), msg.slice(0, 160));
  }
};

const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 100 });

// ── 1. Core tools are always on; system tools stay gated ───────────────────
{
  const { tools, registry } = buildTools(db); // no opts — default gates
  const names = tools.map((t) => t.name);
  check(
    'tools: performance_report is core (no --allow-system)',
    names.includes('performance_report'),
  );
  check('tools: explain_query is core (no --allow-system)', names.includes('explain_query'));
  check('tools: db_stats still gated without --allow-system', !names.includes('db_stats'));
  check(
    'tools: handlers registered',
    registry.has('performance_report') && registry.has('explain_query'),
  );
  const spec = tools.find((t) => t.name === 'explain_query');
  check('tools: explain_query requires sql', spec?.parameters?.required?.includes('sql'));
}

// ── 2. Diagnostic SQL catalog per dialect ──────────────────────────────────
{
  const ss = performanceQueries('sqlserver');
  const ssNames = ss.map((s) => s.name);
  for (const n of [
    'disabled_indexes',
    'missing_indexes',
    'unused_indexes',
    'duplicate_indexes',
    'wait_stats',
    'expensive_queries',
    'blocking',
    'buffer_cache',
  ]) {
    check(`catalog sqlserver has ${n}`, ssNames.includes(n));
  }
  check(
    'catalog: fragmentation is deep-only',
    ss.find((s) => s.name === 'fragmentation')?.deepOnly === true,
  );
  check(
    'catalog: missing-index uses DMVs',
    sqlOf(ss, 'missing_indexes').includes('dm_db_missing_index_details'),
  );
  check(
    'catalog: unused-index protects PK/unique and reads usage stats',
    sqlOf(ss, 'unused_indexes').includes('is_primary_key = 0') &&
      sqlOf(ss, 'unused_indexes').includes('is_unique = 0') &&
      sqlOf(ss, 'unused_indexes').includes('dm_db_index_usage_stats'),
  );

  const pg = performanceQueries('postgres');
  const pgNames = pg.map((s) => s.name);
  for (const n of [
    'invalid_indexes',
    'unused_indexes',
    'duplicate_indexes',
    'seq_scan_hotspots',
    'dead_tuples',
    'cache_hit',
    'long_running',
    'top_statements',
  ]) {
    check(`catalog postgres has ${n}`, pgNames.includes(n));
  }
  check(
    'catalog: broken index detection (indisvalid)',
    sqlOf(pg, 'invalid_indexes').includes('indisvalid'),
  );
  check(
    'catalog: pg unused excludes PK/unique/FK-supporting',
    sqlOf(pg, 'unused_indexes').includes('indisprimary') &&
      sqlOf(pg, 'unused_indexes').includes('indisunique') &&
      sqlOf(pg, 'unused_indexes').includes('pg_constraint'),
  );
  check(
    'catalog: pg_stat_statements has legacy fallback',
    !!pg.find((s) => s.name === 'top_statements')?.fallbackSql,
  );
  check(
    'catalog: no T-SQL bracket aliases in postgres SQL',
    pg.every((s) => !s.sql.includes('[') && !(s.fallbackSql ?? '').includes('[')),
  );

  const my = performanceQueries('mysql');
  const myNames = my.map((s) => s.name);
  for (const n of [
    'unused_indexes',
    'redundant_indexes',
    'full_table_scans',
    'slow_statements',
    'buffer_pool',
    'server_counters',
    'table_sizes',
  ]) {
    check(`catalog mysql has ${n}`, myNames.includes(n));
  }
  check(
    'catalog: mysql unused uses sys schema',
    sqlOf(my, 'unused_indexes').includes('sys.schema_unused_indexes'),
  );
  check(
    'catalog: mysql redundant offers drop SQL',
    sqlOf(my, 'redundant_indexes').includes('sql_drop'),
  );
  check(
    'catalog: no bracket aliases in mysql SQL',
    my.every((s) => !s.sql.includes('[')),
  );

  const lite = performanceQueries('sqlite');
  check(
    'catalog: sqlite space uses pragma TVFs',
    sqlOf(lite, 'space').includes('pragma_page_count'),
  );
  check(
    'catalog: sqlite table_sizes is deep-only',
    lite.find((s) => s.name === 'table_sizes')?.deepOnly === true,
  );
}

// ── 3. Live report on demo.db (incl. graceful degradation) ─────────────────
{
  const rep = await runPerformanceReport(db);
  check('report: dialect echoed', rep.dialect === 'sqlite', rep.dialect);
  check('report: sections present', rep.sections.length >= 3, String(rep.sections.length));
  const space = rep.sections.find((s) => s.name === 'space');
  check('report: space section ok', space?.ok === true, space?.error ?? '');
  check(
    'report: space exposes page_count',
    (space?.columns ?? []).includes('page_count'),
    JSON.stringify(space?.columns),
  );
  const indexes = rep.sections.find((s) => s.name === 'indexes');
  check(
    'report: index inventory ok',
    indexes?.ok === true && indexes.columns.includes('index_name'),
    indexes?.error ?? '',
  );
  const stat1 = rep.sections.find((s) => s.name === 'stat1');
  check(
    'report: missing sqlite_stat1 degrades to an error note (no ANALYZE yet)',
    stat1?.ok === false &&
      typeof stat1?.error === 'string' &&
      stat1.error.includes('sqlite_stat1') &&
      stat1.note.length > 0,
    JSON.stringify(stat1),
  );
  check(
    'report: every section has a note',
    rep.sections.every((s) => s.note.length > 0),
  );
  check(
    'report: rows bounded (<=25 per section)',
    rep.sections.every((s) => s.rows.length <= 25),
  );
  check(
    'report: result is JSON-serializable (BigInt/Date safe)',
    (() => {
      try {
        JSON.stringify(rep);
        return true;
      } catch {
        return false;
      }
    })(),
  );
  const deep = await runPerformanceReport(db, { deep: true });
  check(
    'report: deep adds table_sizes',
    deep.sections.some((s) => s.name === 'table_sizes'),
  );
  check('report: deep flag echoed', deep.deep === true);
}

// ── 4. explain_query on SQLite ─────────────────────────────────────────────
{
  const plan = await runExplain(db, 'SELECT name FROM customers');
  check(
    'explain: detail column present',
    plan.columns.includes('detail'),
    JSON.stringify(plan.columns),
  );
  check('explain: plan rows returned', plan.rows.length > 0, String(plan.rows.length));
  const detailIdx = plan.columns.indexOf('detail');
  check(
    'explain: plan shows SCAN/SEARCH operator',
    plan.rows.some((r) => /SCAN|SEARCH/.test(String(r[detailIdx]))),
    JSON.stringify(plan.rows).slice(0, 160),
  );
  const prefixed = await runExplain(db, 'EXPLAIN QUERY PLAN SELECT * FROM customers');
  check(
    'explain: pre-existing EXPLAIN prefix not doubled',
    prefixed.rows.length > 0,
    String(prefixed.rows.length),
  );
  await expectReject(
    'explain: writes rejected',
    runExplain(db, 'DELETE FROM customers'),
    /read statements/,
  );
  await expectReject(
    'explain: chained statements rejected',
    runExplain(db, 'SELECT 1; DROP TABLE customers'),
    /statement/i,
  );
}

// ── 5. SQL Server explain rejects writes BEFORE connecting ─────────────────
{
  const ssDb = createDatabaseDriver('sqlserver://sa@localhost:1433/master');
  await expectReject(
    'explain: sqlserver write rejected without connecting',
    runExplain(ssDb, 'DROP TABLE x'),
    /read statements/,
  );
  await ssDb.close();
}

// ── 6. Agent round-trip through both tools ─────────────────────────────────
{
  const makeLLM = (script) => {
    let round = 0;
    return {
      id: 'openai',
      model: 'scripted',
      async complete(messages) {
        const step = script[round++];
        if (!step) throw new Error(`unexpected extra LLM round ${round}`);
        return step(messages);
      },
    };
  };

  const perfAgent = new Agent(
    makeLLM([
      () => ({ toolCalls: [{ id: 'c1', name: 'performance_report', args: {} }] }),
      (messages) => {
        const r = messages[messages.length - 1]?.toolResult?.result;
        return { text: `sections=${r.sections.length} dialect=${r.dialect}` };
      },
    ]),
    db,
    { id: 'openai', model: 'scripted' },
    4,
  );
  const perfRes = await perfAgent.runTurn('how is performance?');
  check(
    'agent: performance_report round-trip',
    perfRes.text.startsWith('sections=') && perfRes.text.includes('dialect=sqlite'),
    perfRes.text,
  );

  const explainAgent = new Agent(
    makeLLM([
      () => ({
        toolCalls: [{ id: 'c1', name: 'explain_query', args: { sql: 'SELECT * FROM customers' } }],
      }),
      (messages) => {
        const r = messages[messages.length - 1]?.toolResult?.result;
        return { text: `plan_rows=${r.rowCount}` };
      },
    ]),
    db,
    { id: 'openai', model: 'scripted' },
    4,
  );
  const explainRes = await explainAgent.runTurn('why is this slow?');
  check(
    'agent: explain_query round-trip returns plan rows',
    /^plan_rows=[1-9]/.test(explainRes.text),
    explainRes.text,
  );
}

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll performance diagnostics checks passed');
