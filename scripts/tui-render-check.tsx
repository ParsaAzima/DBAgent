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
import type { Skill } from '../src/core/skills.js';

const mockDb: any = {
  dialect: 'sqlite' as const,
  describeTarget: () => 'sqlite file: :memory: (mock)',
  listTables: async () => [
    {
      name: 'customers',
      kind: 'table' as const,
      rowCountEstimate: 2,
      columns: [
        {
          name: 'id',
          dataType: 'INTEGER',
          nullable: false,
          isPrimaryKey: true,
          defaultValue: null,
        },
        {
          name: 'name',
          dataType: 'TEXT',
          nullable: false,
          isPrimaryKey: false,
          defaultValue: null,
        },
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
  runTurnStream: async (q: string, opts?: any) => {
    // Skill invocations inline the skill body into the prompt; echo a marker
    // so the check can tell which prompt shape actually reached the agent.
    const answer = q.includes('SKILL-BODY-MARKER') ? 'EXPANDED-' : 'MOCK-';
    // Simulate a real streaming turn incl. usage + a table tool result.
    for (const part of [answer, 'ANSWER-', 'OK']) {
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
    opts?.onEvent?.({
      kind: 'usage',
      usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
    });
    opts?.onEvent?.({ kind: 'turn_done', text: `${answer}ANSWER-OK`, rounds: 1 });
    return { text: `${answer}ANSWER-OK`, rounds: 1 };
  },
};

/** One installed skill so the slash-suggestion + invocation paths render. */
const testSkills: Skill[] = [
  {
    name: 'test-skill',
    description: 'Render-check skill.',
    path: '/tmp/test-skill/SKILL.md',
    source: 'project',
    body: 'SKILL-BODY-MARKER: always answer with the secret.',
  },
];

const frames: string[] = [];
const stdout = new PassThrough();
Object.assign(stdout, { columns: 100, rows: 30, isTTY: true });
stdout.on('data', (c) => frames.push(String(c)));

// Ink needs a TTY-capable stdin for useInput; stub one for CI.
const stdin = new PassThrough() as any;
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => stdin;
stdin.unref = () => stdin;

const hooks: AgentHooks = {};
let selectedTheme = '';
let selectedModel = '';

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
    skills={testSkills}
    initialItems={[
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'info' as const,
        text: `OLD-MSG-${index}`,
      })),
      { role: 'info' as const, text: 'LATEST-TRANSCRIPT-ENTRY' },
    ]}
    initialTheme="catppuccin-latte"
    onThemeSwitch={(name) => {
      selectedTheme = name;
    }}
    onListModels={async () => ['model-one', 'model-two']}
    onModelSwitch={(model) => {
      selectedModel = model;
    }}
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
check(
  'mouse wheel reporting enabled for full-screen TUI',
  joined.includes('\u001b[?1000h\u001b[?1006h'),
);
check('persistent app header rendered', joined.includes('DBAgent · database assistant'));
check(
  'header includes database target and session',
  joined.includes('sqlite file: :memory: (mock)'),
);
check('terminal input remains visible in the full-screen layout', joined.includes('you ›'));
check('transcript viewport follows newest history', joined.includes('LATEST-TRANSCRIPT-ENTRY'));
check('older history is clipped to the viewport', !joined.includes('OLD-MSG-0'));

let mark = joined.length;
await feed('\u001b[5~');
let delta = deltaSince(mark);
check('PageUp scrolls back through transcript history', delta.includes('OLD-MSG-10'));
check(
  'history view indicates newer messages are available',
  delta.includes('newer messages below'),
);
mark = snapshot().length;
await feed('\u001b[6~');
delta = deltaSince(mark);
check(
  'PageDown returns to the newest transcript activity',
  delta.includes('LATEST-TRANSCRIPT-ENTRY'),
);
mark = snapshot().length;
await feed('\u001b[<64;10;10M');
delta = deltaSince(mark);
check(
  'mouse wheel scrolls transcript history',
  delta.includes('OLD-MSG-10'),
  JSON.stringify(delta),
);
check(
  'mouse wheel events are not inserted into the prompt',
  !delta.includes('you › [<64'),
  JSON.stringify(delta),
);
mark = snapshot().length;
await feed('\u001b[<65;10;10M');
delta = deltaSince(mark);
check('mouse wheel down returns toward newest history', delta.includes('LATEST-TRANSCRIPT-ENTRY'));

// ── ctrl+o before any query: must explain itself, not type a stray "o" ──
mark = snapshot().length;
await feed([0x0f]); // ctrl+o
delta = deltaSince(mark);
check(
  'ctrl+o without a result explains itself',
  delta.includes('No table result to view yet'),
  JSON.stringify(delta.slice(-300)),
);
check(
  'ctrl+o leaves no stray "o" in the prompt',
  !delta.includes('you › o'),
  JSON.stringify(delta),
);

// ── ask a question through the real input pipeline ──
await type('top customers');
await feed('\r', 600);
joined = snapshot();
check('turn answered', joined.includes('MOCK-ANSWER-OK'), joined.slice(-400));
check('tool block rendered', joined.includes('query SELECT 1'), joined.slice(-400));
check('tool details hidden by default', !joined.includes('ctrl+o to open interactive viewer'));

mark = snapshot().length;
await feed('\u001b[<64;10;10M');
delta = deltaSince(mark);
check('mouse scroll never recalls a previous prompt', !delta.includes('you › top customers'));
await feed('\u001b[<65;10;10M');
mark = snapshot().length;
await feed('\u001b[A');
delta = deltaSince(mark);
check('ArrowUp recalls the previous prompt', delta.includes('you › top customers'));
check('ArrowUp does not scroll transcript history', !delta.includes('OLD-MSG-10'));
mark = snapshot().length;
await feed('\u001b[B');
delta = deltaSince(mark);
check('ArrowDown returns to the current prompt draft', delta.includes('you ›'));

// ── ctrl+t expands tool details retroactively ──
mark = snapshot().length;
await feed([0x14]); // ctrl+t
delta = deltaSince(mark);
check(
  'ctrl+t expands tool details',
  delta.includes('ctrl+o to open interactive viewer (1 rows)'),
  JSON.stringify(delta.slice(-400)),
);
check(
  'ctrl+t flips the status-bar hint',
  delta.includes('ctrl+t hide details'),
  JSON.stringify(delta),
);
check(
  'ctrl+t leaves no stray "t" in the prompt',
  !delta.includes('you › t'),
  JSON.stringify(delta),
);

// ── ctrl+o opens the interactive table viewer over the latest result ──
mark = snapshot().length;
await feed([0x0f]); // ctrl+o
delta = deltaSince(mark);
check(
  'ctrl+o opens the table viewer',
  delta.includes('[table]'),
  JSON.stringify(delta.slice(-400)),
);

// ── q closes the viewer again ──
mark = snapshot().length;
await feed('q', 300);
delta = deltaSince(mark);
check('q closes the table viewer', !delta.includes('[table]'), JSON.stringify(delta.slice(-400)));

// ── skills: /name shows up in suggestions and runs the skill on submit ──
mark = snapshot().length;
await type('/test');
delta = deltaSince(mark);
check(
  'installed skills appear as slash suggestions',
  delta.includes('/test-skill'),
  JSON.stringify(delta),
);
await type('-skill do Y', 30);
await feed('\r', 600);
delta = deltaSince(mark);
check(
  'skill invocation shows in the transcript',
  delta.includes('/test-skill do Y'),
  JSON.stringify(delta.slice(-400)),
);
check(
  'skill body reaches the agent (expanded prompt)',
  delta.includes('EXPANDED-ANSWER-OK'),
  JSON.stringify(delta.slice(-400)),
);

// ── /skills lists what is installed ──
mark = snapshot().length;
await type('/skills');
await feed('\r', 400);
delta = deltaSince(mark);
check(
  '/skills lists installed skills',
  delta.includes('Installed skills') && delta.includes('/test-skill —'),
  JSON.stringify(delta.slice(-400)),
);

// ── /theme lists choices and switches the active theme ──
mark = snapshot().length;
await type('/theme');
await feed('\r', 300);
delta = deltaSince(mark);
check(
  'theme command lists all themes',
  delta.includes('catppuccin-mocha') && delta.includes('github-light'),
);
await type('/theme dracula');
await feed('\r', 300);
delta = deltaSince(mark);
check('theme command persists selected theme', selectedTheme === 'dracula', selectedTheme);
check('theme command confirms selected theme', delta.includes('Theme changed to dracula'));

// ── /model lists models and selects a numbered entry ──
mark = snapshot().length;
await type('/model');
await feed('\r', 300);
delta = deltaSince(mark);
check(
  'model command lists provider models',
  delta.includes('model-one') && delta.includes('model-two'),
);
await type('/model 2');
await feed('\r', 300);
delta = deltaSince(mark);
check('model command selects a listed model', selectedModel === 'model-two', selectedModel);
check('model command confirms selected model', delta.includes('model → model-two'));

unmount();
check(
  'mouse wheel reporting disabled on TUI exit',
  snapshot().includes('\u001b[?1006l\u001b[?1000l'),
);
await waitUntilExit();

if (failures > 0) process.exit(1);
console.log('TUI render check passed ✓');
process.exit(0);
