import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolParamSpec, ToolSpec } from '../core/types.js';
import { loadMcpConfig, type McpServerConfig } from './config.js';

const MAX_TOOL_RESULT_LENGTH = 80_000;
const CONNECT_TIMEOUT_MS = 15_000;

export interface McpAgentTool {
  spec: ToolSpec;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ActiveClient {
  name: string;
  client: Client;
  tools: McpAgentTool[];
}

export class McpClientManager {
  private closePromise?: Promise<void>;

  private constructor(private readonly servers: ActiveClient[]) {}

  static async connect(configPath?: string, onlyServer?: string): Promise<McpClientManager> {
    const config = loadMcpConfig(configPath);
    if (onlyServer) {
      const definition = config.mcpServers[onlyServer];
      if (!definition) throw new Error(`MCP server "${onlyServer}" is not configured.`);
      config.mcpServers = { [onlyServer]: definition };
    }
    if (Object.keys(config.mcpServers).length === 0) {
      throw new Error('No MCP servers are configured. Add one to ~/.dbagent/mcp.json.');
    }
    const active: ActiveClient[] = [];
    try {
      for (const [name, definition] of Object.entries(config.mcpServers)) {
        const client = new Client({ name: 'dbagent', version: '0.2.0' }, { capabilities: {} });
        try {
          const transport = createTransport(definition);
          await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
          const { tools } = await client.listTools({}, { timeout: CONNECT_TIMEOUT_MS });
          active.push({
            name,
            client,
            tools: tools.map((tool) => ({
              spec: {
                name: namespacedToolName(name, tool.name),
                description: `[MCP server: ${name}] ${tool.description ?? tool.name}`,
                parameters: toToolParameters(tool.inputSchema),
              },
              invoke: async (args) => {
                const result = await client.callTool(
                  { name: tool.name, arguments: args },
                  CallToolResultSchema,
                  { timeout: 60_000 },
                );
                if (!isCallToolResult(result)) {
                  throw new Error(
                    `MCP tool "${tool.name}" returned a task result; task-based tools are not supported yet.`,
                  );
                }
                const output = serializeToolResult(result);
                if (result.isError) throw new Error(output);
                return output;
              },
            })),
          });
        } catch (err) {
          await client.close().catch(() => {});
          throw new Error(
            `Could not initialize MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return new McpClientManager(active);
    } catch (err) {
      await Promise.all(active.map(({ client }) => client.close().catch(() => {})));
      throw err;
    }
  }

  get tools(): McpAgentTool[] {
    return this.servers.flatMap((server) => server.tools);
  }

  get serverNames(): string[] {
    return this.servers.map((server) => server.name);
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeAll();
    return this.closePromise;
  }

  private async closeAll(): Promise<void> {
    const results = await Promise.allSettled(this.servers.map(({ client }) => client.close()));
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [errorMessage(result.reason)] : [],
    );
    if (errors.length > 0)
      throw new Error(`Failed to close MCP server connection(s): ${errors.join('; ')}`);
  }
}

function createTransport(definition: McpServerConfig) {
  if ('command' in definition) {
    return new StdioClientTransport({
      command: definition.command,
      args: definition.args,
      env: { ...getDefaultEnvironment(), ...definition.env },
      cwd: definition.cwd,
      stderr: 'inherit',
    });
  }
  return new StreamableHTTPClientTransport(new URL(definition.url), {
    requestInit: { headers: definition.headers },
    redirectPolicy: 'same-origin',
  });
}

function toToolParameters(schema: Record<string, unknown>): ToolParamSpec {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return {
    type: 'object',
    description:
      typeof schema.description === 'string' ? schema.description : 'MCP tool arguments.',
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, toToolProperty(property)]),
    ),
    required: Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function toToolProperty(value: unknown): ToolParamSpec {
  const schema = isRecord(value) ? value : {};
  const validTypes = new Set(['string', 'number', 'boolean', 'object', 'array']);
  const type =
    typeof schema.type === 'string' && validTypes.has(schema.type)
      ? (schema.type as ToolParamSpec['type'])
      : 'string';
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const enumeration = Array.isArray(schema.enum)
    ? schema.enum.filter(
        (entry): entry is string | number | boolean | null =>
          entry === null ||
          typeof entry === 'string' ||
          typeof entry === 'number' ||
          typeof entry === 'boolean',
      )
    : undefined;
  return {
    type,
    description: typeof schema.description === 'string' ? schema.description : '',
    ...(properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([name, property]) => [name, toToolProperty(property)]),
          ),
          required: Array.isArray(schema.required)
            ? schema.required.filter((entry): entry is string => typeof entry === 'string')
            : [],
        }
      : {}),
    ...(isRecord(schema.items) ? { items: toToolProperty(schema.items) } : {}),
    ...(enumeration ? { enum: enumeration } : {}),
  };
}

function namespacedToolName(server: string, tool: string): string {
  const base = `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (base.length <= 64) return base;
  const suffix = createHash('sha256').update(base).digest('hex').slice(0, 10);
  return `${base.slice(0, 53)}_${suffix}`;
}

function serializeToolResult(result: {
  content: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}): string {
  const content = result.content.map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (part.type === 'resource') return '[Embedded resource returned; omitted from tool output.]';
    if (part.type === 'image') return '[Image content returned; omitted from tool output.]';
    return `[Unsupported MCP content: ${String(part.type ?? 'unknown')}]`;
  });
  const serialized = JSON.stringify({
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    content,
    ...(result.isError ? { isError: true } : {}),
  });
  return serialized.length <= MAX_TOOL_RESULT_LENGTH
    ? serialized
    : `${serialized.slice(0, MAX_TOOL_RESULT_LENGTH)}… [truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCallToolResult(value: unknown): value is {
  content: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  return isRecord(value) && Array.isArray(value.content);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
