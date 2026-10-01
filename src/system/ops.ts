/**
 * System operations on databases — gated behind --allow-system.
 *
 *   stats       : table sizes, row estimates, index count, DB size on disk
 *   system_info : version, uptime, connections, settings snapshot
 *   export      : dump a table/result to CSV or JSON file
 *   import      : load a CSV file into a table (uses write path)
 *   backup      : dialect-native backup (VACUUM INTO / pg_dump / mysqldump)
 *
 * File paths are resolved by the caller (CLI) and always stay under the
 * working directory unless an absolute path is given by the operator.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseDriver, DatabaseDialect } from '../core/types.js';
import type { QueryResult } from '../core/types.js';

/* ─────────────────── stats ─────────────────── */

export interface TableStat {
  table: string;
  kind: string;
  rowCountEstimate: number;
  sizeBytes?: number;
  indexCount?: number;
}

export interface DbStats {
  dialect: DatabaseDialect;
  target: string;
  totalSizeBytes?: number;
  tables: TableStat[];
  generatedAt: string;
}

export async function collectStats(db: DatabaseDriver): Promise<DbStats> {
  const tables = await db.listTables();
  const stats: TableStat[] = tables.map((t) => ({
    table: t.schema ? `${t.schema}.${t.name}` : t.name,
    kind: t.kind,
    rowCountEstimate: t.rowCountEstimate ?? 0,
  }));

  let totalSizeBytes: number | undefined;
  try {
    if (db.dialect === 'postgres') {
      const pool = (db as any).pool;
      const { rows } = await pool.query(
        `SELECT pg_database_size(current_database()) AS size`,
      );
      totalSizeBytes = Number(rows[0]?.size ?? 0);
      const perTable = await pool.query(
        `SELECT c.relname AS name, pg_total_relation_size(c.oid) AS size,
                (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS indexes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
      );
      for (const s of stats) {
        const row = perTable.rows.find((r: any) => r.name === s.table.split('.').pop());
        if (row) {
          s.sizeBytes = Number(row.size);
          s.indexCount = Number(row.indexes);
        }
      }
    } else if (db.dialect === 'sqlite') {
      const internal = db as any;
      const file = internal.file;
      if (file && existsSync(file)) totalSizeBytes = statSync(file).size;
      for (const s of stats) {
        try {
          const res = await db.execute(
            `SELECT COUNT(*) AS c FROM "${s.table.replace(/"/g, '""')}"`,
          );
          s.rowCountEstimate = Number(res.rows[0]?.[0] ?? s.rowCountEstimate);
        } catch {
          /* views etc. */
        }
      }
    } else if (db.dialect === 'mysql') {
      const conn = await (db as any).ensureConnection();
      const [rows] = await conn.query(
        `SELECT table_name, data_length + index_length AS size, table_rows
         FROM information_schema.tables WHERE table_schema = DATABASE()`,
      );
      totalSizeBytes = rows.reduce((a: number, r: any) => a + Number(r.size ?? 0), 0);
      for (const s of stats) {
        const row = (rows as any[]).find((r) => r.table_name === s.table);
        if (row) {
          s.sizeBytes = Number(row.size ?? 0);
          s.rowCountEstimate = Number(row.table_rows ?? s.rowCountEstimate);
        }
      }
    }
  } catch {
    /* stats are best-effort */
  }

  return {
    dialect: db.dialect,
    target: db.describeTarget(),
    totalSizeBytes,
    tables: stats,
    generatedAt: new Date().toISOString(),
  };
}

/* ─────────────────── system info ─────────────────── */

export interface SystemInfo {
  dialect: DatabaseDialect;
  version?: string;
  uptimeSeconds?: number;
  activeConnections?: number;
  settings: Record<string, string>;
  extra: Record<string, string>;
}

export async function collectSystemInfo(db: DatabaseDriver): Promise<SystemInfo> {
  const info: SystemInfo = { dialect: db.dialect, settings: {}, extra: {} };

  if (db.dialect === 'postgres') {
    const pool = (db as any).pool;
    const v = await pool.query('SELECT version() AS v');
    info.version = String(v.rows[0]?.v ?? '').split(' ').slice(0, 2).join(' ');
    const up = await pool.query(
      'SELECT pg_postmaster_start_time() AS start, (SELECT count(*) FROM pg_stat_activity) AS conns',
    );
    info.uptimeSeconds = Math.floor(
      (Date.now() - new Date(up.rows[0]?.start).getTime()) / 1000,
    );
    info.activeConnections = Number(up.rows[0]?.conns ?? 0);
    const s = await pool.query(
      `SELECT name, setting FROM pg_settings
       WHERE name IN ('max_connections','shared_buffers','work_mem','effective_cache_size','data_directory')`,
    );
    for (const r of s.rows) info.settings[r.name] = r.setting;
  } else if (db.dialect === 'sqlite') {
    const pragma = (sql: string) => db.execute(sql);
    info.version = String((await pragma('SELECT sqlite_version() AS v')).rows[0]?.[0]);
    info.settings['page_size'] = String((await pragma('PRAGMA page_size')).rows[0]?.[0]);
    info.settings['journal_mode'] = String((await pragma('PRAGMA journal_mode')).rows[0]?.[0]);
    info.settings['cache_size'] = String((await pragma('PRAGMA cache_size')).rows[0]?.[0]);
  } else if (db.dialect === 'mysql') {
    const conn = await (db as any).ensureConnection();
    const [v] = await conn.query('SELECT VERSION() AS v');
    info.version = String(v[0]?.v ?? '');
    const [st] = await conn.query(
      `SELECT variable_name, variable_value FROM performance_schema.global_variables
       WHERE variable_name IN ('max_connections','innodb_buffer_pool_size','datadir')`,
    );
    for (const r of st as any[]) info.settings[r.variable_name] = String(r.variable_value);
    const [up] = await conn.query('SHOW GLOBAL STATUS LIKE "Uptime"');
    info.uptimeSeconds = Number((up as any[])[0]?.Value ?? 0);
  }

  return info;
}

/* ─────────────────── export ─────────────────── */

export function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null]))),
    null,
    2,
  );
}

export async function exportTable(
  db: DatabaseDriver,
  table: string,
  format: 'csv' | 'json',
  outPath: string,
): Promise<{ file: string; rows: number; bytes: number }> {
  const q = db.dialect === 'mysql' ? '`' : '"';
  const res = await db.execute(`SELECT * FROM ${q}${table.replace(new RegExp(q, 'g'), q + q)}${q}`);
  const content = format === 'csv' ? toCsv(res.columns, res.rows) : toJson(res.columns, res.rows);
  await writeFile(outPath, content, 'utf8');
  return { file: outPath, rows: res.rows.length, bytes: Buffer.byteLength(content) };
}

/* ─────────────────── import ─────────────────── */

/** Parse CSV with quotes support. Minimal RFC-4180 subset. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      cur.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(field);
      field = '';
      if (cur.length > 1 || cur[0] !== '') rows.push(cur);
      cur = [];
    } else field += ch;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  const headers = rows.shift() ?? [];
  return { headers, rows };
}

export async function importCsv(
  db: DatabaseDriver,
  csvPath: string,
  table: string,
  opts: { batchRows?: number; createTable?: boolean } = {},
): Promise<{ inserted: number; table: string }> {
  const text = await readFile(csvPath, 'utf8');
  const { headers, rows } = parseCsv(text);
  if (headers.length === 0 || rows.length === 0) {
    throw new Error('CSV is empty or malformed.');
  }

  // Optionally create the table from header types (all TEXT unless numeric).
  if (opts.createTable) {
    const q = db.dialect === 'mysql' ? '`' : '"';
    const colDefs = headers
      .map((h) => `${q}${h.replace(new RegExp(q, 'g'), q + q)}${q} TEXT`)
      .join(', ');
    await db.execute(`CREATE TABLE ${q}${table}${q} (${colDefs})`);
  }

  const q = db.dialect === 'mysql' ? '`' : '"';
  const cols = headers.map((h) => `${q}${h.replace(new RegExp(q, 'g'), q + q)}${q}`).join(', ');
  const placeholders =
    db.dialect === 'postgres'
      ? headers.map((_, i) => `$${i + 1}`).join(', ')
      : headers.map(() => '?').join(', ');
  const sql = `INSERT INTO ${q}${table}${q} (${cols}) VALUES (${placeholders})`;

  // Batch inserts through the driver's execute() — one statement per call.
  let inserted = 0;
  for (const row of rows) {
    // sqlite (node:sqlite) and mysql accept ?; pg accepts $n — normalize below.
    if (db.dialect === 'postgres') {
      await (db as any).pool.query(sql, row);
    } else if (db.dialect === 'mysql') {
      const conn = await (db as any).ensureConnection();
      await conn.execute(sql, row);
    } else {
      (db as any).db.prepare(sql).run(...row);
    }
    inserted++;
  }
  return { inserted, table };
}

/* ─────────────────── backup ─────────────────── */

export interface BackupResult {
  file: string;
  bytes: number;
  method: string;
}

export async function backup(
  db: DatabaseDriver,
  outPath: string,
): Promise<BackupResult> {
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });

  if (db.dialect === 'sqlite') {
    // Use VACUUM INTO for a consistent snapshot.
    await db.execute(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
    return { file: outPath, bytes: statSync(outPath).size, method: 'VACUUM INTO' };
  }

  if (db.dialect === 'postgres') {
    return runDumpTool('pg_dump', [], db, outPath, 'pg_dump');
  }
  return runDumpTool('mysqldump', [], db, outPath, 'mysqldump');
}

/** Spawn a native dump CLI, streaming stdout to the output file. */
function runDumpTool(
  tool: string,
  extraArgs: string[],
  db: DatabaseDriver,
  outPath: string,
  method: string,
): Promise<BackupResult> {
  const anyDb = db as any;
  const args = [...extraArgs];
  let spec = '';
  if (db.dialect === 'postgres') {
    const pool = anyDb.pool;
    const cfg = pool.options ?? {};
    args.push('-h', cfg.host ?? 'localhost');
    if (cfg.port) args.push('-p', String(cfg.port));
    if (cfg.user) args.push('-U', cfg.user);
    args.push('-d', cfg.database ?? '');
    if (cfg.password) process.env.PGPASSWORD = cfg.password;
    spec = 'pg';
  } else {
    const conn = anyDb.conn;
    // mysql2 keeps config private; rebuild from the stored spec.
    const cfg = anyDb.connSpec ?? {};
    args.push('-h', cfg.host ?? 'localhost');
    if (cfg.port) args.push('-P', String(cfg.port));
    if (cfg.user) args.push('-u', cfg.user ?? 'root');
    if (cfg.password) args.push(`-p${cfg.password}`);
    args.push(cfg.database ?? '');
    spec = 'mysql';
  }
  args.push(...['--file', outPath]);
  if (tool === 'mysqldump') args.splice(args.indexOf('--file'), 2); // mysqldump writes to stdout

  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { shell: process.platform === 'win32' });
    let stderr = '';
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) =>
      reject(new Error(`${tool} not found in PATH — install the ${spec} client tools. ${err.message}`)),
    );
    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`${tool} exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      if (tool === 'mysqldump') {
        await writeFile(outPath, Buffer.concat(chunks));
      }
      resolve({ file: outPath, bytes: statSync(outPath).size, method });
    });
  });
}
