/**
 * SQL Server support checks — no live server needed.
 *
 * Verifies: URL parsing (sqlserver://, mssql://, params), driver wiring,
 * T-SQL limit enforcement (TOP / OFFSET-FETCH), write-statements disguised
 * as reads (SELECT INTO, CTE + DML), and the dialect-aware system prompt.
 */

import { parseDatabaseUrl, createDatabaseDriver } from '../dist/db/factory.js';
import { enforceLimit, classifyStatement, singleStatement } from '../dist/db/guard.js';
import { buildSystemPrompt } from '../dist/core/prompt.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
};

// ── 1. URL parsing ─────────────────────────────────────────────────────────
{
  const c = parseDatabaseUrl(
    'sqlserver://sa:P%40ss@localhost:1433/mydb?encrypt=true&trustServerCertificate=false',
  );
  check('url: dialect', c.dialect === 'sqlserver', c.dialect);
  check('url: host', c.host === 'localhost', c.host);
  check('url: port', c.port === 1433, String(c.port));
  check('url: database', c.database === 'mydb', c.database);
  check('url: user decoded', c.user === 'sa', c.user);
  check('url: password url-decoded', c.password === 'P@ss', c.password);
  check('url: encrypt param', c.ssl === true, String(c.ssl));
  check('url: trustServerCertificate param', c.trustServerCertificate === false, String(c.trustServerCertificate));

  const alias = parseDatabaseUrl('mssql://sa@sqlhost/prod');
  check('url: mssql:// alias', alias.dialect === 'sqlserver');
  check('url: default port 1433', alias.port === 1433, String(alias.port));
  check('url: encrypt left to driver default (true)', alias.ssl === undefined, String(alias.ssl));

  const inst = parseDatabaseUrl('sqlserver://sa@dbhost/prod?instance=SQLEXPRESS');
  check('url: instance param', inst.instanceName === 'SQLEXPRESS', inst.instanceName);
  check('url: named instance has no fixed port', inst.port === undefined, String(inst.port));

  let threw = false;
  try {
    parseDatabaseUrl('oracle://x/y');
  } catch {
    threw = true;
  }
  check('url: unsupported scheme still rejected', threw);

  let instanceHint = '';
  try {
    parseDatabaseUrl('sqlserver://sa@dbhost\\SQLEXPRESS/master');
  } catch (err) {
    instanceHint = err.message;
  }
  check('url: host\\INSTANCE form gets a helpful error', instanceHint.includes('?instance='), instanceHint);
}

// ── 2. Driver wiring (constructor never connects) ──────────────────────────
{
  const drv = createDatabaseDriver('sqlserver://sa@localhost:1433/mydb');
  check('driver: dialect', drv.dialect === 'sqlserver', drv.dialect);
  const target = drv.describeTarget();
  check('driver: describeTarget', target.includes('sql server') && target.includes('mydb'), target);
  await drv.close(); // no pool yet — must not throw
  check('driver: close before connect is safe', true);
}

// ── 3. T-SQL limit enforcement ─────────────────────────────────────────────
{
  check(
    'limit: plain SELECT gets TOP',
    enforceLimit('SELECT * FROM t', 100, 'sqlserver') === 'SELECT TOP (100) * FROM t',
    enforceLimit('SELECT * FROM t', 100, 'sqlserver'),
  );
  check(
    'limit: DISTINCT keeps order (SELECT DISTINCT TOP)',
    enforceLimit('SELECT DISTINCT name FROM t', 10, 'sqlserver') ===
      'SELECT DISTINCT TOP (10) name FROM t',
    enforceLimit('SELECT DISTINCT name FROM t', 10, 'sqlserver'),
  );
  check(
    'limit: existing TOP untouched',
    enforceLimit('SELECT TOP (5) * FROM t', 10, 'sqlserver') === 'SELECT TOP (5) * FROM t',
  );
  const ordered = enforceLimit('SELECT a FROM t ORDER BY a', 10, 'sqlserver');
  check('limit: ordered SELECT capped with TOP', ordered === 'SELECT TOP (10) a FROM t ORDER BY a', ordered);
  const cte = enforceLimit('WITH x AS (SELECT a FROM t) SELECT a FROM x', 10, 'sqlserver');
  check('limit: CTE wrapped with TOP', cte.startsWith('SELECT TOP (10) * FROM (\n'), cte);
  const cteOrdered = enforceLimit(
    'WITH x AS (SELECT a FROM t) SELECT a FROM x ORDER BY a',
    10,
    'sqlserver',
  );
  check(
    'limit: ordered CTE paged with OFFSET/FETCH',
    /OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY\s*$/.test(cteOrdered),
    cteOrdered,
  );
  const union = enforceLimit('SELECT a FROM t UNION SELECT a FROM u', 10, 'sqlserver');
  check('limit: UNION wrapped (TOP only caps one branch otherwise)', union.startsWith('SELECT TOP (10) * FROM (\n'), union);
  const unionOrdered = enforceLimit(
    'SELECT a FROM t UNION SELECT a FROM u ORDER BY a',
    10,
    'sqlserver',
  );
  check(
    'limit: ordered UNION paged',
    /OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY\s*$/.test(unionOrdered),
    unionOrdered,
  );
  check(
    'limit: paged query not re-limited',
    enforceLimit('SELECT a FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY', 10, 'sqlserver') ===
      'SELECT a FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY',
  );
  check(
    'limit: EXPLAIN untouched',
    enforceLimit('EXPLAIN SELECT * FROM t', 10, 'sqlserver') === 'EXPLAIN SELECT * FROM t',
  );
  // regression: other dialects keep their LIMIT behavior
  check(
    'limit: sqlite unchanged',
    /LIMIT 10$/.test(enforceLimit('SELECT * FROM t', 10, 'sqlite').trim()),
    enforceLimit('SELECT * FROM t', 10, 'sqlite'),
  );
  check(
    'limit: mysql CTE wrap unchanged',
    /LIMIT 5$/.test(enforceLimit('WITH x AS (SELECT 1 AS a) SELECT a FROM x', 5, 'mysql').trim()),
    enforceLimit('WITH x AS (SELECT 1 AS a) SELECT a FROM x', 5, 'mysql'),
  );
}

// ── 4. Writes disguised as reads are still blocked ─────────────────────────
{
  check(
    'guard: SELECT INTO classified as write',
    classifyStatement('SELECT * INTO newt FROM oldt') === 'write',
    classifyStatement('SELECT * INTO newt FROM oldt'),
  );
  check(
    'guard: CTE + DELETE classified as write',
    classifyStatement(
      'WITH x AS (SELECT id FROM t) DELETE FROM u WHERE id IN (SELECT id FROM x)',
    ) === 'write',
  );
  check('guard: plain SELECT still read', classifyStatement('SELECT * FROM t') === 'read');
  check(
    "guard: 'into' inside a string literal stays read",
    classifyStatement("SELECT note FROM logs WHERE note = 'moved into archive'") === 'read',
  );
  check(
    'guard: bracketed [update] column stays read',
    classifyStatement('SELECT [update] FROM t') === 'read',
  );
  check('guard: singleStatement still rejects chains', (() => {
    try {
      singleStatement('SELECT 1; DROP TABLE t', 1);
      return false;
    } catch {
      return true;
    }
  })());
}

// ── 5. Dialect-aware system prompt ─────────────────────────────────────────
{
  const drv = createDatabaseDriver('sqlserver://sa@localhost:1433/mydb');
  const prompt = await buildSystemPrompt(drv, { id: 'openai', model: 'test' });
  check('prompt: dialect declared', prompt.includes('SQL dialect: SQLSERVER'));
  check('prompt: T-SQL notes present', prompt.includes('TOP (n)'), prompt.slice(0, 200));
  check('prompt: mentions dbo default schema', prompt.includes('dbo'));
  check('prompt: TOP wording instead of LIMIT', prompt.includes('TOP (n) or OFFSET/FETCH'));
  await drv.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll SQL Server dialect checks passed');
