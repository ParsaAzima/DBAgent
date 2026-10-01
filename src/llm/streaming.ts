/**
 * Streaming support (SSE) for all three API shapes.
 *
 *   openai-compatible : data: {...choices:[{delta:{content, tool_calls}}]}  / data: [DONE]
 *   anthropic         : event: content_block_delta {delta:{type:'text_delta', text}} + tool_use events
 *   gemini            : streamGenerateContent?alt=sse → {candidates:[{content:{parts:[...]}}]}
 *
 * Every chunk is normalized into StreamEvent and delivered through an async
 * iterator. All adapters accept an AbortSignal so the user can cancel a turn.
 */

import type { AgentMessage, ToolSpec, LLMProviderConfig, StreamEvent } from '../core/types.js';
import { postJson, safeParse } from './openai-compatible.js';
import { toOpenAIMessage } from './openai-stream-shared.js';

export type { StreamEvent };

export interface StreamOptions {
  signal?: AbortSignal;
}

type EventSink = (ev: StreamEvent) => void;

/* ────────────────────────── SSE core ────────────────────────── */

/** Parse an SSE byte stream into JSON payloads (skips comments/keepalives). */
async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch {
          /* partial/keepalive — ignore */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

/** POST that returns the raw Response for streaming (no retry: stream breaks). */
async function postStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep null */
    }
    const detail =
      json?.error?.message ??
      json?.error?.metadata?.raw ??
      json?.message ??
      text.slice(0, 300) ??
      `HTTP ${res.status}`;
    throw new Error(`HTTP ${res.status} from ${url}: ${detail}`);
  }
  return res;
}

/* ─────────────────── OpenAI-compatible streaming ─────────────────── */

export async function streamOpenAICompatible(
  cfg: LLMProviderConfig,
  endpoint: string,
  headers: Record<string, string>,
  messages: AgentMessage[],
  tools: ToolSpec[],
  system: string,
  sink: EventSink,
  opts: StreamOptions = {},
): Promise<void> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'system', content: system }, ...messages.map(toOpenAIMessage)],
    temperature: cfg.temperature ?? 0.1,
    max_tokens: cfg.maxOutputTokens ?? 2048,
    stream: true,
    stream_options: { include_usage: true },
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

  const res = await postStream(`${endpoint}/chat/completions`, body, headers, opts.signal);

  /** tool_calls arrive as incremental fragments; reassemble by index. */
  const pending = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of sseEvents(res, opts.signal)) {
    const delta = chunk?.choices?.[0]?.delta;
    if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
      sink({ type: 'text_delta', text: delta.content });
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        const cur = pending.get(i) ?? { id: tc.id ?? `call_${i}`, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pending.set(i, cur);
      }
    }
    if (chunk?.usage) {
      sink({
        type: 'usage',
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      });
    }
    const finish = chunk?.choices?.[0]?.finish_reason;
    if (finish) {
      for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        sink({ type: 'tool_call', id: tc.id, name: tc.name, args: safeParse(tc.args || '{}') });
      }
      pending.clear();
      sink({ type: 'done', stopReason: finish });
    }
  }
  if (pending.size > 0) {
    for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      sink({ type: 'tool_call', id: tc.id, name: tc.name, args: safeParse(tc.args || '{}') });
    }
    sink({ type: 'done' });
  }
}

/* ─────────────────── Anthropic streaming ─────────────────── */

export async function streamAnthropic(
  cfg: LLMProviderConfig,
  baseUrl: string,
  messages: AgentMessage[],
  tools: ToolSpec[],
  system: string,
  sink: EventSink,
  opts: StreamOptions = {},
): Promise<void> {
  const { toAnthropicMessage } = await import('./anthropic.js');
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxOutputTokens ?? 2048,
    system,
    messages: messages.map(toAnthropicMessage),
    temperature: cfg.temperature ?? 0.1,
    stream: true,
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.parameters.properties ?? {},
        required: t.parameters.required ?? [],
      },
    }));
  }

  const res = await postStream(
    `${baseUrl.replace(/\/+$/, '')}/v1/messages`,
    body,
    { 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' },
    opts.signal,
  );

  /** tool_use blocks reassembled by index. */
  const blocks = new Map<number, { id: string; name: string; args: string }>();

  for await (const ev of sseEvents(res, opts.signal)) {
    switch (ev?.type) {
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use') {
          blocks.set(ev.index ?? 0, { id: ev.content_block.id, name: ev.content_block.name, args: '' });
        }
        break;
      case 'content_block_delta': {
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && d.text) sink({ type: 'text_delta', text: d.text });
        if (d.type === 'input_json_delta') {
          const cur = blocks.get(ev.index ?? 0);
          if (cur) cur.args += d.partial_json ?? '';
        }
        break;
      }
      case 'content_block_stop': {
        const cur = blocks.get(ev.index ?? 0);
        if (cur) {
          sink({ type: 'tool_call', id: cur.id, name: cur.name, args: safeParse(cur.args || '{}') });
          blocks.delete(ev.index ?? 0);
        }
        break;
      }
      case 'message_delta':
        if (ev.usage) {
          sink({ type: 'usage', completionTokens: ev.usage.output_tokens });
        }
        if (ev.delta?.stop_reason) sink({ type: 'done', stopReason: ev.delta.stop_reason });
        break;
      case 'message_start':
        if (ev.message?.usage) {
          sink({ type: 'usage', promptTokens: ev.message.usage.input_tokens });
        }
        break;
    }
  }
}

/* ─────────────────── Gemini streaming ─────────────────── */

export async function streamGemini(
  cfg: LLMProviderConfig,
  messages: AgentMessage[],
  tools: ToolSpec[],
  system: string,
  sink: EventSink,
  opts: StreamOptions = {},
): Promise<void> {
  const apiVersion = cfg.apiVersion ?? 'v1beta';
  const { toGeminiContents } = await import('./gemini.js');
  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: cfg.temperature ?? 0.1,
      maxOutputTokens: cfg.maxOutputTokens ?? 2048,
    },
  };
  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: {
            type: 'OBJECT',
            properties: Object.fromEntries(
              Object.entries(t.parameters.properties ?? {}).map(([k, p]) => [
                k,
                { type: p.type.toUpperCase(), description: p.description },
              ]),
            ),
            required: t.parameters.required ?? [],
          },
        })),
      },
    ];
  }

  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${cfg.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey ?? '')}`;
  const res = await postStream(url, body, {}, opts.signal);

  let callIdx = 0;
  for await (const chunk of sseEvents(res, opts.signal)) {
    const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text.length > 0) {
        sink({ type: 'text_delta', text: p.text });
      }
      if (p.functionCall) {
        sink({
          type: 'tool_call',
          id: `gem_${Date.now()}_${callIdx++}`,
          name: p.functionCall.name,
          args: typeof p.functionCall.args === 'object' && p.functionCall.args !== null ? p.functionCall.args : {},
        });
      }
    }
    if (chunk?.usageMetadata) {
      sink({
        type: 'usage',
        promptTokens: chunk.usageMetadata.promptTokenCount,
        completionTokens: chunk.usageMetadata.candidatesTokenCount,
        totalTokens: chunk.usageMetadata.totalTokenCount,
      });
    }
    const finish = chunk?.candidates?.[0]?.finishReason;
    if (finish) sink({ type: 'done', stopReason: finish });
  }
  sink({ type: 'done' });
}
