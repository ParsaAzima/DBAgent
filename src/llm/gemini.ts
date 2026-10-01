/**
 * Google Gemini adapter (generativelanguage REST API, v1beta).
 *
 * Wire format:
 *   request : { contents:[{role:'user'|'model', parts:[...]}], tools:[{functionDeclarations:[...]}], systemInstruction:{parts:[{text}]}, generationConfig }
 *   model   : parts of {text} and {functionCall:{name,args}}
 *   feedback: { role:'user', parts:[{functionResponse:{name,response:{result:...}}}] }
 */

import type {
  AgentMessage,
  LLMAdapter,
  LLMProviderConfig,
  LLMResponse,
  ToolSpec,
  StreamEvent,
} from '../core/types.js';
import { postJson } from './openai-compatible.js';
import { streamGemini } from './streaming.js';

export class GeminiAdapter implements LLMAdapter {
  readonly id = 'gemini' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;

  constructor(cfg: LLMProviderConfig) {
    if (!cfg.apiKey) throw new Error('Gemini selected but GEMINI_API_KEY is not set.');
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.apiVersion = cfg.apiVersion ?? 'v1beta';
    this.temperature = cfg.temperature ?? 0.1;
    this.maxOutputTokens = cfg.maxOutputTokens ?? 2048;
  }

  async complete(
    messages: AgentMessage[],
    tools: ToolSpec[],
    system: string,
  ): Promise<LLMResponse> {
    const contents = toGeminiContents(messages);

    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
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

    const url = `https://generativelanguage.googleapis.com/${this.apiVersion}/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const json = await postJson(url, body);

    const cand = json?.candidates?.[0];
    const parts: any[] = cand?.content?.parts ?? [];
    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();

    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `gem_call_${Date.now()}_${i}`,
        name: p.functionCall.name,
        args: typeof p.functionCall.args === 'object' && p.functionCall.args !== null
          ? p.functionCall.args
          : {},
      }));

    return {
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: json.usageMetadata
        ? {
            promptTokens: json.usageMetadata.promptTokenCount,
            completionTokens: json.usageMetadata.candidatesTokenCount,
            totalTokens: json.usageMetadata.totalTokenCount,
          }
        : undefined,
      stopReason: cand?.finishReason,
    };
  }

  /** Streaming variant over streamGenerateContent (SSE). */
  async stream(
    messages: AgentMessage[],
    tools: ToolSpec[],
    system: string,
    sink: (ev: StreamEvent) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<LLMResponse> {
    const textParts: string[] = [];
    const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    let usage: LLMResponse['usage'];
    let stopReason: string | undefined;

    await streamGemini(
      {
        id: 'gemini',
        model: this.model,
        apiKey: this.apiKey,
        apiVersion: this.apiVersion,
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
      },
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
          usage = { ...usage, ...ev };
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

/** Normalized messages → Gemini contents (shared with streaming path). */
export function toGeminiContents(messages: AgentMessage[]): unknown[] {
  const contents: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // Function feedback must follow the model's functionCall parts.
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'unknown_tool',
              response: { result: m.toolResult ?? null },
            },
          },
        ],
      });
    } else if (m.role === 'assistant') {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: c.name, args: c.args } });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else {
      contents.push({ role: 'user', parts: [{ text: m.content ?? '' }] });
    }
  }
  return contents;
}
