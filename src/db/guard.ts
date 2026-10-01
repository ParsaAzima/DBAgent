/**
 * Shared SQL guardrails used by every database driver.
 */

import type { DatabaseDialect } from '../core/types.js';

const READ_KEYWORD = /^(WITH|SELECT|PRAGMA|SHOW|EXPLAIN|DESCRIBE|TABLE)\b/i;
const WRITE_KEYWORD =
  /^(INSERT|UPDATE|DELETE|MERGE|REPLACE|GRANT|REVOKE|VACUUM|ANALYZE|REINDEX)\b/i;
const DDL_KEYWORD = /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|LOCK)\b/i;

export type StatementKind = 'read' | 'write' | 'ddl' | 'other';

/** Strip comments and collapse whitespace so keyword checks see real SQL. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
}

export function classifyStatement(sql: string): StatementKind {
  const s = normalizeSql(sql);
  if (READ_KEYWORD.test(s)) return 'read';
  if (WRITE_KEYWORD.test(s)) return 'write';
  if (DDL_KEYWORD.test(s)) return 'ddl';
  return 'other';
}

export function isWriteStatement(sql: string): boolean {
  const kind = classifyStatement(sql);
  return kind === 'write' || kind === 'ddl';
}

/** Enforce "one statement per call" by rejecting semicolon-chained SQL. */
export function singleStatement(sql: string, maxStatements: number): string {
  const s = normalizeSql(sql);
  if (s.endsWith(';')) {
    // A single trailing semicolon is fine.
    const without = s.slice(0, -1).trim();
    if (!without.includes(';')) return without;
  }
  const count = (s.match(/;/g) ?? []).length + (s.endsWith(';') ? 0 : 1);
  if (count > maxStatements) {
    throw new Error(
      `Only ${maxStatements} statement per call is allowed (got ~${count}). Remove chained statements.`,
    );
  }
  return s;
}

/**
 * Wrap or cap a read query with a hard LIMIT.
 * - SELECT without LIMIT → append LIMIT n
 * - WITH ... SELECT → wrap in SELECT * FROM (...) LIMIT n
 */
export function enforceLimit(sql: string, maxRows: number, dialect: DatabaseDialect): string {
  const s = normalizeSql(sql).replace(/;+\s*$/, '');
  if (!READ_KEYWORD.test(s)) return s;

  if (/^SELECT\b/i.test(s) && !/\bLIMIT\s+\d+/i.test(s)) {
    return `${s}\nLIMIT ${maxRows}`;
  }
  if (/^WITH\b/i.test(s) && !/\bLIMIT\s+\d+/i.test(s)) {
    const q = dialect === 'mysql' ? '`' : '"';
    return `SELECT * FROM (${s}) AS ${q}dbagent_limited${q} LIMIT ${maxRows}`;
  }
  return s;
}
