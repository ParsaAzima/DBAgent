import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DatabaseConnections {
  version: 1;
  default?: string;
  connections: Record<string, string>;
}

export function connectionsFilePath(): string {
  return join(homedir(), '.dbagent', 'connections.json');
}

export function loadConnections(path = connectionsFilePath()): DatabaseConnections {
  if (!existsSync(path)) return { version: 1, connections: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read saved database connections at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== 1 ||
    typeof (parsed as Record<string, unknown>).connections !== 'object' ||
    (parsed as Record<string, unknown>).connections === null ||
    Array.isArray((parsed as Record<string, unknown>).connections)
  ) {
    throw new Error(`Invalid saved database connections file: ${path}`);
  }

  const record = parsed as Record<string, unknown>;
  const connections = record.connections as Record<string, unknown>;
  for (const [name, url] of Object.entries(connections)) {
    validateConnectionName(name);
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error(`Invalid URL for saved database connection "${name}" in ${path}`);
    }
  }
  if (record.default !== undefined) {
    if (typeof record.default !== 'string' || !Object.hasOwn(connections, record.default)) {
      throw new Error(`Default database connection is missing from ${path}`);
    }
  }

  return {
    version: 1,
    connections: connections as Record<string, string>,
    ...(record.default === undefined ? {} : { default: record.default }),
  };
}

export function saveConnection(
  name: string,
  url: string,
  makeDefault = false,
  path = connectionsFilePath(),
): void {
  validateConnectionName(name);
  if (!url.trim()) throw new Error('Database URL cannot be empty.');
  const config = loadConnections(path);
  config.connections[name] = url.trim();
  if (makeDefault) config.default = name;
  writeConnections(config, path);
}

export function setDefaultConnection(name: string, path = connectionsFilePath()): void {
  validateConnectionName(name);
  const config = loadConnections(path);
  if (!Object.hasOwn(config.connections, name)) {
    throw new Error(`Saved database connection not found: ${name}`);
  }
  config.default = name;
  writeConnections(config, path);
}

export function removeConnection(name: string, path = connectionsFilePath()): boolean {
  validateConnectionName(name);
  const config = loadConnections(path);
  if (!Object.hasOwn(config.connections, name)) return false;
  delete config.connections[name];
  if (config.default === name) delete config.default;
  writeConnections(config, path);
  return true;
}

/** Resolve a saved alias; non-alias values remain valid database URLs. */
export function resolveConnectionUrl(value: string, path = connectionsFilePath()): string {
  const config = loadConnections(path);
  return Object.hasOwn(config.connections, value) ? config.connections[value] : value;
}

/** Use an explicit selection first, then a real environment variable, then the saved default. */
export function selectedConnectionUrl(
  dbFlag: string | undefined,
  envDbUrl: string | undefined,
  path = connectionsFilePath(),
): string | undefined {
  if (dbFlag !== undefined) return resolveConnectionUrl(dbFlag, path);
  if (envDbUrl) return envDbUrl;
  const config = loadConnections(path);
  return config.default ? config.connections[config.default] : undefined;
}

export function validateConnectionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error(
      'Connection name must start with a letter or number and contain only letters, numbers, ".", "_" or "-".',
    );
  }
}

function writeConnections(config: DatabaseConnections, path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (err) {
    throw new Error(
      `Cannot save database connections to ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
