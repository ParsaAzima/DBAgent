/**
 * Configuration loading.
 *
 * Sources, in order of precedence:
 *   1. CLI flags
 *   2. environment variables (.env loaded manually — no extra dependency)
 *   3. built-in defaults
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMProviderConfig, LLMProviderId } from './types.js';

/** Built-in model defaults; overridable via CLI flag / env. */
export const DEFAULT_MODELS: Record<LLMProviderId, string> = {
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.1',
};

const PROVIDER_IDS: LLMProviderId[] = ['openai', 'openrouter', 'anthropic', 'gemini', 'ollama'];

export interface ResolvedConfig {
  provider: LLMProviderId;
  llm: LLMProviderConfig;
  dbUrl: string;
  allowWrites: boolean;
  allowSystem: boolean;
  allowShell: boolean;
  maxRows: number;
  maxRounds: number;
  timeoutMs: number;
}

/**
 * Minimal .env loader (KEY=VALUE per line; quotes tolerated; `#` comments).
 * Real environment variables always win over the file.
 */
export function loadDotEnv(dir: string = process.cwd()): void {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function parseProvider(value: string | undefined): LLMProviderId | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().trim();
  const found = PROVIDER_IDS.find((p) => p === v);
  return found;
}

export function resolveConfig(opts: {
  providerFlag?: string;
  modelFlag?: string;
  dbUrlFlag?: string;
  allowWritesFlag?: boolean;
  allowSystemFlag?: boolean;
  allowShellFlag?: boolean;
  maxRowsFlag?: number;
}): ResolvedConfig {
  const provider = parseProvider(opts.providerFlag ?? process.env.DBAGENT_PROVIDER) ?? 'openai';

  const llm: LLMProviderConfig = {
    id: provider,
    model:
      opts.modelFlag ??
      process.env.DBAGENT_MODEL ??
      DEFAULT_MODELS[provider],
    temperature: num(process.env.DBAGENT_TEMPERATURE, 0.1),
    maxOutputTokens: num(process.env.DBAGENT_MAX_OUTPUT_TOKENS, 2048),
    apiKey: apiKeyFor(provider),
    baseUrl: baseUrlFor(provider),
    apiVersion: process.env.GEMINI_API_VERSION,
  };

  const dbUrl = opts.dbUrlFlag ?? process.env.DBAGENT_DB_URL;
  if (!dbUrl) {
    throw new Error(
      'No database configured. Pass --db <url> or set DBAGENT_DB_URL (e.g. sqlite://./app.db, postgres://user:pass@host:5432/db).',
    );
  }

  return {
    provider,
    llm,
    dbUrl,
    allowWrites: opts.allowWritesFlag ?? bool(process.env.DBAGENT_ALLOW_WRITES, false),
    allowSystem: opts.allowSystemFlag ?? bool(process.env.DBAGENT_ALLOW_SYSTEM, false),
    allowShell: opts.allowShellFlag ?? bool(process.env.DBAGENT_ALLOW_SHELL, false),
    maxRows: opts.maxRowsFlag ?? num(process.env.DBAGENT_MAX_ROWS, 100),
    maxRounds: num(process.env.DBAGENT_MAX_ROUNDS, 12),
    timeoutMs: num(process.env.DBAGENT_TIMEOUT_MS, 120_000),
  };
}

function apiKeyFor(provider: LLMProviderId): string | undefined {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'gemini':
      return process.env.GEMINI_API_KEY;
    case 'ollama':
      return undefined; // local, no key
  }
}

function baseUrlFor(provider: LLMProviderId): string | undefined {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_BASE_URL;
    case 'openrouter':
      return process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api';
    case 'anthropic':
      return process.env.ANTHROPIC_BASE_URL;
    case 'gemini':
      return undefined; // uses per-request version path
    case 'ollama':
      return process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  }
}

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export { PROVIDER_IDS };
