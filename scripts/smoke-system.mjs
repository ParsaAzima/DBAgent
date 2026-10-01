/**
 * Smoke test for system operations (no LLM): stats/info/export/import on the
 * demo sqlite DB, gate enforcement without --allow-system, backup via
 * VACUUM INTO, and CSV round-trip integrity.
 */

import { Agent } from '../dist/core/agent.js';
import { createDatabaseDriver } from '../dist/db/factory.js';
import { collectStats, collectSystemInfo, exportTable, importCsv, backup, parseCsv, toCsv } from '../dist/system/ops.js';
import { discoverLocalDatabases } from '../dist/system/discover.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
};

const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 100, allowWrites: true });

// 1. stats
const stats = await collectStats(db);
check('stats: 4 tables', stats.tables.length === 4, JSON.stringify(stats.tables.map((t) => t.table)));
check('stats: sqlite total size > 0', (stats.totalSizeBytes ?? 0) > 0);
check('stats: orders has ~6 rows', stats.tables.find((t) => t.table === 'orders')?.rowCountEstimate === 6);

// 2. system info
const info = await collectSystemInfo(db);
check('info: sqlite version present', !!info.version && info.version.startsWith('3'));
check('info: journal_mode captured', 'journal_mode' in info.settings);

// 3. export csv/json
const outDir = mkdtempSync(join(tmpdir(), 'dbagent-test-'));
const csvRes = await exportTable(db, 'customers', 'csv', join(outDir, 'customers.csv'));
check('export csv rows=5', csvRes.rows === 5, JSON.stringify(csvRes));
const csvText = readFileSync(join(outDir, 'customers.csv'), 'utf8');
check('export csv has header+rows', csvText.startsWith('id,name,email') && csvText.includes('ali@example.com'));
const jsonRes = await exportTable(db, 'products', 'json', join(outDir, 'products.json'));
const parsed = JSON.parse(readFileSync(join(outDir, 'products.json'), 'utf8'));
check('export json 5 products', jsonRes.rows === 5 && parsed.length === 5 && parsed[0].name);

// 4. csv round-trip (toCsv/parseCsv with quotes)
const roundTripped = parseCsv(toCsv(['a', 'b'], [['x,y', 'He said "hi"'], ['plain', '2']]));
check('csv round-trip quotes', roundTripped.rows[0][0] === 'x,y' && roundTripped.rows[0][1] === 'He said "hi"');

// 5. import into fresh table
const imp = await importCsv(db, join(outDir, 'customers.csv'), 'customers_import_test', { createTable: true });
check('import inserted 5 rows', imp.inserted === 5, JSON.stringify(imp));
const verify = await db.execute('SELECT COUNT(*) FROM customers_import_test');
check('import verified count', Number(verify.rows[0][0]) === 5);
// cleanup imported table
await db.execute('DROP TABLE customers_import_test');

// 6. backup via VACUUM INTO
const bak = await backup(db, join(outDir, 'demo-backup.db'));
check('backup file created > 0 bytes', existsSync(bak.file) && statSync(bak.file).size > 0, JSON.stringify(bak));
check('backup method VACUUM INTO', bak.method === 'VACUUM INTO');

// 7. gating: Agent without allowSystem must refuse
function makeFakeLLM() {
  return {
    id: 'openai',
    model: 'scripted',
    async complete(_messages) {
      const msgs = _messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'tool') {
        const payload = JSON.stringify(last.toolResult ?? {}).slice(0, 300);
        return { text: `RESULT:${payload}` };
      }
      return { toolCalls: [{ id: 'c1', name: 'db_stats', args: {} }] };
    },
  };
}
const agentLocked = new Agent(makeFakeLLM(), db, { id: 'openai', model: 'scripted' }, 4);
const r1 = await agentLocked.runTurn('stats please');
check('gated: db_stats unknown without --allow-system', String(r1.text).includes('Unknown tool'), r1.text.slice(0, 120));

const agentOpen = new Agent(makeFakeLLM(), db, { id: 'openai', model: 'scripted' }, 4, { allowSystem: true });
const r2 = await agentOpen.runTurn('stats please');
const okJson = r2.text.includes('"tables"') || r2.text.includes('orders');
check('open: db_stats returns data with --allow-system', okJson, r2.text.slice(0, 120));

// 8. discovery (best effort, machine-dependent)
const disc = await discoverLocalDatabases();
check('discover: returns structure', Array.isArray(disc.servers) && Array.isArray(disc.sqliteFiles));
check('discover: found demo.db', disc.sqliteFiles.some((f) => f.path.endsWith('demo.db')));

await db.close();
if (failures > 0) process.exit(1);
console.log('\nAll system ops smoke checks passed');
process.exit(0);
