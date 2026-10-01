/**
 * PostgreSQL driver (pg) with schema introspection and guarded execution.
 */

import { createRequire } from 'node:module';
import type {
  DatabaseConnection,
  DatabaseDriver,
  QueryResult,
  SafetyConfig,
  TableInfo,
  ColumnInfo,
} from '../core/types.js';
import { classifyStatement, isWriteStatement, singleStatement, enforceLimit } from './guard.js';

export class PostgresDriver implements DatabaseDriver {
  readonly dialect = 'postgres' as const;
  private readonly pool: any;
  private readonly safety: Required<SafetyConfig>;

  constructor(conn: DatabaseConnection, safety: SafetyConfig = {}) {
    this.safety = {
      allowWrites: safety.allowWrites ?? false,
      maxRows: safety.maxRows ?? 100,
      maxStatements: safety.maxStatements ?? 1,
    };
    let pg: any;
    try {
      const req = createRequire(import.meta.url);
      pg = req('pg');
    } catch {
      throw new Error('pg is not installed. Run: npm install pg');
    }
    this.pool = new pg.Pool({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
      max: 2,
      connectionTimeoutMillis: 10_000,
    });
  }

  describeTarget(): string {
    return `postgresql server (database: ${this.pool.options?.database ?? '?'})`;
  }

  async listTables(): Promise<TableInfo[]> {
    const { rows } = await this.pool.query(
      `SELECT c.relname AS name,
              c.relkind AS kind,
              c.reltuples::bigint AS row_estimate,
              n.nspname AS schema
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND c.relkind IN ('r','v','m','p')
       ORDER BY n.nspname, c.relname`,
    );
    const out: TableInfo[] = [];
    for (const r of rows) {
      out.push({
        name: r.name,
        schema: r.schema,
        kind: r.kind === 'r' || r.kind === 'p' ? 'table' : 'view',
        rowCountEstimate: Number(r.row_estimate),
        columns: await this.columnsOf(r.schema, r.name),
      });
    }
    return out;
  }

  async describeTable(name: string): Promise<TableInfo | null> {
    const [schema, table] = name.includes('.') ? name.split('.', 2) : [null, name];
    const { rows } = await this.pool.query(
      `SELECT c.relname AS name, c.relkind AS kind, n.nspname AS schema
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1 AND ($2::text IS NULL OR n.nspname = $2)
         AND c.relkind IN ('r','v','m','p')
       LIMIT 1`,
      [table, schema],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      name: r.name,
      schema: r.schema,
      kind: r.kind === 'r' || r.kind === 'p' ? 'table' : 'view',
      columns: await this.columnsOf(r.schema, r.name),
    };
  }

  async sampleRows(name: string, limit: number): Promise<QueryResult> {
    const capped = Math.max(1, Math.min(limit, this.safety.maxRows));
    const [schema, table] = name.includes('.') ? name.split('.', 2) : [null, name];
    const q = '"';
    const qualified = schema ? `${q}${schema}${q}.${q}${table}${q}` : `${q}${table}${q}`;
    return this.runRead(`SELECT * FROM ${qualified} LIMIT ${capped}`);
  }

  async execute(sql: string): Promise<QueryResult> {
    const stmt = singleStatement(sql, this.safety.maxStatements);
    const kind = classifyStatement(stmt);
    if (isWriteStatement(stmt) && !this.safety.allowWrites) {
      throw new Error(
        'Write blocked: session is read-only (enable with --allow-writes or DBAGENT_ALLOW_WRITES=true).',
      );
    }
    const start = Date.now();
    if (kind === 'read') {
      return this.runRead(stmt);
    }
    const res = await this.pool.query(stmt);
    return {
      columns: res.fields?.map((f: any) => f.name) ?? ['status'],
      rows: res.rows?.length
        ? res.rows.map((r: any) => Object.values(r).map(String))
        : [[res.rowCount != null ? `${res.rowCount} row(s) affected` : res.command]],
      rowCount: res.rowCount ?? 0,
      durationMs: Date.now() - start,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async columnsOf(schema: string | null, table: string): Promise<ColumnInfo[]> {
    const { rows } = await this.pool.query(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS nullable,
              COALESCE(pg_get_expr(ad.adbin, ad.adrelid), NULL) AS default_value,
              EXISTS (
                SELECT 1 FROM pg_index i
                WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)
              ) AS is_primary
       FROM pg_attribute a
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1 AND ($2::text IS NULL OR n.nspname = $2)
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [table, schema],
    );
    return rows.map((r: any) => ({
      name: r.name,
      dataType: r.data_type,
      nullable: r.nullable,
      isPrimaryKey: r.is_primary,
      defaultValue: r.default_value ?? null,
    }));
  }

  private async runRead(sql: string): Promise<QueryResult> {
    const start = Date.now();
    const capped = enforceLimit(sql, this.safety.maxRows, 'postgres');
    const res = await this.pool.query(capped);
    return {
      columns: res.fields.map((f: any) => f.name),
      rows: res.rows.map((r: any) =>
        Object.values(r).map((v) => {
          if (v instanceof Date) return v.toISOString();
          if (typeof v === 'bigint') return v.toString();
          if (v instanceof Buffer) return `<binary ${v.length} bytes>`;
          if (v !== null && typeof v === 'object') return JSON.stringify(v);
          return v;
        }),
      ),
      rowCount: res.rowCount ?? res.rows.length,
      durationMs: Date.now() - start,
    };
  }
}
