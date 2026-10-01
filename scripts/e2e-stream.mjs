/**
 * e2e test for the streaming pipeline: mock OpenAI-compatible SSE server →
 * agent.runTurnStream → collected events. Verifies:
 *   1. text deltas arrive incrementally (multiple chunks, in order)
 *   2. streamed tool_call is executed by the agent loop
 *   3. turn completes with the aggregated final text
 */

import { createServer } from 'node:http';
import { Agent } from '../dist/core/agent.js';
import { createDatabaseDriver } from '../dist/db/factory.js';
import { createLLMAdapter } from '../dist/llm/factory.js';

const PORT = 8975;
const events = [];
let sawStreamFlag = false;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    sawStreamFlag = json.stream === true;
    const lastMsg = (json.messages ?? []).at(-1);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (lastMsg?.role === 'tool') {
      // Final answer arrives as several text deltas.
      for (const t of ['Found ', '4 tables', ' — done.']) {
        send({ choices: [{ delta: { content: t } }] });
      }
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      send({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Tool call streamed in fragments (name + arguments split).
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'list_', arguments: '' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'tables', arguments: '{}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 10 });
const llm = createLLMAdapter({
  id: 'openai',
  model: 'stream-test',
  apiKey: 'k',
  baseUrl: `http://127.0.0.1:${PORT}`,
});
const agent = new Agent(llm, db, { id: 'openai', model: 'stream-test' });

const result = await agent.runTurnStream('how many tables?', {
  onEvent: (ev) => events.push(ev),
});

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
};

const deltas = events.filter((e) => e.kind === 'text_delta');
const toolStarts = events.filter((e) => e.kind === 'tool_start');
const toolDones = events.filter((e) => e.kind === 'tool_done');
const turnDone = events.find((e) => e.kind === 'turn_done');

check('stream flag sent in request body', sawStreamFlag);
check('3 incremental text deltas received', deltas.length === 3, `got ${deltas.length}`);
check('deltas in order → full text', result.text === 'Found 4 tables — done.', JSON.stringify(result.text));
check('streamed tool_call reassembled (name split across chunks)', toolStarts[0]?.name === 'list_tables', toolStarts[0]?.name);
check('tool executed once', toolDones.length === 1 && toolDones[0].ok === true);
check('turn_done emitted with rounds=2', turnDone?.rounds === 2);

await db.close();
server.close();
if (failures > 0) process.exit(1);
console.log('\nAll streaming e2e checks passed ✓');
// brief delay: Windows libuv races server teardown at immediate exit
setTimeout(() => process.exit(0), 150);
