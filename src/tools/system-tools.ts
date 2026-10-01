/**
 * System-level agent tools, gated behind --allow-system.
 *
 * Registered into the shared tool registry when the operator opts in. File
 * outputs go to ./dbagent-out/ under cwd by default so nothing lands outside
 * the working directory unless explicitly requested.
 */

import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { DatabaseDriver } from '../core/types.js';
import type { ToolHandler } from './index.js';
import {
  collectStats,
  collectSystemInfo,
  exportTable,
  importCsv,
  backup,
} from '../system/ops.js';
import { discoverLocalDatabases } from '../system/discover.js';

export const DEFAULT_OUT_DIR = 'dbagent-out';

async function outPath(name: string): Promise<string> {
  const dir = resolve(process.env.DBAGENT_OUT_DIR ?? DEFAULT_OUT_DIR);
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}

/** Resolve a user-supplied path against cwd and keep it off system dirs. */
function resolveUserPath(p: string): string {
  const abs = resolve(p);
  const cwd = process.cwd();
  if (!abs.startsWith(cwd) && !abs.startsWith(process.env.DBAGENT_OUT_DIR ?? '')) {
    // allow absolute paths only when explicitly outside-protection disabled
    if (process.env.DBAGENT_ANY_PATH !== '1') {
      throw new Error(
        `Path "${p}" is outside the working directory. Set DBAGENT_ANY_PATH=1 to allow arbitrary paths.`,
      );
    }
  }
  return abs;
}

export interface SystemToolDeps {
  db: DatabaseDriver;
  allowSystem: boolean;
  allowWrites: boolean;
}

/** Build handler closures capturing the driver and gate flags. */
export function createSystemToolRegistry(
  deps: SystemToolDeps,
): Map<string, ToolHandler> {
  const { db, allowSystem } = deps;
  const registry = new Map<string, ToolHandler>();

  const guard = (name: string): void => {
    if (!allowSystem) {
      throw new Error(
        `Tool "${name}" requires system mode. Restart with --allow-system or set DBAGENT_ALLOW_SYSTEM=1.`,
      );
    }
  };

  registry.set('db_stats', async () => {
    guard('db_stats');
    return collectStats(db);
  });

  registry.set('system_info', async () => {
    guard('system_info');
    return collectSystemInfo(db);
  });

  registry.set('export_data', async (args) => {
    guard('export_data');
    const table = String(args.table ?? '').trim();
    if (!table) throw new Error('export_data requires "table".');
    const format = args.format === 'json' ? 'json' : 'csv';
    const file = await outPath(
      `${table.replace(/[^\w.-]/g, '_')}.${format}`,
    );
    return exportTable(db, table, format, resolveUserPath(file));
  });

  registry.set('import_csv', async (args) => {
    guard('import_csv');
    if (!deps.allowWrites) {
      throw new Error('import_csv writes rows: requires --allow-writes.');
    }
    const file = String(args.file ?? '').trim();
    const table = String(args.table ?? '').trim();
    if (!file || !table) throw new Error('import_csv requires "file" and "table".');
    return importCsv(db, resolveUserPath(file), table, { createTable: !!args.createTable });
  });

  registry.set('backup', async (args) => {
    guard('backup');
    const requested = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = await outPath(
      requested ?? `backup-${db.dialect}-${stamp}.sql`,
    );
    return backup(db, resolveUserPath(file));
  });

  registry.set('discover_local_databases', async () => {
    guard('discover_local_databases');
    return discoverLocalDatabases();
  });

  return registry;
}
