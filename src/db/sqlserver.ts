/**
 * SQL Server driver (mssql / tedious) with schema introspection and guarded
 * execution. T-SQL dialect: bracket identifiers, TOP/OFFSET-FETCH limits.
 */

import type {
  DatabaseConnection,
  DatabaseDriver,
  QueryResult,
  SafetyConfig,
  TableInfo,
  ColumnInfo,
} from '../core/types.js';
import {
  classifyStatement,
  isWriteStatement,
  normalizeSql,
  singleStatement,
  enforceLimit,
} from './guard.js';
import { cloneTables, findCachedTable } from './schema-cache.js';

/**
 * T-SQL statements that can change server/database state even though they do
 * not start with a recognized write keyword (EXEC can run anything, BULK
 * INSERT loads data, BACKUP/RESTORE/DBCC are administrative).
 */
const TSQL_GATED =
  /^(?:EXEC(?:UTE)?\b|BULK\b|BACKUP\b|RESTORE\b|SHUTDOWN\b|KILL\b|RECONFIGURE\b|DBCC\b)/i;

export class SqlServerDriver implements DatabaseDriver {
  readonly dialect = 'sqlserver' as const;
  private readonly connSpec: DatabaseConnection;
  private readonly safety: Required<SafetyConfig>;
  private readonly database: string;
  private pool: any;
  /** Session snapshot of listTables(); cleared on writes and refreshSchema(). */
  private tablesCache: TableInfo[] | null = null;

  constructor(conn: DatabaseConnection, safety: SafetyConfig = {}) {
    this.connSpec = conn;
    this.safety = {
      allowWrites: safety.allowWrites ?? false,
      maxRows: safety.maxRows ?? 100,
      maxStatements: safety.maxStatements ?? 1,
    };
    this.database = conn.database ?? '';
  }

  describeTarget(): string {
    const host = this.connSpec.instanceName
      ? `${this.connSpec.host ?? 'localhost'}\\${this.connSpec.instanceName}`
      : `${this.connSpec.host ?? 'localhost'}:${this.connSpec.port ?? 1433}`;
    return `sql server (database: ${this.database || '?'}, server: ${host})`;
  }

  private async ensurePool(): Promise<any> {
    if (!this.pool) {
      let mod: any;
      try {
        mod = await import('mssql');
      } catch {
        throw new Error('mssql is not installed. Run: npm install mssql');
      }
      const mssql = mod.default ?? mod;
      // Omit keys entirely when unset: mssql defaults encrypt to true, and
      // Object.assign would overwrite that default with an explicit undefined.
      const options: Record<string, unknown> = {
        // Dev-friendly default: encrypt, but tolerate self-signed certs
        // (tighten with ?trustServerCertificate=false).
        trustServerCertificate: this.connSpec.trustServerCertificate ?? true,
      };
      if (typeof this.connSpec.ssl === 'boolean') options.encrypt = this.connSpec.ssl;
      if (this.connSpec.instanceName) options.instanceName = this.connSpec.instanceName;
      const cfg = {
        server: this.connSpec.host ?? 'localhost',
        port: this.connSpec.port ?? 1433,
        database: this.database || undefined,
        user: this.connSpec.user,
        password: this.connSpec.password,
        options,
        connectionTimeout: 10_000,
        requestTimeout: 30_000,
        pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
      };
      this.pool = await new mssql.ConnectionPool(cfg).connect();
    }
    return this.pool;
  }

  async listTables(): Promise<TableInfo[]> {
    if (this.tablesCache) return cloneTables(this.tablesCache);
    const pool = await this.ensurePool();
    const res = await pool.request().query(
      `SELECT o.name AS [name], o.type AS [type],
              ISNULL(SUM(p.rows), 0) AS [row_estimate],
              SCHEMA_NAME(o.schema_id) AS [schema]
       FROM sys.objects o
       LEFT JOIN sys.partitions p ON p.object_id = o.object_id AND p.index_id IN (0, 1)
       WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
       GROUP BY o.name, o.type, SCHEMA_NAME(o.schema_id)
       ORDER BY SCHEMA_NAME(o.schema_id), o.name`,
    );
    const out: TableInfo[] = [];
    for (const r of res.recordset ?? []) {
      out.push({
        name: String(r.name),
        schema: r.schema != null ? String(r.schema) : undefined,
        kind: String(r.type).trim() === 'V' ? 'view' : 'table',
        rowCountEstimate: Number(r.row_estimate ?? 0),
        columns: await this.columnsOf(String(r.name), r.schema != null ? String(r.schema) : null),
      });
    }
    this.tablesCache = cloneTables(out);
    return out;
  }

  async describeTable(name: string): Promise<TableInfo | null> {
    const cached = findCachedTable(this.tablesCache, name);
    if (cached) return cached;
    const pool = await this.ensurePool();
    const [schema, table] = splitQualified(name);
    const req = pool.request().input('table', table);
    if (schema) req.input('schema', schema);
    const res = await req.query(
      `SELECT o.name AS [name], o.type AS [type], SCHEMA_NAME(o.schema_id) AS [schema]
       FROM sys.objects o
       WHERE o.name = @table${schema ? ' AND SCHEMA_NAME(o.schema_id) = @schema' : ''}
         AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0`,
    );
    const rows = res.recordset ?? [];
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      name: String(r.name),
      schema: r.schema != null ? String(r.schema) : undefined,
      kind: String(r.type).trim() === 'V' ? 'view' : 'table',
      columns: await this.columnsOf(String(r.name), r.schema != null ? String(r.schema) : null),
    };
  }

  async sampleRows(name: string, limit: number): Promise<QueryResult> {
    const capped = Math.max(1, Math.min(limit, this.safety.maxRows));
    const [schema, table] = splitQualified(name);
    const qualified = schema ? `[${bracket(schema)}].[${bracket(table)}]` : `[${bracket(table)}]`;
    return this.runRead(`SELECT TOP (${capped}) * FROM ${qualified}`);
  }

  async execute(sql: string): Promise<QueryResult> {
    const pool = await this.ensurePool();
    const stmt = singleStatement(sql, this.safety.maxStatements);
    const kind = classifyStatement(stmt);
    const gated = isWriteStatement(stmt) || TSQL_GATED.test(normalizeSql(stmt));
    if (gated && !this.safety.allowWrites) {
      throw new Error(
        'Write blocked: session is read-only (enable with --allow-writes or DBAGENT_ALLOW_WRITES=true).',
      );
    }
    const start = Date.now();
    if (kind === 'read') return this.runRead(stmt);

    const res = await pool.request().query(stmt);
    // Row counts and catalog entries may be stale after a write.
    this.tablesCache = null;
    // EXEC/MERGE etc. may return a result set — show it instead of a bare count.
    if (res.recordset && (res.recordset.columns || res.recordset.length > 0)) {
      return this.recordsetToResult(res, start);
    }
    const affected = Number(res.rowsAffected?.[0] ?? 0);
    return {
      columns: ['rowsAffected'],
      rows: [[affected]],
      rowCount: affected,
      durationMs: Date.now() - start,
    };
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.close();
  }

  /** Drop the cached schema snapshot; the next listTables() re-reads sys.objects. */
  async refreshSchema(): Promise<void> {
    this.tablesCache = null;
  }

  private async columnsOf(table: string, schema: string | null): Promise<ColumnInfo[]> {
    const pool = await this.ensurePool();
    const req = pool.request().input('table', table);
    if (schema) req.input('schema', schema);
    const res = await req.query(
      `SELECT c.name AS [name],
              TYPE_NAME(c.user_type_id) AS [type_name],
              c.max_length AS [max_length],
              c.precision AS [precision],
              c.scale AS [scale],
              c.is_nullable AS [is_nullable],
              CASE WHEN EXISTS (
                  SELECT 1 FROM sys.index_columns ic
                  JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                  WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id
                    AND i.is_primary_key = 1
                ) THEN 1 ELSE 0 END AS [is_primary],
              dc.definition AS [default_value]
       FROM sys.columns c
       JOIN sys.objects o ON o.object_id = c.object_id
       LEFT JOIN sys.default_constraints dc
         ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
       WHERE o.name = @table${schema ? ' AND SCHEMA_NAME(o.schema_id) = @schema' : ''}
       ORDER BY c.column_id`,
    );
    return (res.recordset ?? []).map((r: any) => ({
      name: String(r.name),
      dataType: formatTsqlType(r),
      nullable: !!r.is_nullable,
      isPrimaryKey: Number(r.is_primary) === 1,
      defaultValue: r.default_value != null ? String(r.default_value) : null,
    }));
  }

  private async runRead(sql: string): Promise<QueryResult> {
    const pool = await this.ensurePool();
    const start = Date.now();
    const capped = enforceLimit(sql, this.safety.maxRows, 'sqlserver');
    const res = await pool.request().query(capped);
    return this.recordsetToResult(res, start);
  }

  private recordsetToResult(res: any, start: number): QueryResult {
    const recordset = res.recordset ?? [];
    const columns =
      recordset.columns && Object.keys(recordset.columns).length > 0
        ? Object.keys(recordset.columns)
        : recordset.length > 0
          ? Object.keys(recordset[0])
          : [];
    return {
      columns,
      rows: recordset.map((r: any) => columns.map((c) => tsqlCell(r[c]))),
      rowCount: recordset.length,
      durationMs: Date.now() - start,
    };
  }
}

/** Split "schema.table" at the first dot outside brackets; no schema → [null, name]. */
function splitQualified(name: string): [string | null, string] {
  const n = name.trim();
  let depth = 0;
  for (let i = 0; i < n.length; i++) {
    const ch = n[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '.' && depth === 0) {
      return [unbracket(n.slice(0, i)), unbracket(n.slice(i + 1))];
    }
  }
  return [null, unbracket(n)];
}

function unbracket(s: string): string {
  const t = s.trim();
  return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
}

function bracket(ident: string): string {
  return ident.replace(/\]/g, ']]');
}

/** Render column metadata the way a DBA would: nvarchar(50), decimal(18,2), int... */
function formatTsqlType(r: {
  type_name?: unknown;
  max_length?: unknown;
  precision?: unknown;
  scale?: unknown;
}): string {
  const t = String(r.type_name ?? '');
  const maxLength = Number(r.max_length ?? 0);
  if (['nvarchar', 'nchar', 'varchar', 'char', 'varbinary', 'binary'].includes(t)) {
    if (maxLength === -1) return `${t}(MAX)`;
    const len = t === 'nvarchar' || t === 'nchar' ? maxLength / 2 : maxLength;
    return `${t}(${len})`;
  }
  if (t === 'decimal' || t === 'numeric') {
    return `${t}(${Number(r.precision ?? 0)},${Number(r.scale ?? 0)})`;
  }
  if (t === 'datetime2' || t === 'datetimeoffset' || t === 'time') {
    return `${t}(${Number(r.scale ?? 0)})`;
  }
  return t;
}

function tsqlCell(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array || v instanceof Buffer) return `<binary ${v.length} bytes>`;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
