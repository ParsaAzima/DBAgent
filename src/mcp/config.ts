import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface McpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const DEFAULT_CONFIG = join(homedir(), '.dbagent', 'mcp.json');
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function loadMcpConfig(path = process.env.DBAGENT_MCP_CONFIG ?? DEFAULT_CONFIG): McpConfig {
  if (!existsSync(path)) return { mcpServers: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read MCP config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error(`Invalid MCP config at ${path}: expected an object with an "mcpServers" map.`);
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid MCP server name "${name}" in ${path}.`);
    if (!isRecord(raw)) throw new Error(`Invalid MCP server "${name}" in ${path}.`);

    if (typeof raw.command === 'string' && raw.command.trim()) {
      if (raw.url !== undefined) {
        throw new Error(`MCP server "${name}" cannot set both "command" and "url".`);
      }
      if (
        (raw.args !== undefined &&
          (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === 'string'))) ||
        (raw.env !== undefined && (!isRecord(raw.env) || !isStringMap(raw.env))) ||
        (raw.cwd !== undefined && typeof raw.cwd !== 'string')
      ) {
        throw new Error(`Invalid stdio settings for MCP server "${name}" in ${path}.`);
      }
      mcpServers[name] = {
        command: raw.command,
        ...(raw.args ? { args: resolveStrings(raw.args, name) } : {}),
        ...(raw.env ? { env: resolveStringMap(raw.env, name) } : {}),
        ...(raw.cwd ? { cwd: resolve(raw.cwd) } : {}),
      };
      continue;
    }

    if (typeof raw.url === 'string') {
      let url: URL;
      try {
        url = new URL(raw.url);
      } catch {
        throw new Error(`MCP HTTP server "${name}" must use an absolute HTTP(S) URL.`);
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          `MCP HTTP server "${name}" must use HTTP(S) without embedded credentials, query, or fragment; use headers for authentication.`,
        );
      }
      if (raw.headers !== undefined && (!isRecord(raw.headers) || !isStringMap(raw.headers))) {
        throw new Error(`MCP HTTP server "${name}" headers must be a string map.`);
      }
      mcpServers[name] = {
        url: resolveString(raw.url, name),
        ...(raw.headers ? { headers: resolveStringMap(raw.headers, name) } : {}),
      };
      continue;
    }

    throw new Error(`MCP server "${name}" must specify either "command" or "url".`);
  }
  return { mcpServers };
}

function resolveStrings(values: string[], server: string): string[] {
  return values.map((value) => resolveString(value, server));
}

function resolveStringMap(values: Record<string, string>, server: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolveString(value, server)]),
  );
}

function resolveString(value: string, server: string): string {
  return value.replace(ENV_REFERENCE, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`MCP server "${server}" requires environment variable ${name}.`);
    }
    return resolved;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: Record<string, unknown>): value is Record<string, string> {
  return Object.values(value).every((entry) => typeof entry === 'string');
}
