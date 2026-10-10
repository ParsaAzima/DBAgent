/**
 * Oracle Database driver (node-oracledb thin mode) with schema introspection.
 */

import type {
  ColumnInfo,
  DatabaseConnection,
  DatabaseDriver,
  ForeignKeyRelation,
  QueryResult,
  RoutineInfo,
  SafetyConfig,
  SchemaGraph,
  TableInfo,
} from '../core/types.js';
import {
  assertDdlAllowed,
  classifyStatement,
  enforceLimit,
  isWriteStatement,
  singleStatement,
} from './guard.js';
import { buildSchemaGraph, cloneRelations, cloneTables, findCachedTable } from './schema-cache.js';
import { isSensitiveColumn } from '../system/pii.js';

export class OracleDriver implements DatabaseDriver {
  readonly dialect = 'oracle' as const;
  private readonly connSpec: DatabaseConnection;
  private readonly safety: Required<SafetyConfig>;
  private connection: any;
  private oracledb: any;
  private tablesCache: TableInfo[] | null = null;
  private relationsCache: ForeignKeyRelation[] | null = null;

  constructor(conn: DatabaseConnection, safety: SafetyConfig = {}) {
    this.connSpec = conn;
    this.safety = {
      allowWrites: safety.allowWrites ?? false,
      ddlMode: safety.ddlMode ?? 'off',
      maxRows: safety.maxRows ?? 100,
      maxStatements: safety.maxStatements ?? 1,
    };
  }

  describeTarget(): string {
    const service = this.connSpec.database ?? this.connSpec.oracleSid ?? '?';
    return `oracle database: ${service} at ${this.connSpec.host ?? 'localhost'}:${this.connSpec.port ?? 1521}`;
  }

  private async ensureConnection(): Promise<any> {
    if (this.connection) return this.connection;
    try {
      const mod: any = await import('oracledb');
      this.oracledb = mod.default ?? mod;
    } catch {
      throw new Error('oracledb is not installed. Run: npm install oracledb');
    }
    const protocol = this.connSpec.oracleProtocol === 'tcps' ? 'TCPS' : 'TCP';
    const service = this.connSpec.oracleSid ?? this.connSpec.database ?? '';
    if (!/^[A-Za-z0-9._$#-]+$/.test(service)) {
      throw new Error('Oracle service name/SID contains unsupported characters.');
    }
    const connectData = this.connSpec.oracleSid ? `(SID=${service})` : `(SERVICE_NAME=${service})`;
    const connectString =
      `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${this.connSpec.host ?? 'localhost'})` +
      `(PORT=${this.connSpec.port ?? 1521}))(CONNECT_DATA=${connectData}))`;
    this.connection = await this.oracledb.getConnection({
      user: this.connSpec.user,
      password: this.connSpec.password,
      connectString,
    });
    return this.connection;
  }

  async listTables(): Promise<TableInfo[]> {
    if (this.tablesCache) return cloneTables(this.tablesCache);
    const conn = await this.ensureConnection();
    const { rows } = await this.query(
      conn,
      `SELECT object_name, object_type FROM user_objects
       WHERE object_type IN ('TABLE', 'VIEW') ORDER BY object_name`,
    );
    const tables: TableInfo[] = [];
    for (const [objectName, objectType] of rows) {
      const name = String(objectName);
      tables.push({
        name,
        schema: this.connSpec.user?.toUpperCase(),
        kind: String(objectType) === 'VIEW' ? 'view' : 'table',
        columns: await this.columnsOf(name),
      });
    }
    this.tablesCache = cloneTables(tables);
    return tables;
  }

  async describeTable(name: string): Promise<TableInfo | null> {
    const cached = findCachedTable(this.tablesCache, name);
    if (cached) return cached;
    const requestedSchema = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : undefined;
    if (
      requestedSchema &&
      requestedSchema.replace(/"/g, '').toUpperCase() !== this.connSpec.user?.toUpperCase()
    ) {
      return null;
    }
    const conn = await this.ensureConnection();
    const objectName = unqualifiedName(name);
    const { rows } = await this.query(
      conn,
      `SELECT object_type FROM user_objects
       WHERE object_name = :1 AND object_type IN ('TABLE', 'VIEW')`,
      [objectName.toUpperCase()],
    );
    if (rows.length === 0) return null;
    return {
      name: objectName,
      schema: this.connSpec.user?.toUpperCase(),
      kind: String(rows[0][0]) === 'VIEW' ? 'view' : 'table',
      columns: await this.columnsOf(objectName),
    };
  }

  async sampleRows(name: string, limit: number): Promise<QueryResult> {
    const capped = Math.max(1, Math.min(limit, this.safety.maxRows));
    return this.runRead(`SELECT * FROM ${quoteQualified(name)} FETCH FIRST ${capped} ROWS ONLY`);
  }

  async execute(sql: string): Promise<QueryResult> {
    const stmt = singleStatement(sql, this.safety.maxStatements);
    if (/^EXPLAIN\s+PLAN\s+FOR\b/i.test(stmt)) {
      throw new Error('Use explain_query for Oracle execution plans.');
    }
    assertDdlAllowed(stmt, this.safety);
    const kind = classifyStatement(stmt);
    if (kind === 'other') {
      throw new Error(
        'Unsupported Oracle statement. Only SELECT/WITH, guarded DML, and gated CREATE INDEX are supported.',
      );
    }
    if (isWriteStatement(stmt) && !this.safety.allowWrites) {
      throw new Error(
        'Write blocked: session is read-only (enable with --allow-writes or DBAGENT_ALLOW_WRITES=true).',
      );
    }
    if (kind === 'read') return this.runRead(stmt);
    const conn = await this.ensureConnection();
    const start = Date.now();
    const result = await conn.execute(stmt, [], { autoCommit: true });
    this.tablesCache = null;
    this.relationsCache = null;
    const affected = Number(result.rowsAffected ?? 0);
    return {
      columns: ['rowsAffected'],
      rows: [[affected]],
      rowCount: affected,
      durationMs: Date.now() - start,
    };
  }

  async explainQuery(sql: string): Promise<QueryResult> {
    const stmt = singleStatement(sql, 1);
    if (classifyStatement(stmt) !== 'read') {
      throw new Error('Oracle explain_query only accepts a single read statement.');
    }
    const conn = await this.ensureConnection();
    const start = Date.now();
    const capped = enforceLimit(stmt, this.safety.maxRows, 'oracle');
    await conn.execute(`EXPLAIN PLAN FOR ${capped}`, [], { autoCommit: true });
    const plan = await this.query(
      conn,
      `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'TYPICAL'))`,
    );
    return {
      columns: plan.columns,
      rows: plan.rows
        .slice(0, 300)
        .map((row) =>
          row.map((value) =>
            typeof value === 'string' && value.length > 1000 ? `${value.slice(0, 1000)}…` : value,
          ),
        ),
      rowCount: Math.min(plan.rows.length, 300),
      durationMs: Date.now() - start,
    };
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = undefined;
    }
  }

  async refreshSchema(): Promise<void> {
    this.tablesCache = null;
    this.relationsCache = null;
  }

  async listRelations(): Promise<ForeignKeyRelation[]> {
    if (this.relationsCache) return cloneRelations(this.relationsCache);
    const conn = await this.ensureConnection();
    const { rows } = await this.query(
      conn,
      `SELECT child.constraint_name, child.table_name, child_cols.column_name,
              parent.table_name, parent_cols.column_name,
              child.delete_rule
       FROM user_constraints child
       JOIN user_cons_columns child_cols
         ON child_cols.constraint_name = child.constraint_name
       JOIN user_constraints parent
         ON parent.constraint_name = child.r_constraint_name
       JOIN user_cons_columns parent_cols
         ON parent_cols.constraint_name = parent.constraint_name
        AND parent_cols.position = child_cols.position
       WHERE child.constraint_type = 'R'
       ORDER BY child.table_name, child_cols.position`,
    );
    this.relationsCache = cloneRelations(
      rows.map((r: unknown[]) => ({
        name: String(r[0]),
        fromSchema: this.connSpec.user?.toUpperCase(),
        fromTable: String(r[1]),
        fromColumn: String(r[2]),
        toSchema: this.connSpec.user?.toUpperCase(),
        toTable: String(r[3]),
        toColumn: String(r[4]),
        onDelete: String(r[5] ?? ''),
      })),
    );
    return cloneRelations(this.relationsCache);
  }

  async getSchemaGraph(): Promise<SchemaGraph> {
    return buildSchemaGraph(await this.listTables(), await this.listRelations());
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    const conn = await this.ensureConnection();
    const { rows } = await this.query(
      conn,
      `SELECT object_name, object_type FROM user_objects
       WHERE object_type IN ('PROCEDURE', 'FUNCTION')
       ORDER BY object_name`,
    );
    const routines: RoutineInfo[] = rows.map((r: unknown[]) => ({
      name: String(r[0]),
      schema: this.connSpec.user?.toUpperCase(),
      kind: String(r[1]) === 'PROCEDURE' ? 'procedure' : 'function',
    }));
    const { rows: triggers } = await this.query(
      conn,
      `SELECT trigger_name, table_name, trigger_type, triggering_event
       FROM user_triggers ORDER BY trigger_name`,
    );
    return [
      ...routines,
      ...triggers.map((r: unknown[]) => ({
        name: String(r[0]),
        schema: this.connSpec.user?.toUpperCase(),
        kind: 'trigger' as const,
        targetTable: String(r[1]),
        timing: String(r[2]),
        event: String(r[3]),
      })),
    ];
  }

  private async columnsOf(table: string): Promise<ColumnInfo[]> {
    const conn = await this.ensureConnection();
    const { rows } = await this.query(
      conn,
      `SELECT c.column_name, c.data_type, c.nullable, c.data_default,
              CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END AS is_primary
       FROM user_tab_columns c
       LEFT JOIN (
         SELECT cols.table_name, cols.column_name
         FROM user_constraints cons
         JOIN user_cons_columns cols ON cols.constraint_name = cons.constraint_name
         WHERE cons.constraint_type = 'P'
       ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
       WHERE c.table_name = :1 ORDER BY c.column_id`,
      [table.toUpperCase()],
    );
    return rows.map((r: unknown[]) => {
      const name = String(r[0]);
      return {
        name,
        dataType: String(r[1]),
        nullable: String(r[2]) === 'Y',
        defaultValue: r[3] == null ? null : String(r[3]).trim(),
        isPrimaryKey: Number(r[4]) === 1,
        sensitive: isSensitiveColumn(name) || undefined,
      };
    });
  }

  private async runRead(sql: string): Promise<QueryResult> {
    const conn = await this.ensureConnection();
    const start = Date.now();
    const capped = enforceLimit(sql, this.safety.maxRows, 'oracle');
    const { columns, rows } = await this.query(conn, capped);
    return { columns, rows, rowCount: rows.length, durationMs: Date.now() - start };
  }

  private async query(
    connection: any,
    sql: string,
    binds: unknown[] = [],
  ): Promise<{ columns: string[]; rows: unknown[][] }> {
    const result = await connection.execute(sql, binds, {
      outFormat: this.oracledb.OUT_FORMAT_ARRAY,
      fetchTypeHandler: (metadata: { dbType: number }) =>
        metadata.dbType === this.oracledb.DB_TYPE_CLOB ||
        metadata.dbType === this.oracledb.DB_TYPE_NCLOB
          ? { type: this.oracledb.STRING }
          : undefined,
    });
    return {
      columns: (result.metaData ?? []).map((column: { name: string }) => column.name),
      rows: (result.rows ?? []).map((row: unknown[]) =>
        row.map((value) => {
          if (value instanceof Date) return value.toISOString();
          if (typeof value === 'bigint') return value.toString();
          if (value instanceof Uint8Array) return `<binary ${value.length} bytes>`;
          if (value !== null && typeof value === 'object') return JSON.stringify(value);
          return value;
        }),
      ),
    };
  }
}

function unqualifiedName(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).replace(/"/g, '')
    : name.replace(/"/g, '');
}

function quoteQualified(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}
