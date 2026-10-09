/**
 * PII masking for agent-facing query results.
 *
 * Detection is column-NAME based (values are never sniffed): a column
 * called `email`, `mobile_number`, `national_code`, … is treated as
 * sensitive. This is intentionally heuristic — documented, tunable in one
 * place, and flagged per column (ColumnInfo.sensitive) so the model knows
 * what it cannot see.
 *
 * Masked cells stay obviously masked (`***`, partial emails/last-4) and
 * every masked result reports `maskedColumns`, so the agent can tell the
 * user what was hidden instead of reasoning on redacted data.
 */

export type PiiCategory = 'email' | 'phone' | 'national_id' | 'ssn' | 'card' | 'iban' | 'secret';

/** Split a column name into lowercase tokens (snake_case + camelCase). */
function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Category of a sensitive column, or null. Token-based (not substring) so
 * `id`, `unit_id` or `sender` never match while `email`, `mobile_number`
 * and `national_code` do.
 */
export function classifyPiiColumn(name: string): PiiCategory | null {
  const tokens = tokensOf(name);
  if (tokens.length === 0) return null;
  const squash = tokens.join('');
  const has = (...wanted: string[]) => tokens.some((t) => wanted.includes(t));
  const contains = (part: string) => tokens.some((t) => t.includes(part));

  if (squash.includes('email') || has('mail')) return 'email';
  if (has('phone', 'mobile', 'tel', 'cell', 'fax', 'msisdn', 'landline')) return 'phone';
  if (has('ssn') || contains('socialsec')) return 'ssn';
  if (contains('national') || contains('melli') || has('nid')) return 'national_id';
  if (
    has('pan', 'cvv', 'cvc', 'card') ||
    tokens.some((t) => t.endsWith('card')) ||
    (squash.includes('card') && !squash.includes('cardboard')) ||
    contains('credit')
  ) {
    return 'card';
  }
  if (contains('iban')) return 'iban';
  if (
    has('password', 'passwd', 'pwd', 'secret', 'token', 'passcode') ||
    (has('api') && has('key')) ||
    contains('passwd') ||
    contains('secret') ||
    contains('apikey')
  ) {
    return 'secret';
  }
  return null;
}

/** True when the column should be masked in agent-facing results. */
export function isSensitiveColumn(name: string): boolean {
  return classifyPiiColumn(name) !== null;
}

/**
 * Mask one cell. Non-strings pass through unless the column is sensitive
 * and the value is a number (phone/card stored numeric) — then it is
 * masked as a string. null/undefined/'' are left alone.
 */
export function maskValue(column: string, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  const category = classifyPiiColumn(column);
  if (!category) return value;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return value;
  }
  const raw = String(value);
  switch (category) {
    case 'secret':
      return '***';
    case 'email': {
      const at = raw.indexOf('@');
      if (at <= 0) return '***';
      return `${raw[0]}***@${raw.slice(at + 1)}`;
    }
    case 'phone':
    case 'card':
    case 'national_id':
    case 'ssn':
    case 'iban':
      return raw.length > 4 ? `***${raw.slice(-4)}` : '***';
  }
}

/**
 * Mask the sensitive columns of a result set. Returns the masked rows plus
 * the column names that were hidden (empty when nothing matched).
 */
export function maskResult(
  columns: string[],
  rows: unknown[][],
): { rows: unknown[][]; maskedColumns: string[] } {
  const sensitiveIdx = new Set<number>();
  const maskedColumns: string[] = [];
  columns.forEach((c, i) => {
    if (isSensitiveColumn(c)) {
      sensitiveIdx.add(i);
      maskedColumns.push(c);
    }
  });
  if (sensitiveIdx.size === 0) return { rows, maskedColumns };
  return {
    rows: rows.map((row) =>
      row.map((cell, i) => (sensitiveIdx.has(i) ? maskValue(columns[i], cell) : cell)),
    ),
    maskedColumns,
  };
}
