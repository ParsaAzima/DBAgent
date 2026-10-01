/**
 * Smoke test for file + shell tools (no LLM): read/write/edit/list/glob/grep
 * round-trip in a temp dir, gate enforcement, and bash execution.
 */

import { Agent } from '../dist/core/agent.js';
import { createDatabaseDriver } from '../dist/db/factory.js';
import { createFileToolRegistry } from '../dist/tools/file-tools.js';
import { createShellToolRegistry } from '../dist/tools/shell-tool.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

process.chdir(mkdtempSync(join(tmpdir(), 'dbagent-files-')));

// ── direct registry tests (allowed) ──
const files = createFileToolRegistry({ allowSystem: true });
const shell = createShellToolRegistry({ allowShell: true });

// write + read round trip
const w = await files.get('write_file')({ path: 'migrations/001_init.sql', content: 'CREATE TABLE t (id INT);\nSELECT 1;\n' });
check('write_file creates nested file', w.written === true && existsSync('migrations/001_init.sql'));
const r = await files.get('read_file')({ path: 'migrations/001_init.sql' });
check('read_file returns content', r.content.includes('CREATE TABLE') && r.totalLines === 3, JSON.stringify(r).slice(0, 120));
const r2 = await files.get('read_file')({ path: 'migrations/001_init.sql', offset: 1 });
check('read_file offset paging', r2.content.startsWith('SELECT 1;') && r2.offset === 1, JSON.stringify(r2));

// edit
await files.get('edit_file')({ path: 'migrations/001_init.sql', oldString: 'SELECT 1;', newString: 'SELECT 42;' });
check('edit_file replaced', readFileSync('migrations/001_init.sql', 'utf8').includes('SELECT 42;'));

// list + glob + grep
await files.get('write_file')({ path: 'notes.md', content: 'find me here\n' });
const ls = await files.get('list_dir')({});
check('list_dir entries', ls.items.some((i) => i.name === 'migrations') && ls.items.some((i) => i.name === 'notes.md'));
const gl = await files.get('glob_files')({ pattern: '**/*.sql' });
check('glob_files finds sql', gl.matches === 1 && gl.items[0].path.includes('001_init.sql'), JSON.stringify(gl));
const gr = await files.get('grep_files')({ pattern: 'SELECT 42' });
check('grep_files matches with line', gr.matchCount === 1 && gr.matches[0].line === 2, JSON.stringify(gr));

// delete
await files.get('delete_file')({ path: 'notes.md' });
check('delete_file removes', !existsSync('notes.md'));

// overwrite protection
let overwriteBlocked = false;
try {
  await files.get('write_file')({ path: 'migrations/001_init.sql', content: 'x' });
} catch (e) {
  overwriteBlocked = String(e.message).includes('File exists');
}
check('write_file overwrite protection', overwriteBlocked);

// shell
const sh = await shell.get('bash')({ command: 'echo dbagent-shell-ok' });
check('bash runs command', sh.exitCode === 0 && sh.stdout.trim() === 'dbagent-shell-ok', JSON.stringify(sh).slice(0, 120));
const shTimeout = await shell.get('bash')({ command: process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 5', timeoutMs: 1500 });
check('bash timeout kills process', shTimeout.killed === true, JSON.stringify(shTimeout).slice(0, 100));

// ── gate enforcement through Agent ──
const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 10 });
function makeFakeLLM() {
  return {
    id: 'openai',
    model: 'scripted',
    async complete(messages = []) {
      const last = messages[messages.length - 1];
      if (last?.role === 'tool') {
        return { text: `RESULT:${JSON.stringify(last.toolResult).slice(0, 300)}` };
      }
      return { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'migrations/001_init.sql' } }] };
    },
  };
}
const locked = new Agent(makeFakeLLM(), db, { id: 'openai', model: 's' }, 4);
const rLocked = await locked.runTurn('read the migration');
check('gated: read_file refused without --allow-system', rLocked.text.includes('Unknown tool'), rLocked.text.slice(0, 120));

const shellLocked = new Agent(
  {
    id: 'openai',
    model: 's',
    async complete(messages = []) {
      const last = messages[messages.length - 1];
      if (last?.role === 'tool') return { text: `RESULT:${JSON.stringify(last.toolResult).slice(0, 300)}` };
      return { toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'echo hi' } }] };
    },
  },
  db,
  { id: 'openai', model: 's' },
  4,
  { allowSystem: true }, // files allowed, shell NOT
);
const rShell = await shellLocked.runTurn('run echo');
check('gated: bash refused without --allow-shell even with system', rShell.text.includes('Unknown tool') || rShell.text.includes('--allow-shell'), rShell.text.slice(0, 140));

const shellOpen = new Agent(
  {
    id: 'openai',
    model: 's',
    async complete(messages = []) {
      const last = messages[messages.length - 1];
      if (last?.role === 'tool') return { text: `RESULT:${JSON.stringify(last.toolResult).slice(0, 300)}` };
      return { toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'echo agent-shell' } }] };
    },
  },
  db,
  { id: 'openai', model: 's' },
  4,
  { allowSystem: true, allowShell: true },
);
const rOpen = await shellOpen.runTurn('run echo');
check('open: bash executes with --allow-shell', rOpen.text.includes('agent-shell'), rOpen.text.slice(0, 140));

await db.close();
if (failures > 0) process.exit(1);
console.log('\nAll file/shell tool smoke checks passed');
process.exit(0);
