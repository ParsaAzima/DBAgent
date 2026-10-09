/**
 * SQLite driver (better-sqlite3, synchronous API wrapped in promises).
 */

import { createRequire } from 'node:module';
import type {
  DatabaseConnection,
  DatabaseDriver,
  ForeignKeyRelation,
  QueryResult,
  RoutineInfo,
  SafetyConfig,
  SchemaGraph,
  TableInfo,
} from '../core/types.js';
import { isWriteStatement, singleStatement, enforceLimit } from './guard.js';
import { buildSchemaGraph, cloneRelations, cloneTables, findCachedTable } from './schema-cache.js';

export class SqliteDriver implements DatabaseDriver {
  readonly dialect = 'sqlite' as const;
  private readonly db: any;
  private readonly file: string;
  private readonly safety: Required<SafetyConfig>;
  /** Session snapshot of listTables(); cleared on writes and refreshSchema(). */
  private tablesCache: TableInfo[] | null = null;
  /** Session snapshot of listRelations(); invalidated together with tablesCache. */
  private relationsCache: ForeignKeyRelation[] | null = null;

  constructor(conn: DatabaseConnection, safety: SafetyConfig = {}) {
    this.safety = {
      allowWrites: safety.allowWrites ?? false,
      maxRows: safety.maxRows ?? 100,
      maxStatements: safety.maxStatements ?? 1,
    };
    this.file = conn.target.replace(/^file:/, '');
    // Prefer Node's built-in node:sqlite (Node >=22.5); fall back to better-sqlite3.
    const req = createRequire(import.meta.url);
    let Database: any;
    try {
      Database = req('node:sqlite').DatabaseSync;
    } catch {
      try {
        Database = req('better-sqlite3');
      } catch {
        throw new Error(
          'No SQLite backend available. Use Node >= 22.5 (node:sqlite) or run: npm install better-sqlite3',
        );
      }
    }
    this.db = new Database(this.file);
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  describeTarget(): string {
    return `sqlite file: ${this.file}`;
  }

  async listTables(): Promise<TableInfo[]> {
    if (this.tablesCache) return cloneTables(this.tablesCache);
    const tables = this.db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string; type: string }[];

    const out: TableInfo[] = [];
    for (const t of tables) {
      let rowCount = 0;
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS c FROM "${escapeIdent(t.name)}"`).get() as {
          c: number;
        };
        rowCount = Number(row.c);
      } catch {
        /* virtual tables etc. — leave estimate 0 */
      }
      out.push({
        name: t.name,
        kind: t.type === 'view' ? 'view' : 'table',
        rowCountEstimate: rowCount,
        columns: this.columnsOf(t.name),
      });
    }
    this.tablesCache = cloneTables(out);
    return out;
  }

  async describeTable(name: string): Promise<TableInfo | null> {
    const cached = findCachedTable(this.tablesCache, name);
    if (cached) return cached;
    const exists = this.db
      .prepare(`SELECT name, type FROM sqlite_master WHERE name = ? AND type IN ('table','view')`)
      .get(name) as { name: string; type: string } | undefined;
    if (!exists) return null;
    return {
      name: exists.name,
      kind: exists.type === 'view' ? 'view' : 'table',
      columns: this.columnsOf(name),
    };
  }

  /** Drop the cached schema snapshot; the next listTables() re-reads sqlite_master. */
  async refreshSchema(): Promise<void> {
    this.tablesCache = null;
    this.relationsCache = null;
  }

  async listRelations(): Promise<ForeignKeyRelation[]> {
    if (this.relationsCache) return cloneRelations(this.relationsCache);
    const tables = this.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as { name: string }[];
    const out: ForeignKeyRelation[] = [];
    for (const t of tables) {
      const fks = this.db.prepare(`PRAGMA foreign_key_list("${escapeIdent(t.name)}")`).all() as {
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }[];
      for (const fk of fks) {
        out.push({
          fromTable: t.name,
          fromColumn: String(fk.from),
          toTable: String(fk.table),
          toColumn: String(fk.to),
          onDelete: String(fk.on_delete ?? ''),
          onUpdate: String(fk.on_update ?? ''),
        });
      }
    }
    out.sort((a, b) =>
      `${a.fromTable}.${a.fromColumn}`.localeCompare(`${b.fromTable}.${b.fromColumn}`),
    );
    this.relationsCache = cloneRelations(out);
    return out;
  }

  async getSchemaGraph(): Promise<SchemaGraph> {
    return buildSchemaGraph(await this.listTables(), await this.listRelations());
  }

  /**
   * SQLite has no stored procedures or functions, but it does have
   * triggers — listed here from sqlite_master (timing/event parsed from
   * the stored CREATE TRIGGER text).
   */
  async listRoutines(): Promise<RoutineInfo[]> {
    const triggers = this.db
      .prepare(
        `SELECT name, tbl_name AS target, sql FROM sqlite_master
          WHERE type = 'trigger' ORDER BY name`,
      )
      .all() as { name: string; target: string; sql: string | null }[];
    return triggers.map((t) => {
      const m = /BEFORE|AFTER|INSTEAD\s+OF/i.exec(t.sql ?? '');
      const e = /\b(INSERT|UPDATE|DELETE)\b/i.exec(t.sql ?? '');
      const timing = m ? m[0].toUpperCase().replace(/\s+/g, ' ') : undefined;
      return {
        name: t.name,
        kind: 'trigger' as const,
        targetTable: String(t.target),
        timing,
        event: e ? e[1].toUpperCase() : undefined,
      };
    });
  }

  async sampleRows(name: string, limit: number): Promise<QueryResult> {
    const capped = Math.max(1, Math.min(limit, this.safety.maxRows));
    return this.executeRead(`SELECT * FROM "${escapeIdent(name)}" LIMIT ${capped}`);
  }

  async execute(sql: string): Promise<QueryResult> {
    const stmt = singleStatement(sql, this.safety.maxStatements);
    if (isWriteStatement(stmt) && !this.safety.allowWrites) {
      throw new Error(
        'Write blocked: session is read-only (enable with --allow-writes or DBAGENT_ALLOW_WRITES=true).',
      );
    }
    if (isWriteStatement(stmt)) {
      const start = Date.now();
      const info = this.db.prepare(stmt).run();
      // Row counts and catalog entries may be stale after a write.
      this.tablesCache = null;
      this.relationsCache = null;
      return {
        columns: ['rowsAffected'],
        rows: [[Number(info.changes ?? 0)]],
        rowCount: Number(info.changes ?? 0),
        durationMs: Date.now() - start,
      };
    }
    return this.executeRead(stmt);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private columnsOf(table: string) {
    const cols = this.db.prepare(`PRAGMA table_info("${escapeIdent(table)}")`).all() as any[];
    return cols.map((c) => ({
      name: String(c.name ?? c.name),
      dataType: String(c.type ?? ''),
      nullable: !c.notnull,
      isPrimaryKey: !!c.pk,
      defaultValue: c.dflt_value ?? null,
    }));
  }

  private executeRead(sql: string): QueryResult {
    const start = Date.now();
    const capped = enforceLimit(sql, this.safety.maxRows, 'sqlite');
    const raw = this.db.prepare(capped).all() as Record<string, unknown>[];
    // node:sqlite returns null-prototype objects; normalize keys via entries.
    const rows = raw.map((r) => ({ ...r }) as Record<string, unknown>);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      columns,
      rows: rows.map((r) => Object.values(r).map(cellToString)),
      rowCount: rows.length,
      durationMs: Date.now() - start,
    };
  }
}

export function escapeIdent(name: string): string {
  return name.replace(/"/g, '""');
}

function cellToString(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<binary ${v.length} bytes>`;
  if (v instanceof Buffer) return `<binary ${v.length} bytes>`;
  return v;
}
