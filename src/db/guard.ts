/**
 * Shared SQL guardrails used by every database driver.
 */

import type { DatabaseDialect, DdlMode } from '../core/types.js';

const READ_KEYWORD = /^(WITH|SELECT|PRAGMA|SHOW|EXPLAIN|DESCRIBE|TABLE)\b/i;
const WRITE_KEYWORD =
  /^(INSERT|UPDATE|DELETE|MERGE|REPLACE|GRANT|REVOKE|VACUUM|ANALYZE|REINDEX)\b/i;
const DDL_KEYWORD = /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|LOCK)\b/i;

export type { DdlMode };

/** DROP/ALTER/TRUNCATE/RENAME are never executed, in any mode. */
const DESTRUCTIVE_DDL = /^(DROP|ALTER|TRUNCATE|RENAME)\b/i;

/** The only DDL the agent may run (gated by ddlMode + write mode + confirm). */
const CREATE_INDEX = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i;

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
  if (/^SELECT\b[\s\S]*?\bFOR\s+UPDATE\b/i.test(bare)) return true;
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

/** True for DROP/ALTER/TRUNCATE/RENAME — blocked in every mode. */
export function isDestructiveDdl(sql: string): boolean {
  return DESTRUCTIVE_DDL.test(normalizeSql(sql));
}

/** True for CREATE [UNIQUE] INDEX — the only executable DDL. */
export function isCreateIndex(sql: string): boolean {
  return CREATE_INDEX.test(normalizeSql(sql));
}

/**
 * Driver-level DDL gate. Call after singleStatement(), before any other
 * check: destructive DDL is refused in every mode, non-INDEX DDL is
 * refused, and CREATE INDEX requires ddlMode 'on' plus write mode.
 * Reads and plain writes pass through untouched.
 */
export function assertDdlAllowed(
  stmt: string,
  safety: { allowWrites: boolean; ddlMode: DdlMode },
): void {
  if (isDestructiveDdl(stmt)) {
    throw new Error(
      'Destructive DDL blocked: DROP/ALTER/TRUNCATE/RENAME are never executed by the agent, in any mode.',
    );
  }
  if (classifyStatement(stmt) !== 'ddl') return;
  if (!isCreateIndex(stmt)) {
    throw new Error(
      'DDL blocked: only CREATE INDEX is supported (analyze with propose_index; apply with apply_ddl under --allow-ddl=on).',
    );
  }
  if (safety.ddlMode !== 'on') {
    throw new Error(
      safety.ddlMode === 'dry-run'
        ? 'DDL dry-run: CREATE INDEX is analyzed via propose_index but never executed. Re-run with --allow-ddl=on plus human confirmation to apply it.'
        : 'DDL disabled: CREATE INDEX needs --allow-ddl=dry-run (analyze only) or --allow-ddl=on (apply after human confirmation).',
    );
  }
  if (!safety.allowWrites) {
    throw new Error('DDL needs write mode too: pass --allow-writes alongside --allow-ddl=on.');
  }
}

/**
 * Parse an index definition for analysis/display. Returns null when the
 * SQL is not a CREATE INDEX statement.
 */
export function parseCreateIndex(sql: string): {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
} | null {
  const m =
    /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s+ON\s+([^\s(,;]+)\s*\(([^)]+)\)/i.exec(
      normalizeSql(sql),
    );
  if (!m) return null;
  const clean = (s: string) =>
    s
      .trim()
      .replace(/["`[\]]/g, '')
      .replace(/\s+(ASC|DESC)$/i, '');
  const columns = m[4].split(',').map(clean).filter(Boolean);
  if (columns.length === 0) return null;
  return { name: clean(m[2]), table: clean(m[3]), columns, unique: !!m[1] };
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
  if (dialect === 'oracle') return oracleLimit(s, maxRows);

  if (/^SELECT\b/i.test(s) && !/\bLIMIT\s+\d+/i.test(s)) {
    return `${s}\nLIMIT ${maxRows}`;
  }

  function oracleLimit(sql: string, maxRows: number): string {
    if (!/^(SELECT|WITH)\b/i.test(sql)) return sql;
    if (/\b(FETCH\s+(?:FIRST|NEXT)|ROWNUM)\b/i.test(sql)) return sql;
    return `${sql}\nFETCH FIRST ${maxRows} ROWS ONLY`;
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
    return /\bORDER\s+BY\b/i.test(s)
      ? page
      : `SELECT TOP (${maxRows}) * FROM (\n${s}\n) AS dbagent_limited`;
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
