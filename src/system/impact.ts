/**
 * Heuristic impact estimates for write confirmation.
 *
 * A database cannot report affected rows before running a statement, so
 * this module answers the next-best question with read-only probes:
 *   UPDATE/DELETE + simple WHERE → SELECT COUNT(*) over the same predicate
 *   INSERT … VALUES (…)          → tuple count from the VALUES list
 * Anything else → "unknown". Every line is prefixed with "est." and the
 * operator always sees the full SQL next to it.
 */

import type { DatabaseDriver } from '../core/types.js';
import { classifyStatement, normalizeSql } from '../db/guard.js';

/** Tables referenced by a write, best-effort (used for the confirm prompt). */
export function extractWriteTables(sql: string): string[] {
  const s = normalizeSql(sql);
  const out: string[] = [];
  const patterns = [
    /\bUPDATE\s+([^\s(,;]+)/i,
    /\bDELETE\s+FROM\s+([^\s(,;]+)/i,
    /\bINSERT\s+INTO\s+([^\s(,;]+)/i,
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([^\s(,;]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) out.push(m[1].replace(/["`[\]]/g, ''));
  }
  return [...new Set(out)];
}

/** True for UPDATE/DELETE without a WHERE clause (whole-table write). */
export function hasNoWhere(sql: string): boolean {
  const s = normalizeSql(sql);
  return /^(UPDATE|DELETE)\b/i.test(s) && !/\bWHERE\b/i.test(s);
}

function extractWhere(sql: string): string | null {
  const m =
    /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|\bRETURNING\b|\bFETCH\b|;?\s*$)/i.exec(
      normalizeSql(sql),
    );
  const cond = m?.[1]?.trim();
  return cond ? cond : null;
}

/** Count top-level (...) tuples in an INSERT … VALUES list. */
function countValueTuples(valuesList: string): number | null {
  let depth = 0;
  let tuples = 0;
  let inStr: string | null = null;
  let hasContent = false;
  for (let i = 0; i < valuesList.length; i++) {
    const ch = valuesList[i];
    if (inStr) {
      if (ch === inStr) {
        if (valuesList[i + 1] === inStr) i++;
        else inStr = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      if (depth === 1) hasContent = true;
      inStr = ch;
    } else if (ch === '(') {
      if (depth === 0) hasContent = false;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && hasContent) tuples++;
      if (depth < 0) return null;
    } else if (depth === 1 && ch.trim() !== '' && ch !== ',') {
      hasContent = true;
    }
  }
  return depth === 0 && tuples > 0 ? tuples : null;
}

/**
 * One-line impact estimate for the confirmation prompt.
 * Runs at most one read-only COUNT probe; never throws.
 */
export async function estimateWriteImpact(
  db: DatabaseDriver,
  sql: string,
): Promise<string | undefined> {
  try {
    const s = normalizeSql(sql);
    const kind = classifyStatement(s);
    if (kind === 'read') return undefined;

    const updateMatch = /^\s*UPDATE\s+([^\s(,;]+)/i.exec(s);
    const deleteMatch = /^\s*DELETE\s+FROM\s+([^\s(,;]+)/i.exec(s);
    const target = updateMatch?.[1] ?? deleteMatch?.[1];
    if (target) {
      const where = extractWhere(s);
      if (!where) return 'est. whole table (no WHERE clause)';
      const probe = `SELECT COUNT(*) AS c FROM ${target} WHERE ${where}`;
      const res = await db.execute(probe);
      const n = Number(res.rows?.[0]?.[0]);
      return Number.isFinite(n) ? `est. ${n} row(s) match WHERE` : undefined;
    }

    const insertMatch =
      /^\s*INSERT\s+INTO\s+[^\s(,;]+\s*(?:\([^)]*\))?\s*VALUES\s*([\s\S]*?);?\s*$/i.exec(s);
    if (insertMatch) {
      const n = countValueTuples(insertMatch[1]);
      return n != null ? `est. ${n} new row(s)` : 'est. new rows (VALUES list not parseable)';
    }
    if (/^\s*INSERT\b/i.test(s)) return 'est. new rows (INSERT…SELECT, count unknown)';
    if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(s)) {
      return 'schema change (no rows modified; slows writes, speeds reads)';
    }
    return undefined;
  } catch {
    return undefined;
  }
}
