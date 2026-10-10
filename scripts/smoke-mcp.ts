import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClientManager } from '../src/mcp/client.js';
import { loadMcpConfig } from '../src/mcp/config.js';

const dir = mkdtempSync(join(tmpdir(), 'dbagent-mcp-'));
const configFile = join(dir, 'mcp.json');
const serverScript = join(process.cwd(), 'scripts', 'mcp-test-server.mjs');
const previous = process.env.MCP_SMOKE_SECRET;
let passed = 0;
const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

try {
  process.env.MCP_SMOKE_SECRET = 'resolved-secret';
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        'local-test': {
          command: process.execPath,
          args: [serverScript],
          env: { TEST_SECRET: '${MCP_SMOKE_SECRET}' },
        },
      },
    }),
  );

  await check('config loads stdio servers and resolves environment placeholders', async () => {
    const config = loadMcpConfig(configFile);
    assert.equal('command' in config.mcpServers['local-test'], true);
    if ('command' in config.mcpServers['local-test']) {
      assert.equal(config.mcpServers['local-test'].env?.TEST_SECRET, 'resolved-secret');
    }
  });

  await check(
    'config accepts Streamable HTTP and rejects URL credentials or query data',
    async () => {
      writeFileSync(
        configFile,
        JSON.stringify({
          mcpServers: {
            remote: {
              url: 'https://mcp.example.test/mcp',
              headers: { Authorization: 'Bearer ${MCP_SMOKE_SECRET}' },
            },
          },
        }),
      );
      const remote = loadMcpConfig(configFile).mcpServers.remote;
      assert.ok(remote && 'url' in remote);
      assert.equal(remote.url, 'https://mcp.example.test/mcp');
      assert.equal(remote.headers?.Authorization, 'Bearer resolved-secret');

      for (const url of [
        'https://user:password@mcp.example.test/mcp',
        'https://mcp.example.test/mcp?token=secret',
        'https://mcp.example.test/mcp#fragment',
      ]) {
        writeFileSync(configFile, JSON.stringify({ mcpServers: { remote: { url } } }));
        assert.throws(
          () => loadMcpConfig(configFile),
          /without embedded credentials, query, or fragment/,
        );
      }
      writeFileSync(
        configFile,
        JSON.stringify({
          mcpServers: {
            'local-test': {
              command: process.execPath,
              args: [serverScript],
              env: { TEST_SECRET: '${MCP_SMOKE_SECRET}' },
            },
          },
        }),
      );
    },
  );

  await check('client connects, exposes schemas, invokes tools, and closes cleanly', async () => {
    const manager = await McpClientManager.connect(configFile);
    try {
      assert.deepEqual(manager.serverNames, ['local-test']);
      assert.equal(manager.tools.length, 2);
      const echo = manager.tools.find((tool) => tool.spec.name === 'mcp_local-test_echo');
      assert.ok(echo);
      assert.equal(echo.spec.parameters.properties?.message.type, 'string');
      assert.equal(echo.spec.parameters.properties?.labels.items?.type, 'string');
      const result = await echo.invoke({ message: 'hello', labels: ['one', 'two'] });
      assert.equal(
        result,
        JSON.stringify({ content: ['{"message":"hello","labels":["one","two"]}'] }),
      );
      await manager.close();
    } finally {
      await manager.close();
    }
  });

  await check('MCP server tool errors are surfaced to the caller', async () => {
    const manager = await McpClientManager.connect(configFile);
    try {
      const fail = manager.tools.find((tool) => tool.spec.name === 'mcp_local-test_fail');
      assert.ok(fail);
      await assert.rejects(fail.invoke({}), /expected test error/);
    } finally {
      await manager.close();
    }
  });

  await check('invalid server configuration fails with a useful message', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({ mcpServers: { bad: { command: 'node', env: [] } } }),
    );
    assert.throws(() => loadMcpConfig(configFile), /Invalid stdio settings/);
  });

  console.log(`\n${passed}/5 MCP checks passed`);
} finally {
  if (previous === undefined) delete process.env.MCP_SMOKE_SECRET;
  else process.env.MCP_SMOKE_SECRET = previous;
  rmSync(dir, { recursive: true, force: true });
}
