/**
 * Anthropic Messages API adapter (tool use via content blocks).
 *
 * Wire format reference (2023-06-01, still current):
 *   request  : { model, max_tokens, system, messages, tools: [{name, description, input_schema}] }
 *   assistant: content blocks of {type:'text'} and {type:'tool_use', id, name, input}
 *   tool msg : { role:'user', content:[{type:'tool_result', tool_use_id, content}] }
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
import { streamAnthropic } from './streaming.js';

export class AnthropicAdapter implements LLMAdapter {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;

  constructor(cfg: LLMProviderConfig) {
    if (!cfg.apiKey) {
      throw new Error('Anthropic selected but ANTHROPIC_API_KEY is not set.');
    }
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.temperature = cfg.temperature ?? 0.1;
    this.maxOutputTokens = cfg.maxOutputTokens ?? 2048;
  }

  async complete(
    messages: AgentMessage[],
    tools: ToolSpec[],
    system: string,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      system,
      messages: messages.map(toAnthropicMessage),
      temperature: this.temperature,
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

    const json = await postJson(
      `${this.baseUrl}/v1/messages`,
      body,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
    );

    const blocks: any[] = Array.isArray(json.content) ? json.content : [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        args: typeof b.input === 'object' && b.input !== null ? b.input : {},
      }));

    return {
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: json.usage
        ? {
            promptTokens: json.usage.input_tokens,
            completionTokens: json.usage.output_tokens,
          }
        : undefined,
      stopReason: json.stop_reason,
    };
  }

  /** Streaming variant over the Messages API SSE protocol. */
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

    await streamAnthropic(
      {
        id: 'anthropic',
        model: this.model,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
      },
      this.baseUrl,
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
          usage = { ...usage, promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
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

export function toAnthropicMessage(m: AgentMessage): Record<string, unknown> {
  // Anthropic requires tool results to arrive as user messages containing
  // tool_result blocks; consecutive ones can share the same user message but
  // one-block-per-message is also valid.
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: JSON.stringify(m.toolResult ?? null),
          is_error: !m.toolResult || (m.toolResult as any)?.ok === false,
        },
      ],
    };
  }

  if (m.role === 'assistant' && m.toolCalls?.length) {
    const content: unknown[] = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const c of m.toolCalls) {
      content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
    }
    return { role: 'assistant', content };
  }

  return { role: m.role, content: m.content ?? '' };
}
