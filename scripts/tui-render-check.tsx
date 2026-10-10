/**
 * TUI render + keyboard check: mounts the Ink app with a mock agent/db,
 * types a question through the real input pipeline, runs a mocked streaming
 * turn, then exercises the footer shortcuts the status bar advertises:
 *   ctrl+o with no result → explains itself (and must not type a stray "o")
 *   ctrl+t               → expands tool details retroactively
 *   ctrl+o               → opens the interactive table viewer
 *   q                    → closes the viewer again
 * Run with: npx tsx scripts/tui-render-check.tsx
 */

import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { Tui } from '../src/tui/app.js';
import type { AgentHooks } from '../src/core/types.js';

const mockDb: any = {
  dialect: 'sqlite' as const,
  describeTarget: () => 'sqlite file: :memory: (mock)',
  listTables: async () => [
    {
      name: 'customers',
      kind: 'table' as const,
      rowCountEstimate: 2,
      columns: [
        { name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, defaultValue: null },
        { name: 'name', dataType: 'TEXT', nullable: false, isPrimaryKey: false, defaultValue: null },
      ],
    },
  ],
  describeTable: async () => null,
  sampleRows: async () => ({ columns: [], rows: [], rowCount: 0, durationMs: 0 }),
  execute: async () => ({ columns: [], rows: [], rowCount: 0, durationMs: 0 }),
  close: async () => {},
};

const mockAgent: any = {
  reset: () => {},
  getHistory: () => [],
  runTurnStream: async (_q: string, opts?: any) => {
    // Simulate a real streaming turn incl. usage + a table tool result.
    for (const part of ['MOCK-', 'ANSWER-', 'OK']) {
      opts?.onEvent?.({ kind: 'text_delta', text: part });
    }
    opts?.onEvent?.({
      kind: 'tool_start',
      id: 't1',
      name: 'query',
      args: { sql: 'SELECT 1' },
    });
    opts?.onEvent?.({
      kind: 'tool_done',
      id: 't1',
      name: 'query',
      ok: true,
      durationMs: 12,
      preview: '1 row',
      data: { kind: 'table', columns: ['id'], rows: [[1]], rowCount: 1 },
    });
    opts?.onEvent?.({ kind: 'usage', usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 } });
    opts?.onEvent?.({ kind: 'turn_done', text: 'MOCK-ANSWER-OK', rounds: 1 });
    return { text: 'MOCK-ANSWER-OK', rounds: 1 };
  },
};

const frames: string[] = [];
const stdout = new PassThrough();
stdout.on('data', (c) => frames.push(String(c)));

// Ink needs a TTY-capable stdin for useInput; stub one for CI.
const stdin = new PassThrough() as any;
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => stdin;
stdin.unref = () => stdin;

const hooks: AgentHooks = {};

const { unmount, waitUntilExit } = render(
  <Tui
    agent={mockAgent}
    db={mockDb}
    provider="openai"
    model="mock-model"
    allowWrites={false}
    assumeYes={false}
    hooks={hooks}
    maxRows={100}
    sessionLabel="tui-check"
    onSave={() => {}}
  />,
  // interactive: frames are flushed on every render (non-interactive Ink only
  // writes the final frame at unmount, which can't be asserted against).
  { stdout: stdout as any, stdin, exitOnCtrlC: false, interactive: true, patchConsole: false },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const feed = async (bytes: number[] | string, waitMs = 250) => {
  stdin.write(typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes));
  await sleep(waitMs);
};
/** Feed text one character at a time, like real typing. */
const type = async (text: string) => {
  for (const ch of text) await feed(Buffer.from(ch), 30);
};

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
};
const snapshot = () => frames.join('');
const deltaSince = (mark: number) => snapshot().slice(mark);

await sleep(300);
let joined = snapshot();
check('banner rendered', joined.includes('DBAgent — AI for your databases'), joined.slice(0, 300));
check('target line rendered', joined.includes('sqlite file: :memory: (mock)'));

// ── ctrl+o before any query: must explain itself, not type a stray "o" ──
let mark = joined.length;
await feed([0x0f]); // ctrl+o
let delta = deltaSince(mark);
check(
  'ctrl+o without a result explains itself',
  delta.includes('No table result to view yet'),
  JSON.stringify(delta.slice(-300)),
);
check('ctrl+o leaves no stray "o" in the prompt', !delta.includes('you › o'), JSON.stringify(delta));

// ── ask a question through the real input pipeline ──
await type('top customers');
await feed('\r', 600);
joined = snapshot();
check('turn answered', joined.includes('MOCK-ANSWER-OK'), joined.slice(-400));
check('tool block rendered', joined.includes('query SELECT 1'), joined.slice(-400));
check('tool details hidden by default', !joined.includes('ctrl+o to open interactive viewer'));

// ── ctrl+t expands tool details retroactively ──
mark = joined.length;
await feed([0x14]); // ctrl+t
delta = deltaSince(mark);
check(
  'ctrl+t expands tool details',
  delta.includes('ctrl+o to open interactive viewer (1 rows)'),
  JSON.stringify(delta.slice(-400)),
);
check('ctrl+t flips the status-bar hint', delta.includes('ctrl+t hide details'), JSON.stringify(delta));
check('ctrl+t leaves no stray "t" in the prompt', !delta.includes('you › t'), JSON.stringify(delta));

// ── ctrl+o opens the interactive table viewer over the latest result ──
mark = snapshot().length;
await feed([0x0f]); // ctrl+o
delta = deltaSince(mark);
check('ctrl+o opens the table viewer', delta.includes('[table]'), JSON.stringify(delta.slice(-400)));

// ── q closes the viewer again ──
mark = snapshot().length;
await feed('q', 300);
delta = deltaSince(mark);
check('q closes the table viewer', !delta.includes('[table]'), JSON.stringify(delta.slice(-400)));

unmount();
await waitUntilExit();

if (failures > 0) process.exit(1);
console.log('TUI render check passed ✓');
process.exit(0);
