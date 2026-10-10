/**
 * TOML configuration file (dbagent.toml).
 *
 * The professional home for all DBAgent settings — one typed file instead of
 * a pile of flat env vars. Resolution order for every setting:
 *
 *   CLI flags  >  environment variables (.env included, legacy)  >  dbagent.toml  >  built-in defaults
 *
 * File lookup: --config <path>  >  $DBAGENT_CONFIG  >  ./dbagent.toml  >  ~/.dbagent/config.toml.
 * Missing files are silently ignored (env/flags-only setups keep working);
 * an explicitly requested file that does not exist is a hard error.
 *
 * Secrets: values support ${VAR} and ${VAR:-fallback} interpolation, so the
 * file can reference the environment instead of storing keys in plain text:
 *
 *   [llm]
 *   api_key = "${OPENROUTER_API_KEY}"
 *
 * The file never overrides the real environment — it only backfills
 * variables that are unset, so container/CI env keeps working unchanged.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseDdlMode, parseProvider } from './config.js';
import { loadCustomProviders } from './custom-providers.js';

export const CONFIG_FILE_NAME = 'dbagent.toml';

/** Load a config file and backfill unset env vars. Returns the path used, if any. */
export function initFileConfig(explicitPath?: string): string | undefined {
  const path = findConfigFile(explicitPath);
  if (!path) return undefined;
  const doc = readConfigDoc(path);
  applyFileDefaults(validateConfigDoc(doc, path));
  return path;
}

/**
 * Resolve which config file to load, without reading it.
 * Throws when an explicitly requested file does not exist.
 */
export function findConfigFile(explicit?: string): string | undefined {
  if (explicit?.trim()) {
    const p = resolve(explicit.trim());
    if (!existsSync(p)) throw new Error(`Config file not found: ${explicit} (from --config).`);
    return p;
  }
  const fromEnv = process.env.DBAGENT_CONFIG?.trim();
  if (fromEnv) {
    const p = resolve(fromEnv);
    if (!existsSync(p)) throw new Error(`Config file not found: ${fromEnv} (from DBAGENT_CONFIG).`);
    return p;
  }
  const cwd = join(process.cwd(), CONFIG_FILE_NAME);
  if (existsSync(cwd)) return cwd;
  const home = join(homedir(), '.dbagent', 'config.toml');
  if (existsSync(home)) return home;
  return undefined;
}

/** Parse raw TOML text, wrapping syntax errors with the file path. */
export function readConfigDoc(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  try {
    const doc = parseToml(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('top-level value must be sections like [llm]');
    }
    return doc as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid TOML in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ───────────────────────── validation ───────────────────────── */

type Scalar = 'string' | 'number' | 'boolean';
interface TableSpec {
  [key: string]: Scalar | TableSpec;
}

/** The full config schema: section → key → expected type. */
const CONFIG_SCHEMA: Record<string, TableSpec> = {
  llm: {
    provider: 'string',
    model: 'string',
    temperature: 'number',
    max_output_tokens: 'number',
    api_key: 'string',
    base_url: 'string',
    openrouter: { site_url: 'string', app_name: 'string' },
    gemini: { api_version: 'string' },
  },
  database: { url: 'string' },
  safety: {
    allow_writes: 'boolean',
    allow_system: 'boolean',
    allow_shell: 'boolean',
    assume_yes: 'boolean',
    allow_ddl: 'string',
    mask_pii: 'boolean',
  },
  schema: { embed_model: 'string', large_tables: 'number' },
  limits: { max_rows: 'number', max_rounds: 'number', timeout_ms: 'number' },
  output: { dir: 'string', audit_file: 'string', allow_any_path: 'boolean' },
};

/** Validated file content: section → dotted key → raw value. */
export type FileConfig = Record<string, Record<string, unknown>>;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTableSpec(v: Scalar | TableSpec): v is TableSpec {
  return typeof v === 'object';
}

/** Closest-match suggestion for a likely typo ("did you mean …?"). */
function suggest(want: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Math.max(2, Math.floor(want.length / 3));
  for (const opt of options) {
    const score = levenshtein(want, opt);
    if (score <= bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = next;
    }
  }
  return prev[b.length];
}

function fail(path: string, where: string, msg: string): never {
  throw new Error(`${path}: ${where} ${msg}`);
}

/** Strict-shape validation: unknown sections/keys and mistyped values fail fast with hints. */
export function validateConfigDoc(doc: Record<string, unknown>, path: string): FileConfig {
  const out: FileConfig = {};
  for (const [section, value] of Object.entries(doc)) {
    const spec = CONFIG_SCHEMA[section];
    if (!spec) {
      const hint = suggest(section, Object.keys(CONFIG_SCHEMA));
      fail(path, `[${section}]`, `unknown section.${hint ? ` Did you mean [${hint}]?` : ''}`);
    }
    if (!isPlainRecord(value)) {
      fail(path, `[${section}]`, 'must be a table of key = value pairs.');
    }
    out[section] = validateTable(value, spec, path, `[${section}]`);
  }
  // Semantic checks with file context.
  const provider = out.llm?.provider;
  if (
    provider !== undefined &&
    !parseProvider(String(provider)) &&
    !loadCustomProviders()[String(provider)]
  ) {
    fail(
      path,
      '[llm] provider =',
      `"${provider}" — expected one of the built-in providers or a configured custom provider.`,
    );
  }
  const ddl = out.safety?.allow_ddl;
  if (ddl !== undefined) {
    try {
      parseDdlMode(typeof ddl === 'string' ? ddl : String(ddl));
    } catch {
      fail(path, '[safety] allow_ddl =', `"${ddl}" — expected off, dry-run, or on.`);
    }
  }
  return out;
}

function validateTable(
  table: Record<string, unknown>,
  spec: TableSpec,
  path: string,
  where: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    const expected = spec[key];
    if (!expected) {
      const hint = suggest(key, Object.keys(spec));
      fail(path, `${where} "${key}"`, `unknown key.${hint ? ` Did you mean "${hint}"?` : ''}`);
    }
    if (isTableSpec(expected)) {
      if (!isPlainRecord(value)) fail(path, `${where} "${key}"`, 'must be a table.');
      out[key] = validateTable(value, expected, path, `${where}.${key}`);
    } else if (typeof value !== expected) {
      fail(path, `${where} "${key}"`, `must be a ${expected}, got ${describe(value)}.`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/* ─────────────────── env interpolation ─────────────────── */

/** Expand ${VAR} / ${VAR:-fallback} in every string of the validated doc. */
export function interpolateEnvStrings(cfg: FileConfig): FileConfig {
  const out: FileConfig = {};
  for (const [section, table] of Object.entries(cfg)) {
    out[section] = Object.fromEntries(
      Object.entries(table).map(([key, value]) => [key, interpolateValue(value)]),
    );
  }
  return out;
}

function interpolateValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_, name: string, fallback: string | undefined) => process.env[name] ?? fallback ?? '',
    );
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateValue(v)]));
  }
  return value;
}

/* ─────────────────── backfill into env ─────────────────── */

/** TOML path → env var. api_key/base_url map to the generic pair honored for any provider. */
const ENV_MAP: Array<[string[], string, 'string' | 'number' | 'boolean']> = [
  [['llm', 'provider'], 'DBAGENT_PROVIDER', 'string'],
  [['llm', 'model'], 'DBAGENT_MODEL', 'string'],
  [['llm', 'temperature'], 'DBAGENT_TEMPERATURE', 'number'],
  [['llm', 'max_output_tokens'], 'DBAGENT_MAX_OUTPUT_TOKENS', 'number'],
  [['llm', 'api_key'], 'DBAGENT_API_KEY', 'string'],
  [['llm', 'base_url'], 'DBAGENT_BASE_URL', 'string'],
  [['llm', 'openrouter', 'site_url'], 'OPENROUTER_SITE_URL', 'string'],
  [['llm', 'openrouter', 'app_name'], 'OPENROUTER_APP_NAME', 'string'],
  [['llm', 'gemini', 'api_version'], 'GEMINI_API_VERSION', 'string'],
  [['database', 'url'], 'DBAGENT_DB_URL', 'string'],
  [['safety', 'allow_writes'], 'DBAGENT_ALLOW_WRITES', 'boolean'],
  [['safety', 'allow_system'], 'DBAGENT_ALLOW_SYSTEM', 'boolean'],
  [['safety', 'allow_shell'], 'DBAGENT_ALLOW_SHELL', 'boolean'],
  [['safety', 'assume_yes'], 'DBAGENT_ASSUME_YES', 'boolean'],
  [['safety', 'allow_ddl'], 'DBAGENT_ALLOW_DDL', 'string'],
  [['safety', 'mask_pii'], 'DBAGENT_MASK_PII', 'boolean'],
  [['schema', 'embed_model'], 'DBAGENT_EMBED_MODEL', 'string'],
  [['schema', 'large_tables'], 'DBAGENT_LARGE_SCHEMA_TABLES', 'number'],
  [['limits', 'max_rows'], 'DBAGENT_MAX_ROWS', 'number'],
  [['limits', 'max_rounds'], 'DBAGENT_MAX_ROUNDS', 'number'],
  [['limits', 'timeout_ms'], 'DBAGENT_TIMEOUT_MS', 'number'],
  [['output', 'dir'], 'DBAGENT_OUT_DIR', 'string'],
  [['output', 'audit_file'], 'DBAGENT_AUDIT_FILE', 'string'],
  [['output', 'allow_any_path'], 'DBAGENT_ANY_PATH', 'boolean'],
];

function lookup(cfg: FileConfig, path: string[]): unknown {
  let node: unknown = cfg;
  for (const part of path) {
    if (!isPlainRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Copy file values into process.env wherever the variable is still unset.
 * The real environment always wins; empty strings are skipped so commented
 * placeholders like `base_url = ""` never clobber built-in defaults.
 */
export function applyFileDefaults(cfg: FileConfig): void {
  const interpolated = interpolateEnvStrings(cfg);
  for (const [tomlPath, envVar, kind] of ENV_MAP) {
    if (envVar in process.env) continue;
    const raw = lookup(interpolated, tomlPath);
    if (raw === undefined) continue;
    let text: string;
    if (kind === 'boolean') text = raw ? '1' : '0';
    else if (kind === 'number') text = String(raw);
    else text = String(raw).trim();
    if (text === '') continue;
    process.env[envVar] = text;
  }
}
