/**
 * End-to-end CLI test: spins up a mock OpenAI-compatible server, then runs
 * `dbagent ask` against it with the demo SQLite database. Exercises the real
 * wire format (POST /v1/chat/completions with tools) and the full pipeline:
 *   CLI → OpenAI adapter → agent loop → SQLite driver → answer
 *
 * NOTE: uses async spawn — spawnSync would block the event loop and starve
 * the in-process mock server.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PORT = 8971;
let sawTools = false;
/** Captured OpenRouter-specific request facts. */
const openrouterSeen = { path: false, auth: false, referer: false, title: false };

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.includes('/api/v1/chat/completions')) {
      openrouterSeen.path = true;
      openrouterSeen.auth = /^Bearer or-test/.test(req.headers.authorization ?? '');
      openrouterSeen.referer = typeof req.headers['http-referer'] === 'string';
      openrouterSeen.title = req.headers['x-title'] === 'DBAgent-Test';
    }
    if (!req.url.includes('/v1/chat/completions')) {
      res.writeHead(404, { connection: 'close' }).end();
      return;
    }
    const json = JSON.parse(body || '{}');
    if (Array.isArray(json.tools) && json.tools.length > 0) sawTools = true;

    // Stateless script: if the conversation already carries a tool result,
    // produce the final answer; otherwise request list_tables. This keeps
    // each CLI invocation independent.
    const lastMsg = (json.messages ?? []).at(-1);
    let message;
    if (lastMsg?.role === 'tool') {
      const payload = JSON.parse(lastMsg.content ?? '{}');
      const tables = payload?.result ?? [];
      message = {
        role: 'assistant',
        content: `E2E-OK: ${tables.length} tables; saw tools: ${sawTools}; first table: ${tables[0]?.name ?? '?'}`,
      };
    } else {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'list_tables', arguments: '{}' } },
        ],
      };
    }

    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const env = {
  ...process.env,
  OPENAI_API_KEY: 'test-key-123',
  OPENAI_BASE_URL: `http://127.0.0.1:${PORT}`,
};

/** Run a CLI command asynchronously with a hard timeout. */
function run(args, { timeoutMs = 45_000, envOverride = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], { env: { ...env, ...envOverride } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// ── ask (full LLM + tool pipeline over real HTTP) ───────────────────────────
const ask = await run([
  'ask',
  'How many tables are in the database?',
  '--db',
  'sqlite://./demo.db',
  '--provider',
  'openai',
]);
check(
  'e2e ask (HTTP → adapter → agent → sqlite)',
  ask.stdout.includes('E2E-OK: 4 tables') && ask.stdout.includes('saw tools: true') && ask.stdout.includes('first table: customers'),
  JSON.stringify({ code: ask.code, stdout: ask.stdout.slice(0, 300), stderr: ask.stderr.slice(0, 300) }),
);

// ── ask via OpenRouter preset (same mock, different URL/auth shape) ────────
const orAsk = await run(
  [
    'ask',
    'How many tables? (via openrouter)',
    '--db',
    'sqlite://./demo.db',
    '--provider',
    'openrouter',
    '--model',
    'anthropic/claude-sonnet-4',
  ],
  {
    envOverride: {
      OPENROUTER_API_KEY: 'or-test',
      OPENROUTER_BASE_URL: `http://127.0.0.1:${PORT}/api`,
      OPENROUTER_SITE_URL: 'https://test.example',
      OPENROUTER_APP_NAME: 'DBAgent-Test',
      OPENAI_API_KEY: '',
    },
  },
);
check(
  'e2e ask via OpenRouter preset',
  orAsk.stdout.includes('E2E-OK: 4 tables') &&
    openrouterSeen.path &&
    openrouterSeen.auth &&
    openrouterSeen.referer &&
    openrouterSeen.title,
  JSON.stringify({ code: orAsk.code, seen: openrouterSeen, stdout: orAsk.stdout.slice(0, 200), stderr: orAsk.stderr.slice(0, 200) }),
);

// ── health (DB only, no LLM) ────────────────────────────────────────────────
const health = await run(['health', '--db', 'sqlite://./demo.db']);
check('e2e health', health.code === 0 && health.stdout.includes('Tables/views: 4'), health.stderr.slice(0, 200));

// ── ask without API key → clean error ───────────────────────────────────────
const noKey = await run(['ask', 'x', '--db', 'sqlite://./demo.db', '--provider', 'openai'], {
  envOverride: { OPENAI_API_KEY: '' },
});
check(
  'missing API key fails fast with clear message',
  noKey.code === 1 && noKey.stderr.includes('API key'),
  JSON.stringify({ code: noKey.code, stderr: noKey.stderr.slice(0, 200) }),
);

server.close();
if (failures > 0) process.exit(1);
console.log('\nAll e2e checks passed ✓');
process.exit(0);
