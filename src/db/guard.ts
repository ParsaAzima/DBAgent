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

/**
 * Blank out string literals and quoted identifiers so keyword scans inspect
 * SQL structure, not data ('I moved it into the archive').
 */
function stripLiterals(s: string): string {
  return s
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\[(?:\]\]|[^\]])*\]/g, '[x]')
    .replace(/`(?:``|[^`])*`/g, '`x`')
    .replace(/"(?:[^"]|"")*"/g, '"x"');
}

/**
 * Detect statements that start with a read keyword but still write data:
 *   SELECT ... INTO new_table          (PostgreSQL / T-SQL CREATE TABLE AS SELECT)
 *   WITH cte AS (...) INSERT/UPDATE/DELETE/MERGE ...
 * Both are real writes and must be blocked in read-only mode.
 */
function isDisguisedWrite(s: string): boolean {
  const bare = stripLiterals(s);
  if (/^SELECT\b[\s\S]*?\bINTO\b/i.test(bare)) return true;
  if (/^\s*WITH\b/i.test(bare)) {
    return /\)\s*(?:INSERT|UPDATE|DELETE|MERGE|EXEC(?:UTE)?)\b/i.test(bare);
  }
  return false;
}

export function classifyStatement(sql: string): StatementKind {
  const s = normalizeSql(sql);
  if (READ_KEYWORD.test(s)) return isDisguisedWrite(s) ? 'write' : 'read';
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
 * Wrap or cap a read query with a hard LIMIT (dialect-specific):
 * - LIMIT dialects: SELECT without LIMIT → append LIMIT n;
 *   WITH ... SELECT → wrap in SELECT * FROM (...) LIMIT n
 * - SQL Server: SELECT TOP (n) / OFFSET-FETCH — see tsqlLimit()
 */
export function enforceLimit(sql: string, maxRows: number, dialect: DatabaseDialect): string {
  const s = normalizeSql(sql).replace(/;+\s*$/, '');
  if (!READ_KEYWORD.test(s)) return s;

  if (dialect === 'sqlserver') return tsqlLimit(s, maxRows);

  if (/^SELECT\b/i.test(s) && !/\bLIMIT\s+\d+/i.test(s)) {
    return `${s}\nLIMIT ${maxRows}`;
  }
  if (/^WITH\b/i.test(s) && !/\bLIMIT\s+\d+/i.test(s)) {
    const q = dialect === 'mysql' ? '`' : '"';
    return `SELECT * FROM (${s}) AS ${q}dbagent_limited${q} LIMIT ${maxRows}`;
  }
  return s;
}

/**
 * Cap a T-SQL read query — SQL Server has no LIMIT clause:
 *   plain SELECT        → SELECT TOP (n) ...
 *   ORDER BY / set ops  → OFFSET 0 ROWS FETCH NEXT n ROWS ONLY (appended)
 *   CTE without ORDER BY→ wrap in a derived table with TOP (n)
 */
function tsqlLimit(s: string, maxRows: number): string {
  // Already bounded by TOP (n) or an OFFSET/FETCH page.
  if (/\bTOP\s*\(\s*\d+\s*\)/i.test(s) || /\bTOP\s+\d+\b/i.test(s)) return s;
  if (/\bOFFSET\s+\d+\s+ROWS\b/i.test(s)) return s;

  const page = `${s}\nOFFSET 0 ROWS FETCH NEXT ${maxRows} ROWS ONLY`;

  if (/^WITH\b/i.test(s)) {
    // ORDER BY is illegal inside a derived table without TOP, so page instead.
    return /\bORDER\s+BY\b/i.test(s) ? page : `SELECT TOP (${maxRows}) * FROM (\n${s}\n) AS dbagent_limited`;
  }
  if (/^SELECT\b/i.test(s)) {
    // TOP only caps the first branch of UNION/INTERSECT/EXCEPT — page or wrap instead.
    if (/\b(UNION|INTERSECT|EXCEPT)\b/i.test(s)) {
      return /\bORDER\s+BY\b/i.test(s)
        ? page
        : `SELECT TOP (${maxRows}) * FROM (\n${s}\n) AS dbagent_limited`;
    }
    // SELECT [ALL|DISTINCT] TOP (n) ... — TOP must follow DISTINCT/ALL.
    return s.replace(/^SELECT\s+(?:(?:ALL|DISTINCT)\s+)?/i, (m) => `${m}TOP (${maxRows}) `);
  }
  return s; // EXPLAIN and friends — leave untouched
}
