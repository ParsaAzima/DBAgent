/**
 * MySQL driver (mysql2/promise) with introspection and guarded execution.
 */

import type {
  DatabaseConnection,
  DatabaseDriver,
  QueryResult,
  SafetyConfig,
  TableInfo,
  ColumnInfo,
} from '../core/types.js';
import { classifyStatement, isWriteStatement, singleStatement, enforceLimit } from './guard.js';

export class MysqlDriver implements DatabaseDriver {
  readonly dialect = 'mysql' as const;
  private readonly connSpec: DatabaseConnection;
  private readonly safety: Required<SafetyConfig>;
  private readonly database: string;
  private conn: any;

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
    return `mysql database: ${this.database}`;
  }

  private async ensureConnection(): Promise<any> {
    if (!this.conn) {
      let mysql: any;
      try {
        mysql = (await import('mysql2/promise')) as any;
      } catch {
        throw new Error('mysql2 is not installed. Run: npm install mysql2');
      }
      this.conn = await mysql.createConnection({
        host: this.connSpec.host,
        port: this.connSpec.port,
        user: this.connSpec.user,
        password: this.connSpec.password,
        database: this.database,
        multipleStatements: false,
        connectTimeout: 10_000,
        ssl: this.connSpec.ssl ? { rejectUnauthorized: false } : undefined,
      });
    }
    return this.conn;
  }

  async listTables(): Promise<TableInfo[]> {
    const conn = await this.ensureConnection();
    const [rows] = await conn.query(
      `SELECT table_name AS name, table_type AS kind, table_rows AS row_estimate
       FROM information_schema.tables
       WHERE table_schema = ? ORDER BY table_name`,
      [this.database],
    );
    const out: TableInfo[] = [];
    for (const r of rows as any[]) {
      out.push({
        name: String(r.name ?? r.NAME ?? r.TABLE_NAME),
        kind: String(r.kind).toLowerCase().includes('view') ? 'view' : 'table',
        rowCountEstimate: Number(r.row_estimate ?? 0),
        columns: await this.columnsOf(String(r.name ?? r.TABLE_NAME)),
      });
    }
    return out;
  }

  async describeTable(name: string): Promise<TableInfo | null> {
    const conn = await this.ensureConnection();
    const [rows] = await conn.query(
      `SELECT table_name AS name, table_type AS kind
       FROM information_schema.tables
       WHERE table_schema = ? AND table_name = ? LIMIT 1`,
      [this.database, name],
    );
    if ((rows as any[]).length === 0) return null;
    const r = rows[0];
    return {
      name: String(r.name),
      kind: String(r.kind).toLowerCase().includes('view') ? 'view' : 'table',
      columns: await this.columnsOf(String(r.name)),
    };
  }

  async sampleRows(name: string, limit: number): Promise<QueryResult> {
    const capped = Math.max(1, Math.min(limit, this.safety.maxRows));
    return this.runRead(`SELECT * FROM \`${name.replace(/`/g, '``')}\` LIMIT ${capped}`);
  }

  async execute(sql: string): Promise<QueryResult> {
    const conn = await this.ensureConnection();
    const stmt = singleStatement(sql, this.safety.maxStatements);
    const kind = classifyStatement(stmt);
    if (isWriteStatement(stmt) && !this.safety.allowWrites) {
      throw new Error(
        'Write blocked: session is read-only (enable with --allow-writes or DBAGENT_ALLOW_WRITES=true).',
      );
    }
    const start = Date.now();
    if (kind === 'read') return this.runRead(stmt);
    const [res]: any = await conn.query(stmt);
    const affected = res?.affectedRows ?? res?.changedRows ?? 0;
    return {
      columns: ['rowsAffected'],
      rows: [[Number(affected)]],
      rowCount: Number(affected),
      durationMs: Date.now() - start,
    };
  }

  async close(): Promise<void> {
    if (this.conn) await this.conn.end();
  }

  private async columnsOf(table: string): Promise<ColumnInfo[]> {
    const conn = await this.ensureConnection();
    const [rows] = await conn.query(
      `SELECT column_name, column_type, is_nullable, column_key, column_default
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [this.database, table],
    );
    return (rows as any[]).map((r) => ({
      name: String(r.column_name ?? r.COLUMN_NAME),
      dataType: String(r.column_type ?? r.COLUMN_TYPE),
      nullable: String(r.is_nullable ?? 'YES').toUpperCase() === 'YES',
      isPrimaryKey: String(r.column_key ?? '') === 'PRI',
      defaultValue: r.column_default ?? null,
    }));
  }

  private async runRead(sql: string): Promise<QueryResult> {
    const conn = await this.ensureConnection();
    const start = Date.now();
    const capped = enforceLimit(sql, this.safety.maxRows, 'mysql');
    const [rows, fields] = await conn.query(capped);
    const cols = (fields ?? []).map((f: any) => f.name);
    const arr = Array.isArray(rows) ? rows : [rows];
    return {
      columns: cols,
      rows: arr.map((r: any) => Object.values(r).map(mysqlCell)),
      rowCount: arr.length,
      durationMs: Date.now() - start,
    };
  }
}

function mysqlCell(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Buffer) return `<binary ${v.length} bytes>`;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}
