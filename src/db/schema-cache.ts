/**
 * Shared schema-cache helpers for database drivers.
 *
 * list_tables() is the most expensive introspection call (SQLite runs
 * COUNT(*) per table; server dialects hit information_schema / catalog
 * views plus one column query per table). Every driver therefore caches
 * the full TableInfo[] for the session; the agent refreshes it explicitly
 * via the refresh_schema tool when DDL happens outside the session.
 */

import type { ForeignKeyRelation, SchemaGraph, TableInfo } from '../core/types.js';

/** Deep copy so callers cannot mutate the cached entry. */
export function cloneTables(tables: TableInfo[]): TableInfo[] {
  return tables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => ({ ...c })),
  }));
}

/**
 * Find a table in a cached list_tables() result.
 * Accepts bare ("users"), schema-qualified ("public.users",
 * "dbo.Customers", "[dbo].[Customers]") and case-insensitive names.
 */
export function findCachedTable(cache: TableInfo[] | null, name: string): TableInfo | null {
  if (!cache) return null;
  const want = normalizeTableName(name);
  for (const t of cache) {
    if (normalizeTableName(t.name) === want) {
      return { ...t, columns: t.columns.map((c) => ({ ...c })) };
    }
    if (t.schema && normalizeTableName(`${t.schema}.${t.name}`) === want) {
      return { ...t, columns: t.columns.map((c) => ({ ...c })) };
    }
  }
  return null;
}

function normalizeTableName(name: string): string {
  return name
    .trim()
    .replace(/["`[\]]/g, '')
    .toLowerCase();
}

/** Deep copy so callers cannot mutate the cached relations. */
export function cloneRelations(relations: ForeignKeyRelation[]): ForeignKeyRelation[] {
  return relations.map((r) => ({ ...r }));
}

function qualified(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

/**
 * Build the FK graph: pass-through edges plus the tables that have no
 * edges (sorted, schema-qualified when applicable).
 */
export function buildSchemaGraph(
  tables: TableInfo[],
  relations: ForeignKeyRelation[],
): SchemaGraph {
  const touched = new Set<string>();
  for (const r of relations) {
    touched.add(qualified(r.fromSchema, r.fromTable).toLowerCase());
    touched.add(qualified(r.toSchema, r.toTable).toLowerCase());
  }
  const isolatedTables = tables
    .map((t) => qualified(t.schema, t.name))
    .filter((n) => !touched.has(n.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  return { relations: cloneRelations(relations), isolatedTables };
}

/**
 * Compact one-line-per-edge rendering for the system prompt, e.g.
 * `orders.customer_id -> customers.id`. Capped at maxRelations edges.
 */
export function formatSchemaGraph(graph: SchemaGraph, maxRelations = 40): string {
  const lines = graph.relations
    .slice(0, maxRelations)
    .map(
      (r) =>
        `${qualified(r.fromSchema, r.fromTable)}.${r.fromColumn} -> ${qualified(r.toSchema, r.toTable)}.${r.toColumn}`,
    );
  if (graph.relations.length > maxRelations) {
    lines.push(`… and ${graph.relations.length - maxRelations} more (call get_schema_graph)`);
  }
  if (graph.isolatedTables.length > 0) {
    lines.push(`Isolated (no FK edges): ${graph.isolatedTables.slice(0, 20).join(', ')}`);
  }
  return lines.join('\n');
}
