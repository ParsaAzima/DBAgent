/**
 * Shared schema-cache helpers for database drivers.
 *
 * list_tables() is the most expensive introspection call (SQLite runs
 * COUNT(*) per table; server dialects hit information_schema / catalog
 * views plus one column query per table). Every driver therefore caches
 * the full TableInfo[] for the session; the agent refreshes it explicitly
 * via the refresh_schema tool when DDL happens outside the session.
 */

import type { TableInfo } from '../core/types.js';

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
