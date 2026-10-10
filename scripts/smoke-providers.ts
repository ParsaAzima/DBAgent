import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLLMConfig } from '../src/core/config.js';
import {
  loadCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
} from '../src/core/custom-providers.js';
import { createLLMAdapter, assertApiKeyPresent } from '../src/llm/factory.js';
import { listProviderModels } from '../src/llm/models.js';

const dir = mkdtempSync(join(tmpdir(), 'dbagent-providers-'));
const file = join(dir, 'providers.json');
const oldKey = process.env.SMOKE_CUSTOM_LLM_KEY;
const requests: { url: string; key?: string; version?: string }[] = [];
const server = createServer((req, res) => {
  requests.push({
    url: req.url ?? '',
    key: req.headers.authorization ?? req.headers['x-api-key'],
    version: req.headers['anthropic-version'],
  });
  res.setHeader('content-type', 'application/json');
  if (req.url?.startsWith('/api/tags')) {
    res.end(JSON.stringify({ models: [{ name: 'ollama-local' }] }));
  } else if (req.url?.startsWith('/v1beta/models')) {
    res.end(JSON.stringify({ models: [{ name: 'models/gemini-test' }] }));
  } else if (req.url?.startsWith('/v1/models?limit=100')) {
    res.end(JSON.stringify({ data: [{ id: 'claude-test' }] }));
  } else if (req.url === '/v1/models') {
    res.end(JSON.stringify({ data: [{ id: 'provider-model-a' }, { id: 'provider-model-b' }] }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  }
});

const checks: [string, () => Promise<void>][] = [];
checks.push([
  'save, load, and remove custom provider profiles',
  async () => {
    saveCustomProvider(
      {
        name: 'local-gateway',
        baseUrl: 'http://localhost:12345/v1',
        defaultModel: 'local-model',
        apiKeyEnv: 'SMOKE_CUSTOM_LLM_KEY',
      },
      file,
    );
    assert.deepEqual(loadCustomProviders(file)['local-gateway'], {
      name: 'local-gateway',
      baseUrl: 'http://localhost:12345/v1',
      defaultModel: 'local-model',
      apiKeyEnv: 'SMOKE_CUSTOM_LLM_KEY',
    });
    assert.doesNotMatch(readFileSync(file, 'utf8'), /test-secret/);
    assert.equal(removeCustomProvider('local-gateway', file), true);
    assert.equal(removeCustomProvider('local-gateway', file), false);
  },
]);
checks.push([
  'reject invalid profile values and embedded URL credentials',
  async () => {
    assert.throws(
      () =>
        saveCustomProvider(
          { name: 'bad/name', baseUrl: 'https://example.com/v1', defaultModel: 'm' },
          file,
        ),
      /Provider name/,
    );
    assert.throws(
      () =>
        saveCustomProvider(
          { name: 'gateway', baseUrl: 'https://user:secret@example.com/v1', defaultModel: 'm' },
          file,
        ),
      /without embedded credentials/,
    );
  },
]);

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
process.env.SMOKE_CUSTOM_LLM_KEY = 'test-secret';

checks.push([
  'resolve a saved custom provider and create its adapter',
  async () => {
    const definition = {
      'local-gateway': {
        name: 'local-gateway',
        baseUrl: `${baseUrl}/v1`,
        defaultModel: 'provider-model-a',
        apiKeyEnv: 'SMOKE_CUSTOM_LLM_KEY',
      },
    };
    const resolved = resolveLLMConfig({ providerFlag: 'local-gateway' }, definition);
    assert.equal(resolved.provider, 'custom');
    assert.equal(resolved.llm.providerName, 'local-gateway');
    assert.equal(resolved.llm.model, 'provider-model-a');
    assert.equal(resolved.llm.apiKey, 'test-secret');
    assert.equal(createLLMAdapter(resolved.llm).id, 'custom');
    assertApiKeyPresent(resolved.llm);
  },
]);
checks.push([
  'list models from a custom OpenAI-compatible provider',
  async () => {
    const models = await listProviderModels({
      id: 'custom',
      providerName: 'local-gateway',
      model: 'provider-model-a',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'test-secret',
    });
    assert.deepEqual(models, ['provider-model-a', 'provider-model-b']);
    assert.equal(requests.at(-1)?.url, '/v1/models');
    assert.equal(requests.at(-1)?.key, 'Bearer test-secret');
  },
]);
checks.push([
  'list Ollama models from its native API',
  async () => {
    const models = await listProviderModels({
      id: 'ollama',
      model: 'ollama-local',
      baseUrl,
    });
    assert.deepEqual(models, ['ollama-local']);
    assert.equal(requests.at(-1)?.url, '/api/tags');
  },
]);
checks.push([
  'list Anthropic models with required version and API key headers',
  async () => {
    const models = await listProviderModels({
      id: 'anthropic',
      model: 'claude-test',
      apiKey: 'anthropic-secret',
      baseUrl,
    });
    assert.deepEqual(models, ['claude-test']);
    assert.equal(requests.at(-1)?.key, 'anthropic-secret');
    assert.equal(requests.at(-1)?.version, '2023-06-01');
  },
]);
checks.push([
  'list Gemini models and strip API resource prefix',
  async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    let apiKeyHeader = '';
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      apiKeyHeader = new Headers(init?.headers).get('x-goog-api-key') ?? '';
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-test' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const models = await listProviderModels({
        id: 'gemini',
        model: 'gemini-test',
        apiKey: 'gemini-secret',
      });
      assert.deepEqual(models, ['gemini-test']);
      assert.equal(requestedUrl, 'https://generativelanguage.googleapis.com/v1beta/models');
      assert.equal(apiKeyHeader, 'gemini-secret');
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
]);

let passed = 0;
try {
  for (const [name, check] of checks) {
    await check();
    passed++;
    console.log(`  ✓ ${name}`);
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (oldKey === undefined) delete process.env.SMOKE_CUSTOM_LLM_KEY;
  else process.env.SMOKE_CUSTOM_LLM_KEY = oldKey;
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed}/${checks.length} provider checks passed`);
