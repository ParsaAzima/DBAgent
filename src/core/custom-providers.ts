import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CustomProvider {
  name: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyEnv?: string;
}

const PROVIDERS_FILE = join(homedir(), '.dbagent', 'providers.json');
const BUILT_IN_NAMES = new Set(['openai', 'openrouter', 'anthropic', 'gemini', 'ollama', 'custom']);

export function loadCustomProviders(path = PROVIDERS_FILE): Record<string, CustomProvider> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read custom providers at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid custom providers file at ${path}: expected a JSON object.`);
  }
  const result: Record<string, CustomProvider> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!isCustomProviderName(name) || !isProvider(value) || value.name !== name) {
      throw new Error(`Invalid custom provider "${name}" in ${path}.`);
    }
    validateProvider(value);
    result[name] = value;
  }
  return result;
}

export function saveCustomProvider(provider: CustomProvider, path = PROVIDERS_FILE): void {
  validateProvider(provider);
  const providers = loadCustomProviders(path);
  providers[provider.name] = provider;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(providers, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export function removeCustomProvider(name: string, path = PROVIDERS_FILE): boolean {
  const providers = loadCustomProviders(path);
  if (!providers[name]) return false;
  delete providers[name];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(providers, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return true;
}

function isCustomProviderName(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(name) && !BUILT_IN_NAMES.has(name);
}

function isProvider(value: unknown): value is CustomProvider {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const provider = value as Record<string, unknown>;
  return (
    typeof provider.name === 'string' &&
    typeof provider.baseUrl === 'string' &&
    typeof provider.defaultModel === 'string' &&
    (provider.apiKeyEnv === undefined || typeof provider.apiKeyEnv === 'string')
  );
}

function validateProvider(provider: CustomProvider): void {
  if (!isCustomProviderName(provider.name)) {
    throw new Error(
      'Provider name must start with a letter and contain only lowercase letters, numbers, or hyphens.',
    );
  }
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new Error('Custom provider base URL must be an absolute HTTP or HTTPS URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Custom provider base URL must be HTTP(S) without embedded credentials, query, or fragment.',
    );
  }
  if (!provider.defaultModel.trim())
    throw new Error('A default model is required for a custom provider.');
  if (provider.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)) {
    throw new Error('API key environment variable must be a valid environment variable name.');
  }
}
