/**
 * Local database discovery — helps the agent (and the CLI) connect to the
 * databases that already exist on this machine.
 *
 *  • running servers  : PostgreSQL 5432, MySQL 3306 (TCP probe)
 *  • sqlite files     : *.db / *.sqlite / *.sqlite3 under cwd (shallow scan)
 *  • client tools     : psql, pg_dump, mysqldump availability (for backup)
 */

import { createConnection } from 'node:net';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface DiscoveredServer {
  kind: 'postgres' | 'mysql';
  host: string;
  port: number;
  /** Whether the matching native client tools were found in PATH. */
  hasDumpTool: boolean;
}

export interface DiscoveredFile {
  path: string;
  sizeBytes: number;
}

export interface Discovery {
  servers: DiscoveredServer[];
  sqliteFiles: DiscoveredFile[];
  tools: { psql: boolean; pg_dump: boolean; mysqldump: boolean; sqlite3: boolean };
  scannedDirs: string[];
}

function probePort(host: string, port: number, timeoutMs = 350): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function hasTool(name: string): boolean {
  const r = spawnSync(name, ['--version'], { shell: process.platform === 'win32', timeout: 4000 });
  return !r.error;
}

export async function discoverLocalDatabases(opts: {
  extraDirs?: string[];
  maxFileDepth?: number;
} = {}): Promise<Discovery> {
  const [pgUp, mysqlUp] = await Promise.all([
    probePort('127.0.0.1', 5432),
    probePort('127.0.0.1', 3306),
  ]);

  const servers: DiscoveredServer[] = [];
  if (pgUp)
    servers.push({ kind: 'postgres', host: '127.0.0.1', port: 5432, hasDumpTool: hasTool('pg_dump') });
  if (mysqlUp)
    servers.push({ kind: 'mysql', host: '127.0.0.1', port: 3306, hasDumpTool: hasTool('mysqldump') });

  // shallow scan for sqlite files
  const dirs = [process.cwd(), ...(opts.extraDirs ?? [])];
  const sqliteFiles: DiscoveredFile[] = [];
  const scanned: string[] = [];
  const SQLITE_EXT = /\.(db|sqlite|sqlite3)$/i;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    scanned.push(dir);
    try {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        try {
          if (!statSync(p).isFile()) continue;
        } catch {
          continue;
        }
        if (SQLITE_EXT.test(entry)) {
          sqliteFiles.push({ path: p, sizeBytes: statSync(p).size });
        }
      }
    } catch {
      /* unreadable dir */
    }
  }

  return {
    servers,
    sqliteFiles,
    tools: {
      psql: hasTool('psql'),
      pg_dump: hasTool('pg_dump'),
      mysqldump: hasTool('mysqldump'),
      sqlite3: hasTool('sqlite3'),
    },
    scannedDirs: scanned,
  };
}
