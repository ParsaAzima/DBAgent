/**
 * Smoke test: runs the full agent loop with a scripted (fake) LLM adapter
 * against the demo SQLite database. No API key or network needed.
 *
 * Verifies:
 *  1. Tool-call round-trip (list_tables → result fed back → final answer)
 *  2. Read query execution with LIMIT enforcement
 *  3. Write blocking in read-only mode
 *  4. Unknown-tool error surfacing
 */

import { Agent } from '../dist/core/agent.js';
import { createDatabaseDriver } from '../dist/db/factory.js';
import { buildSystemPrompt } from '../dist/core/prompt.js';

const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 50 });

/** Scripted responses per round. */
function makeScriptedLLM(script) {
  let round = 0;
  return {
    id: 'openai',
    model: 'scripted-test',
    async complete(messages, tools, system) {
      const step = script[round++];
      if (!step) throw new Error(`Unexpected extra LLM round ${round}`);
      // sanity: system prompt must mention the dialect
      if (!system.includes('SQLITE')) throw new Error('System prompt missing dialect');
      return step(messages);
    },
  };
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// ── 1. list_tables round-trip → final answer ────────────────────────────────
{
  const llm = makeScriptedLLM([
    () => ({ toolCalls: [{ id: 'c1', name: 'list_tables', args: {} }] }),
    (messages) => {
      const toolMsg = messages[messages.length - 1];
      const tables = toolMsg?.toolResult?.result;
      return {
        text: `Found ${tables.length} tables: ${tables.map((t) => t.name).join(', ')}`,
      };
    },
  ]);
  const agent = new Agent(llm, db, { id: 'openai', model: 'scripted-test' });
  const res = await agent.runTurn('What tables exist?');
  check('tool round-trip returns answer', res.text.includes('Found 4 tables'));
  check('rounds == 2', res.rounds === 2, `got ${res.rounds}`);
}

// ── 2. SELECT gets LIMIT appended ───────────────────────────────────────────
{
  const llm = makeScriptedLLM([
    () => ({ toolCalls: [{ id: 'c1', name: 'query', args: { sql: 'SELECT name FROM customers' } }] }),
    (messages) => {
      const toolMsg = messages[messages.length - 1];
      const result = toolMsg?.toolResult?.result;
      return { text: `rows=${result.rowCount}` };
    },
  ]);
  const agent = new Agent(llm, db, { id: 'openai', model: 'scripted-test' });
  const res = await agent.runTurn('List customer names');
  check('query without LIMIT still returns rows (guard added LIMIT)', res.text.includes('rows=5'));
}

// ── 3. Write blocked in read-only mode ──────────────────────────────────────
{
  const llm = makeScriptedLLM([
    () => ({ toolCalls: [{ id: 'c1', name: 'execute', args: { sql: "DELETE FROM orders" } }] }),
    (messages) => {
      const toolMsg = messages[messages.length - 1];
      const failed = toolMsg?.toolResult?.ok === false;
      const msg = String(toolMsg?.toolResult?.error ?? '');
      return { text: failed ? `BLOCKED: ${msg.slice(0, 60)}` : 'NOT BLOCKED!' };
    },
  ]);
  const agent = new Agent(llm, db, { id: 'openai', model: 'scripted-test' });
  const res = await agent.runTurn('Delete all orders');
  check('write blocked in read-only mode', res.text.startsWith('BLOCKED:'), res.text);
}

// ── 4. Unknown tool is surfaced as tool error, not crash ────────────────────
{
  const llm = makeScriptedLLM([
    () => ({ toolCalls: [{ id: 'c1', name: 'drop_database', args: {} }] }),
    (messages) => {
      const toolMsg = messages[messages.length - 1];
      const failed = toolMsg?.toolResult?.ok === false;
      return { text: failed ? 'HANDLED' : 'CRASHED' };
    },
  ]);
  const agent = new Agent(llm, db, { id: 'openai', model: 'scripted-test' });
  const res = await agent.runTurn('drop everything');
  check('unknown tool handled gracefully', res.text === 'HANDLED');
}

// ── 5. Guard unit checks ────────────────────────────────────────────────────
{
  const { enforceLimit, singleStatement, classifyStatement } = await import('../dist/db/guard.js');
  const withLimit = enforceLimit('SELECT * FROM t', 10, 'sqlite');
  check('LIMIT appended to SELECT', /LIMIT 10\s*$/i.test(withLimit), withLimit);
  const wrapped = enforceLimit('WITH x AS (SELECT 1 AS a) SELECT a FROM x', 5, 'sqlite');
  check('CTE wrapped with LIMIT', wrapped.startsWith('SELECT * FROM (') && /LIMIT 5\s*$/i.test(wrapped), wrapped);
  check('existing LIMIT untouched', enforceLimit('SELECT * FROM t LIMIT 3', 10, 'sqlite') === 'SELECT * FROM t LIMIT 3');
  let threw = false;
  try {
    singleStatement('SELECT 1; DROP TABLE t', 1);
  } catch {
    threw = true;
  }
  check('chained statements rejected', threw);
  check('classify DELETE as write', classifyStatement('DELETE FROM t') === 'write');
  check('classify DROP as ddl', classifyStatement('DROP TABLE t') === 'ddl');
}

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll smoke checks passed ✓');
