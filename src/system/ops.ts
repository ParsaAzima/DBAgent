/**
 * System operations on databases — gated behind --allow-system.
 *
 *   stats       : table sizes, row estimates, index count, DB size on disk
 *   system_info : version, uptime, connections, settings snapshot
 *   export      : dump a table/result to CSV or JSON file
 *   import      : load a CSV file into a table (uses write path)
 *   backup      : dialect-native backup (VACUUM INTO / pg_dump / mysqldump / BACKUP DATABASE)
 *
 * File paths are resolved by the caller (CLI) and always stay under the
 * working directory unless an absolute path is given by the operator.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
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

/** Dialect-appropriate identifier quoting (mysql `, sqlserver [], else ""). */
export function quoteIdent(dialect: DatabaseDialect, name: string): string {
  if (dialect === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  if (dialect === 'sqlserver') return `[${name.replace(/\]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
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
      const { rows } = await pool.query(`SELECT pg_database_size(current_database()) AS size`);
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
    } else if (db.dialect === 'sqlserver') {
      const pool = await (db as any).ensurePool();
      const total = await pool.request().query(
        `SELECT CAST(SUM(size) AS BIGINT) AS [size]
         FROM sys.master_files WHERE database_id = DB_ID()`,
      );
      totalSizeBytes = Number(total.recordset?.[0]?.size ?? 0);
      const perTable = await pool.request().query(
        `SELECT OBJECT_NAME(ps.object_id) AS [name],
                CAST(SUM(ps.reserved_page_count) AS BIGINT) * 8192 AS [size],
                (SELECT COUNT(*) FROM sys.indexes i
                  WHERE i.object_id = ps.object_id AND i.index_id > 0
                    AND i.is_hypothetical = 0) AS [indexes]
         FROM sys.dm_db_partition_stats ps
         GROUP BY ps.object_id`,
      );
      for (const s of stats) {
        const row = (perTable.recordset ?? []).find(
          (r: any) => String(r.name) === s.table.split('.').pop(),
        );
        if (row) {
          s.sizeBytes = Number(row.size ?? 0);
          s.indexCount = Number(row.indexes ?? 0);
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
    info.version = String(v.rows[0]?.v ?? '')
      .split(' ')
      .slice(0, 2)
      .join(' ');
    const up = await pool.query(
      'SELECT pg_postmaster_start_time() AS start, (SELECT count(*) FROM pg_stat_activity) AS conns',
    );
    info.uptimeSeconds = Math.floor((Date.now() - new Date(up.rows[0]?.start).getTime()) / 1000);
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
  } else if (db.dialect === 'sqlserver') {
    const pool = await (db as any).ensurePool();
    const v = await pool.request().query(
      `SELECT CAST(SERVERPROPERTY('productversion') AS nvarchar(128)) AS [version],
              CAST(SERVERPROPERTY('productlevel') AS nvarchar(128)) AS [level],
              CAST(SERVERPROPERTY('edition') AS nvarchar(128)) AS [edition]`,
    );
    const row = v.recordset?.[0];
    if (row) {
      info.version = `${row.version} (${row.level}, ${row.edition})`;
      info.extra.engine = String(row.edition ?? '');
    }
    try {
      // DMVs below require VIEW SERVER / DATABASE STATE — best effort.
      const up = await pool.request().query('SELECT sqlserver_start_time FROM sys.dm_os_sys_info');
      const start = up.recordset?.[0]?.sqlserver_start_time;
      if (start) {
        info.uptimeSeconds = Math.max(
          0,
          Math.floor((Date.now() - new Date(start).getTime()) / 1000),
        );
      }
      const conns = await pool
        .request()
        .query(`SELECT COUNT(*) AS [conns] FROM sys.dm_exec_sessions WHERE is_user_process = 1`);
      info.activeConnections = Number(conns.recordset?.[0]?.conns ?? 0);
      const st = await pool.request().query(
        `SELECT name, CAST(value_in_use AS nvarchar(128)) AS [value]
         FROM sys.configurations
         WHERE name IN ('max server memory (MB)', 'min server memory (MB)',
                        'max degree of parallelism', 'cost threshold for parallelism')`,
      );
      for (const r of st.recordset ?? []) info.settings[String(r.name)] = String(r.value);
    } catch {
      /* DMV access denied — version/settings above are still useful */
    }
  }

  return info;
}

/* ─────────────────── export ─────────────────── */

function escCsv(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns.map(escCsv).join(','), ...rows.map((r) => r.map(escCsv).join(','))].join('\n');
}

/** One CSV data line (no header) — the streaming counterpart of toCsv. */
function csvLine(row: unknown[]): string {
  return row.map(escCsv).join(',');
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null]))),
    null,
    2,
  );
}

/** One compact JSON object line for a row — the streaming counterpart of toJson. */
function jsonLine(columns: string[], row: unknown[]): string {
  return JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null])));
}

export interface ExportOptions {
  /** Rows per read chunk (default 5000, clamped to 100..50000). */
  chunkRows?: number;
  /** Progress callback with the cumulative row count. */
  onProgress?: (rows: number) => void;
}

export interface ExportResult {
  file: string;
  rows: number;
  bytes: number;
  elapsedMs: number;
}

/** Write with backpressure: resolve when the kernel buffer drains. */
function streamWrite(out: WriteStream, s: string): Promise<void> {
  if (out.write(s)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    out.once('drain', () => resolve());
    out.once('error', reject);
  });
}

function streamEnd(out: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(() => resolve());
  });
}

/**
 * Dump a whole table to CSV/JSON, streaming both sides.
 *
 * Reads go through native handles in chunks (SQLite iterates lazily; server
 * dialects page with LIMIT/OFFSET or OFFSET/FETCH) and bytes are written to
 * a file stream — memory stays flat regardless of table size. Note this
 * intentionally bypasses the driver's maxRows guardrail: an explicit
 * operator dump is not an ad-hoc agent query.
 */
export async function exportTable(
  db: DatabaseDriver,
  table: string,
  format: 'csv' | 'json',
  outPath: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const t0 = Date.now();
  const chunkRows = Math.max(100, Math.min(opts.chunkRows ?? 5000, 50000));
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  const qualified = quoteIdent(db.dialect, table);

  let columns: string[] | null = null;
  let rows = 0;
  let first = true;
  const progress = () => opts.onProgress?.(rows);

  /** Write one page of rows; handles the header/opening-bracket once. */
  const emit = async (cols: string[], page: unknown[][]): Promise<void> => {
    if (page.length === 0) return;
    if (columns === null) {
      columns = cols;
      if (format === 'csv') await streamWrite(out, cols.map(escCsv).join(',') + '\n');
      else await streamWrite(out, '[');
    }
    if (format === 'csv') {
      await streamWrite(out, page.map(csvLine).join('\n') + '\n');
    } else {
      const sep = first ? '' : ',';
      await streamWrite(out, sep + page.map((r) => jsonLine(cols, r)).join(','));
    }
    first = false;
    rows += page.length;
    progress();
  };

  try {
    if (db.dialect === 'sqlite') {
      // Single-pass lazy iteration — no OFFSET degradation, flat memory.
      const handle = (db as any).db;
      const stmt = handle.prepare(`SELECT * FROM ${qualified}`);
      let page: unknown[][] = [];
      let cols: string[] | null = null;
      for (const record of stmt.iterate()) {
        const obj = { ...(record as Record<string, unknown>) };
        if (cols === null) cols = Object.keys(obj);
        page.push(Object.values(obj).map(cellToExport));
        if (page.length >= chunkRows) {
          await emit(cols, page);
          page = [];
        }
      }
      if (cols === null) {
        // Empty table: still emit a header from the catalog.
        const info = await db.describeTable(table);
        cols = info?.columns.map((c) => c.name) ?? [];
        await emit(cols, []);
        if (columns === null) {
          // emit() skips empty pages — write the header directly.
          if (format === 'csv') await streamWrite(out, cols.map(escCsv).join(',') + '\n');
          else await streamWrite(out, '[');
          columns = cols;
        }
      } else if (page.length > 0) {
        await emit(cols, page);
      }
    } else {
      // Server dialects: page through the table in fixed chunks.
      let offset = 0;
      for (;;) {
        const page = await readPage(db, qualified, offset, chunkRows);
        if (page.rows.length === 0) break;
        await emit(page.columns, page.rows);
        offset += page.rows.length;
        if (page.rows.length < chunkRows) break;
      }
    }
    if (format === 'json') await streamWrite(out, columns === null ? '[]' : ']');
    else if (columns === null) {
      // Empty table on a server dialect: header from the catalog.
      const info = await db.describeTable(table);
      const cols = info?.columns.map((c) => c.name) ?? [];
      await streamWrite(out, cols.map(escCsv).join(',') + '\n');
    }
    await streamEnd(out);
  } catch (err) {
    out.destroy();
    throw err;
  }
  return { file: outPath, rows, bytes: statSync(outPath).size, elapsedMs: Date.now() - t0 };
}

/** Normalize driver-specific cell values for export (BigInt/Date/Buffer). */
function cellToExport(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array || (typeof Buffer !== 'undefined' && v instanceof Buffer)) {
    return `<binary ${v.length} bytes>`;
  }
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** One page of a server table via native handles (LIMIT/OFFSET family). */
async function readPage(
  db: DatabaseDriver,
  qualified: string,
  offset: number,
  limit: number,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  if (db.dialect === 'postgres') {
    const { rows, fields } = await (db as any).pool.query(
      `SELECT * FROM ${qualified} LIMIT ${limit} OFFSET ${offset}`,
    );
    const columns = (fields ?? []).map((f: any) => f.name ?? String(f));
    return { columns, rows: rows.map((r: any) => Object.values(r).map(cellToExport)) };
  }
  if (db.dialect === 'mysql') {
    const conn = await (db as any).ensureConnection();
    const [rows, fields] = await conn.query(
      `SELECT * FROM ${qualified} LIMIT ${limit} OFFSET ${offset}`,
    );
    const columns = (fields ?? []).map((f: any) => f.name ?? String(f));
    const arr = Array.isArray(rows) ? rows : [rows];
    return { columns, rows: arr.map((r: any) => Object.values(r).map(cellToExport)) };
  }
  // sqlserver: OFFSET/FETCH needs ORDER BY; (SELECT NULL) keeps it a pure dump.
  const pool = await (db as any).ensurePool();
  const res = await pool
    .request()
    .query(
      `SELECT * FROM ${qualified} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
    );
  const recordset = res.recordset ?? [];
  const columns =
    recordset.columns && Object.keys(recordset.columns).length > 0
      ? Object.keys(recordset.columns)
      : recordset[0]
        ? Object.keys(recordset[0])
        : [];
  return { columns, rows: recordset.map((r: any) => columns.map((c) => cellToExport(r[c]))) };
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

export interface ImportOptions {
  /** Rows per INSERT statement (default 500, clamped by the driver param budget). */
  batchRows?: number;
  createTable?: boolean;
  /** Progress callback with the cumulative inserted count. */
  onProgress?: (inserted: number) => void;
}

export interface ImportResult {
  inserted: number;
  table: string;
  batches: number;
  elapsedMs: number;
}

/** Max bind parameters per statement per dialect (conservative budgets). */
function maxParams(dialect: DatabaseDialect): number {
  switch (dialect) {
    case 'sqlite':
      return 900; // old SQLite variable limit is 999
    case 'postgres':
      return 60000; // protocol limit is 65535
    case 'mysql':
      return Infinity; // bulk VALUES ? — chunk by rows instead
    case 'sqlserver':
      return 2000; // limit is 2100
  }
}

function clampBatch(requested: number, cols: number, dialect: DatabaseDialect): number {
  const byParams = Math.floor(maxParams(dialect) / Math.max(1, cols));
  const cap = dialect === 'mysql' ? 1000 : byParams;
  return Math.max(1, Math.min(requested, cap));
}

export async function importCsv(
  db: DatabaseDriver,
  csvPath: string,
  table: string,
  opts: { batchRows?: number; createTable?: boolean } | ImportOptions = {},
): Promise<ImportResult> {
  const t0 = Date.now();
  const text = await readFile(csvPath, 'utf8');
  const { headers, rows } = parseCsv(text);
  if (headers.length === 0 || rows.length === 0) {
    throw new Error('CSV is empty or malformed.');
  }
  const onProgress = (opts as ImportOptions).onProgress;

  // Optionally create the table from header types (all TEXT unless numeric).
  // Privileged path (native handles, NOT db.execute): db.execute is the
  // agent-facing guarded surface and refuses non-INDEX DDL by design.
  // import_csv already requires --allow-system plus --allow-writes.
  if (opts.createTable) {
    const colType = db.dialect === 'sqlserver' ? 'NVARCHAR(MAX)' : 'TEXT';
    const colDefs = headers.map((h) => `${quoteIdent(db.dialect, h)} ${colType}`).join(', ');
    const createSql = `CREATE TABLE ${quoteIdent(db.dialect, table)} (${colDefs})`;
    if (db.dialect === 'postgres') {
      await (db as any).pool.query(createSql);
    } else if (db.dialect === 'mysql') {
      const conn = await (db as any).ensureConnection();
      await conn.query(createSql);
    } else if (db.dialect === 'sqlserver') {
      const pool = await (db as any).ensurePool();
      await pool.request().query(createSql);
    } else {
      (db as any).db.exec(createSql);
    }
  }

  const cols = headers.map((h) => quoteIdent(db.dialect, h)).join(', ');
  const target = quoteIdent(db.dialect, table);
  const batch = clampBatch(opts.batchRows ?? 500, headers.length, db.dialect);
  let inserted = 0;
  let batches = 0;
  const report = () => onProgress?.(inserted);

  // One transaction for the whole load: on SQLite this alone removes a
  // fsync per row; everywhere it makes the import atomic.
  if (db.dialect === 'sqlite') {
    const handle = (db as any).db;
    handle.exec('BEGIN');
    try {
      for (let i = 0; i < rows.length; i += batch) {
        const chunk = rows.slice(i, i + batch);
        const marks = chunk.map(() => `(${headers.map(() => '?').join(',')})`).join(',');
        handle.prepare(`INSERT INTO ${target} (${cols}) VALUES ${marks}`).run(...chunk.flat());
        inserted += chunk.length;
        batches++;
        report();
      }
      handle.exec('COMMIT');
    } catch (err) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        /* already failed */
      }
      throw err;
    }
  } else if (db.dialect === 'postgres') {
    const client = await (db as any).pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i += batch) {
        const chunk = rows.slice(i, i + batch);
        const marks: string[] = [];
        const flat: unknown[] = [];
        chunk.forEach((row, r) => {
          marks.push(`(${row.map((_, c) => `$${r * row.length + c + 1}`).join(',')})`);
          flat.push(...row);
        });
        await client.query(`INSERT INTO ${target} (${cols}) VALUES ${marks.join(',')}`, flat);
        inserted += chunk.length;
        batches++;
        report();
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* already failed */
      }
      throw err;
    } finally {
      client.release();
    }
  } else if (db.dialect === 'mysql') {
    const conn = await (db as any).ensureConnection();
    await conn.beginTransaction();
    try {
      // mysql2 bulk-insert syntax: one round-trip per chunk.
      for (let i = 0; i < rows.length; i += batch) {
        const chunk = rows.slice(i, i + batch);
        await conn.query(`INSERT INTO ${target} (${cols}) VALUES ?`, [chunk]);
        inserted += chunk.length;
        batches++;
        report();
      }
      await conn.commit();
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* already failed */
      }
      throw err;
    }
  } else {
    const pool = await (db as any).ensurePool();
    let mssql: any;
    try {
      const mod: any = await import('mssql');
      mssql = mod.default ?? mod;
    } catch {
      throw new Error('mssql is not installed. Run: npm install mssql');
    }
    const trx = new mssql.Transaction(pool);
    await trx.begin();
    try {
      for (let i = 0; i < rows.length; i += batch) {
        const chunk = rows.slice(i, i + batch);
        const req = new mssql.Request(trx);
        const marks: string[] = [];
        chunk.forEach((row, r) => {
          marks.push(`(${row.map((_, c) => `@p${r * row.length + c}`).join(',')})`);
          row.forEach((v, c) => req.input(`p${r * row.length + c}`, v));
        });
        await req.query(`INSERT INTO ${target} (${cols}) VALUES ${marks.join(',')}`);
        inserted += chunk.length;
        batches++;
        report();
      }
      await trx.commit();
    } catch (err) {
      try {
        await trx.rollback();
      } catch {
        /* already failed */
      }
      throw err;
    }
  }
  return { inserted, table, batches, elapsedMs: Date.now() - t0 };
}

/* ─────────────────── backup ─────────────────── */

export interface BackupResult {
  file: string;
  bytes: number;
  method: string;
}

export async function backup(db: DatabaseDriver, outPath: string): Promise<BackupResult> {
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });

  if (db.dialect === 'sqlite') {
    // Use VACUUM INTO for a consistent snapshot.
    await db.execute(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
    return { file: outPath, bytes: statSync(outPath).size, method: 'VACUUM INTO' };
  }

  if (db.dialect === 'postgres') {
    return runDumpTool('pg_dump', [], db, outPath, 'pg_dump');
  }
  if (db.dialect === 'sqlserver') {
    // BACKUP DATABASE runs on the server: the file lands in the server's
    // filesystem, which is the same machine only for local instances.
    const pool = await (db as any).ensurePool();
    const abs = path.resolve(outPath);
    const nameRes = await pool.request().query('SELECT DB_NAME() AS [db]');
    const dbName = String(nameRes.recordset?.[0]?.db ?? '');
    const backupSql =
      `BACKUP DATABASE [${dbName.replace(/\]/g, ']]')}] TO DISK = N'${abs.replace(/'/g, "''")}' ` +
      'WITH INIT, STATS = 5';
    try {
      // per-request override: the pool default (30s) is too short for backups
      const req = pool.request({ requestTimeout: 600_000 });
      await req.query(backupSql);
    } catch (err) {
      throw new Error(
        `BACKUP DATABASE failed: ${(err as Error).message} ` +
          'The .bak path is resolved on the SQL Server host, and the service account must be able to write there ' +
          '(for Docker/remote instances use a server-side path, e.g. via SSMS or sqlcmd).',
      );
    }
    let bytes = 0;
    try {
      bytes = statSync(abs).size;
    } catch {
      /* created on the server host, not visible from here */
    }
    return {
      file: bytes > 0 ? outPath : abs,
      bytes,
      method:
        bytes > 0 ? 'BACKUP DATABASE' : 'BACKUP DATABASE (file created on the SQL Server host)',
    };
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
      reject(
        new Error(`${tool} not found in PATH — install the ${spec} client tools. ${err.message}`),
      ),
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
