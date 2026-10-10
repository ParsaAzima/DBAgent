import type { LLMProviderConfig } from '../core/types.js';
import { describeNetworkError } from './openai-compatible.js';

export async function listProviderModels(cfg: LLMProviderConfig): Promise<string[]> {
  let url: string;
  const headers: Record<string, string> = {};

  switch (cfg.id) {
    case 'anthropic':
      url = `${apiV1(cfg.baseUrl ?? 'https://api.anthropic.com')}/models?limit=100`;
      headers['x-api-key'] = cfg.apiKey ?? '';
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'gemini':
      url = `https://generativelanguage.googleapis.com/${cfg.apiVersion ?? 'v1beta'}/models`;
      headers['x-goog-api-key'] = cfg.apiKey ?? '';
      break;
    case 'ollama': {
      const root = trimVersion(cfg.baseUrl ?? 'http://localhost:11434');
      url = `${root}/api/tags`;
      break;
    }
    case 'openai':
    case 'openrouter':
    case 'custom':
      url = `${apiV1(cfg.baseUrl ?? defaultBaseUrl(cfg))}/models`;
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      break;
  }

  let response: Response;
  let text: string;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    response = await fetch(url, { headers, signal: controller.signal });
    text = await response.text();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out listing models from provider "${cfg.providerName ?? cfg.id}".`);
    }
    throw new Error(describeNetworkError(err, url));
  } finally {
    clearTimeout(timeout);
  }
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Model list from ${url} was not valid JSON.`);
  }
  if (!response.ok) {
    const record = asRecord(payload);
    const error = asRecord(record.error);
    throw new Error(
      `Could not list models from provider "${cfg.providerName ?? cfg.id}" (HTTP ${response.status}): ${String(error.message ?? record.message ?? text.slice(0, 250))}`,
    );
  }

  const record = asRecord(payload);
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const models = entries
    .filter((item) => {
      const methods = asRecord(item).supportedGenerationMethods;
      return !Array.isArray(methods) || methods.includes('generateContent');
    })
    .map((item) => {
      const entry = asRecord(item);
      const name = entry.id ?? entry.name;
      return typeof name === 'string' ? name.replace(/^models\//, '') : undefined;
    })
    .filter((name): name is string => !!name);
  if (models.length === 0) {
    throw new Error(`Provider "${cfg.providerName ?? cfg.id}" returned no models.`);
  }
  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

function apiV1(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

function trimVersion(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function defaultBaseUrl(cfg: LLMProviderConfig): string {
  return cfg.id === 'openrouter' ? 'https://openrouter.ai/api' : 'https://api.openai.com';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
