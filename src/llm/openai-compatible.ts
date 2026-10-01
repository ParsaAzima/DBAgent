/**
 * OpenAI-compatible LLM adapter.
 *
 * Covers api.openai.com plus any OpenAI-compatible gateway (OpenRouter,
 * Together, LM Studio, vLLM, ...). Ollama exposes the same shape at
 * /v1/chat/completions, so it is implemented as a thin preset on top.
 *
 * URL joining is smart: if the configured base URL already ends in /v1 (or
 * contains /api/v1), it is used as-is; otherwise /v1 is appended. This makes
 * https://openrouter.ai/api and https://api.openai.com both correct without
 * per-provider hacks.
 */

import type {
  AgentMessage,
  LLMAdapter,
  LLMProviderConfig,
  LLMResponse,
  ToolSpec,
  StreamEvent,
} from '../core/types.js';
import { toOpenAIMessage } from './openai-stream-shared.js';
import { streamOpenAICompatible } from './streaming.js';

export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly id: 'openai' | 'openrouter' | 'ollama';
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;

  constructor(cfg: LLMProviderConfig) {
    if (cfg.id !== 'openai' && cfg.id !== 'openrouter' && cfg.id !== 'ollama') {
      throw new Error(`OpenAICompatibleAdapter cannot serve provider "${cfg.id}"`);
    }
    this.id = cfg.id;
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.temperature = cfg.temperature ?? 0.1;
    this.maxOutputTokens = cfg.maxOutputTokens ?? 2048;
    const fallback =
      cfg.id === 'ollama'
        ? 'http://localhost:11434'
        : cfg.id === 'openrouter'
          ? 'https://openrouter.ai/api'
          : 'https://api.openai.com';
    this.baseUrl = joinV1(normalizeBase(cfg.baseUrl ?? fallback));
  }

  async complete(
    messages: AgentMessage[],
    tools: ToolSpec[],
    system: string,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [ { role: 'system', content: system }, ...messages.map(toOpenAIMessage) ],
      temperature: this.temperature,
      max_tokens: this.maxOutputTokens,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: t.parameters.properties ?? {},
            required: t.parameters.required ?? [],
          },
        },
      }));
    }

    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.id === 'openrouter') {
      // OpenRouter attribution headers (optional but recommended).
      headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL ?? 'https://github.com/dbagent';
      headers['X-Title'] = process.env.OPENROUTER_APP_NAME ?? 'DBAgent';
    }

    const json = await postJson(`${this.baseUrl}/chat/completions`, body, headers);

    const choice = json?.choices?.[0];
    if (!choice) throw new Error('Provider returned no choices');

    const message = choice.message ?? {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc: any, i: number) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? '',
          args: safeParse(tc.function?.arguments ?? '{}'),
        }))
      : undefined;

    return {
      text: typeof message.content === 'string' && message.content.length > 0
        ? message.content
        : undefined,
      toolCalls,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
      stopReason: choice.finish_reason,
    };
  }

  /** Streaming variant over the same wire format. */
  async stream(
    messages: AgentMessage[],
    tools: ToolSpec[],
    system: string,
    sink: (ev: StreamEvent) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<LLMResponse> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.id === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL ?? 'https://github.com/dbagent';
      headers['X-Title'] = process.env.OPENROUTER_APP_NAME ?? 'DBAgent';
    }

    const textParts: string[] = [];
    const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    let usage: LLMResponse['usage'];
    let stopReason: string | undefined;

    await streamOpenAICompatible(
      {
        id: this.id,
        model: this.model,
        apiKey: this.apiKey,
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
      },
      this.baseUrl,
      headers,
      messages,
      tools,
      system,
      (ev) => {
        if (ev.type === 'text_delta') {
          textParts.push(ev.text);
          sink(ev);
        } else if (ev.type === 'tool_call') {
          toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
          sink(ev);
        } else if (ev.type === 'usage') {
          usage = {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            totalTokens: ev.totalTokens,
          };
        } else if (ev.type === 'done') {
          stopReason = ev.stopReason;
        }
      },
      opts,
    );

    return {
      text: textParts.join('') || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      stopReason,
    };
  }
}

// toOpenAIMessage lives in openai-stream-shared.ts (shared with streaming path)

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Ensure the base URL ends with /v1 exactly once.
 *  - https://api.openai.com            → https://api.openai.com/v1
 *  - https://openrouter.ai/api         → https://openrouter.ai/api/v1
 *  - http://localhost:11434            → http://localhost:11434/v1
 *  - https://gateway.example.com/v1    → unchanged
 */
function joinV1(url: string): string {
  return /\/v1$/.test(url) ? url : `${url}/v1`;
}

export function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Small fetch helper with consistent error surfacing + retry w/ backoff. */
export interface PostJsonOptions {
  /** Extra attempts after the first failure (default 2). 0 disables retry. */
  retries?: number;
  /** Base delay for exponential backoff (default 1000ms). */
  retryBaseDelayMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  opts: PostJsonOptions = {},
): Promise<any> {
  const maxRetries = opts.retries ?? 2;
  const baseDelay = opts.retryBaseDelayMs ?? 1000;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure: retry like a transient error.
      if (attempt < maxRetries) {
        await sleep(backoff(baseDelay, attempt));
        continue;
      }
      throw new Error(`Network error calling ${url}: ${(err as Error).message}`);
    }

    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (res.ok) return json;

    const detail = extractErrorDetail(json, text);
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff(baseDelay, attempt);
      await sleep(delay);
      continue;
    }
    throw new Error(humanHttpError(res.status, url, detail));
  }
}

function backoff(baseMs: number, attempt: number): number {
  const jitter = Math.random() * 250;
  return baseMs * 2 ** attempt + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pull the most informative message out of provider error payloads. */
function extractErrorDetail(json: any, text: string): string {
  const parts: string[] = [];
  const msg = json?.error?.message ?? json?.message;
  if (typeof msg === 'string' && msg) parts.push(msg);
  const metaRaw = json?.error?.metadata?.raw;
  if (typeof metaRaw === 'string' && metaRaw) {
    try {
      const inner = JSON.parse(metaRaw);
      if (inner?.provider_name) parts.push(`provider=${inner.provider_name}`);
      if (inner?.error?.message) parts.push(inner.error.message);
      else if (typeof inner?.error === 'string') parts.push(inner.error);
    } catch {
      parts.push(metaRaw);
    }
  }
  if (parts.length === 0 && typeof json?.raw === 'string') parts.push(json.raw.slice(0, 300));
  if (parts.length === 0 && text) parts.push(text.slice(0, 300));
  return parts.join(' — ') || 'unknown error';
}

function humanHttpError(status: number, url: string, detail: string): string {
  let msg = `HTTP ${status} from ${url}: ${detail}`;
  if (status === 429) {
    msg +=
      ' [rate-limited: free/oversubscribed models often exhaust capacity — wait a bit or try another model, e.g. --model <other-vendor/model>]';
  } else if (status === 402) {
    msg += ' [insufficient credits: top up at the provider or switch model]';
  } else if (status === 404 && /model/i.test(detail)) {
    msg += ' [unknown model id: check the exact vendor/model name]';
  }
  return msg;
}
