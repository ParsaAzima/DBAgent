/**
 * Markdown renderer check: every token type renders without raw syntax leaking.
 * Run: npx tsx scripts/markdown-render-check.tsx
 */

import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import Markdown from '../src/tui/markdown.js';

const SAMPLE = [
  '## Summary',
  '',
  'Revenue **grew** in `Q3` with _strong_ momentum and ~~some noise~~.',
  '',
  '- top customers by spend',
  '  - ali (iran branch)',
  '  - emma',
  '- order counts',
  '1. first item',
  '2. second item',
  '',
  'See [OpenRouter docs](https://openrouter.ai/docs) for pricing.',
  '',
  '```sql',
  'SELECT name, total FROM orders LIMIT 3;',
  '```',
  '',
  '| name  | total |',
  '|-------|-------|',
  '| ali   | 124   |',
  '| emma  | 135   |',
  '',
  '> quoted note',
  '',
  '---',
  '',
  'Plain paragraph at the end.',
].join('\n');

const frames: string[] = [];
const stdout = new PassThrough();
stdout.on('data', (c: Buffer) => frames.push(c.toString()));

const stdin = new PassThrough() as any;
stdin.isTTY = true;
stdin.setRawMode = () => stdin;

const { unmount, waitUntilExit } = render(<Markdown>{SAMPLE}</Markdown>, {
  stdout: stdout as any,
  stdin,
  exitOnCtrlC: false,
});

await new Promise((r) => setTimeout(r, 250));
unmount();
await waitUntilExit();

const out = frames.join('');
let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ok ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
};

check('heading bold no raw #', !out.includes('## Summary') && out.includes('Summary'));
check('bold applied no raw **', !out.includes('**grew**') && out.includes('grew'));
check('inline code no backticks', !out.includes('`Q3`') && out.includes('Q3'));
check('strike applied', !out.includes('~~some noise~~') && out.includes('some noise'));
check('nested list rendered', out.includes('ali (iran branch)') && out.includes('top customers'));
check('ordered list numbers', out.includes('1. first item'));
check('link rendered with url', out.includes('OpenRouter docs') && out.includes('https://openrouter.ai/docs'));
check('code block drawn', out.includes('SELECT name, total') && out.includes('│'));
check('table box drawn', out.includes('┌') && /│\s*ali/.test(out) && out.includes('│ 124'));
check('no raw table pipes header', !out.includes('| name  | total |'));
check('blockquote rendered', out.includes('▏') && out.includes('quoted note'));
check('hr rendered', out.includes('──'));
check('no emoji in output', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(out));

if (failures > 0) process.exit(1);
console.log('Markdown render check passed');
process.exit(0);
