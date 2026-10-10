/**
 * Oracle URL, driver, SQL guard and system integration checks; no live server.
 */
import { strict as assert } from 'node:assert';
import { createDatabaseDriver, parseDatabaseUrl } from '../dist/db/factory.js';
import { classifyStatement, enforceLimit } from '../dist/db/guard.js';
import { buildSystemPrompt } from '../dist/core/prompt.js';
import { performanceQueries, runExplain } from '../dist/system/perf.js';
import { quoteIdent } from '../dist/system/ops.js';

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

await check('MariaDB URL uses compatible MySQL dialect and default port', async () => {
  const conn = parseDatabaseUrl('mariadb://report:secret@db.example/reporting');
  assert.equal(conn.dialect, 'mysql');
  assert.equal(conn.host, 'db.example');
  assert.equal(conn.port, 3306);
  assert.equal(conn.database, 'reporting');
  const driver = createDatabaseDriver('mariadb://localhost/reporting');
  assert.equal(driver.dialect, 'mysql');
  await driver.close();
});

await check('Oracle service URL parses credentials and default port', () => {
  const conn = parseDatabaseUrl('oracle://report:p%40ss@db.example/FREEPDB1');
  assert.equal(conn.dialect, 'oracle');
  assert.equal(conn.host, 'db.example');
  assert.equal(conn.port, 1521);
  assert.equal(conn.database, 'FREEPDB1');
  assert.equal(conn.user, 'report');
  assert.equal(conn.password, 'p@ss');
});

await check('Oracle SID and TCPS URLs are supported', () => {
  const sid = parseDatabaseUrl('oracle://report:secret@db.example:1522/?sid=ORCL');
  assert.equal(sid.oracleSid, 'ORCL');
  assert.equal(sid.port, 1522);
  const tcps = parseDatabaseUrl('oracle+tcps://report:secret@db.example/FREEPDB1');
  assert.equal(tcps.oracleProtocol, 'tcps');
  assert.equal(tcps.ssl, true);
});

await check('Oracle driver constructs without connecting and closes safely', async () => {
  const driver = createDatabaseDriver('oracle://report:secret@localhost/FREEPDB1');
  assert.equal(driver.dialect, 'oracle');
  assert.match(driver.describeTarget(), /FREEPDB1/);
  await driver.close();
});

await check('Oracle row cap and identifiers use Oracle syntax', () => {
  assert.equal(
    enforceLimit('SELECT * FROM employees', 25, 'oracle'),
    'SELECT * FROM employees\nFETCH FIRST 25 ROWS ONLY',
  );
  assert.equal(
    enforceLimit('SELECT * FROM employees FETCH FIRST 3 ROWS ONLY', 25, 'oracle'),
    'SELECT * FROM employees FETCH FIRST 3 ROWS ONLY',
  );
  assert.equal(
    enforceLimit('WITH e AS (SELECT * FROM employees) SELECT * FROM e', 25, 'oracle'),
    'WITH e AS (SELECT * FROM employees) SELECT * FROM e\nFETCH FIRST 25 ROWS ONLY',
  );
  assert.equal(quoteIdent('oracle', 'HR.Employee'), '"HR"."Employee"');
  assert.equal(classifyStatement('SELECT * FROM employees FOR UPDATE'), 'write');
});

await check('Oracle connect descriptor values reject injection characters', async () => {
  const driver = createDatabaseDriver('oracle://report:secret@localhost/BAD%29%28');
  await assert.rejects(driver.listTables(), /service name\/SID contains unsupported characters/);
  await driver.close();
});

await check('Oracle prompt and diagnostics are dialect-specific', async () => {
  const driver = createDatabaseDriver('oracle://report:secret@localhost/FREEPDB1');
  const prompt = await buildSystemPrompt(driver, { id: 'openai', model: 'test' });
  assert.match(prompt, /SQL dialect: ORACLE/);
  assert.match(prompt, /FETCH FIRST/);
  const names = performanceQueries('oracle').map((spec) => spec.name);
  assert(names.includes('invalid_indexes'));
  assert(names.includes('session_activity'));
  await driver.close();
});

await check('Oracle explain delegates only to its dedicated driver method', async () => {
  const driver = {
    dialect: 'oracle',
    describeTarget: () => 'oracle test',
    explainQuery: async (sql) => ({
      columns: ['plan'],
      rows: [[sql]],
      rowCount: 1,
      durationMs: 1,
    }),
  };
  const plan = await runExplain(driver, 'SELECT * FROM employees');
  assert.equal(plan.rows[0][0], 'SELECT * FROM employees\nFETCH FIRST 100 ROWS ONLY');
});

console.log(`\n${passed}/8 Oracle/MariaDB integration checks passed`);
