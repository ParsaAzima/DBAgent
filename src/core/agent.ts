/**
 * Agent loop: the provider-agnostic heart of the product.
 *
 * Flow for each user turn:
 *   user message → LLM → (tool call → run tool → feed result back → LLM)*
 *   → final assistant answer
 *
 * The loop never interprets SQL itself; all database access happens inside
 * the tools, which use the DatabaseDriver and its guardrails.
 */

import type {
  AgentMessage,
  DatabaseDriver,
  LLMResponse,
  LLMProviderConfig,
  ToolSpec,
  StreamEvent,
  AgentTurnEvent,
  AgentTurnStreamOptions,
  ToolResultData,
} from './types.js';
import type { LLMAdapter } from './types.js';
import { buildTools } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';

export interface AgentTurnOptions {
  /** Wall-clock budget for the whole turn, in milliseconds. */
  timeoutMs?: number;
  /** Called after each model round-trip (for UI spinners / logging). */
  onStep?: (step: AgentStep) => void;
}

export type AgentStep =
  | { kind: 'llm_response'; text?: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { kind: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary: string };

export interface AgentTurnResult {
  /** Final assistant text for this turn. */
  text: string;
  /** Number of model round-trips used. */
  rounds: number;
}

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export class Agent {
  private readonly tools: ToolSpec[];
  private readonly registry: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;
  private history: AgentMessage[];

  constructor(
    private readonly llm: LLMAdapter,
    private readonly db: DatabaseDriver,
    private readonly providerConfig: LLMProviderConfig,
    private readonly maxRounds = 12,
    opts: { allowSystem?: boolean; allowWrites?: boolean; allowShell?: boolean } = {},
  ) {
    const built = buildTools(db, {
      allowSystem: opts.allowSystem ?? false,
      allowWrites: opts.allowWrites ?? false,
      allowShell: opts.allowShell ?? false,
    });
    this.tools = built.tools;
    this.registry = built.registry;
    this.history = [];
  }

  /** Conversation transcript so far (tool payloads trimmed for size). */
  getHistory(): AgentMessage[] {
    return this.history.map((m) =>
      m.role === 'tool'
        ? { ...m, toolResult: summarizeToolResult(m.toolResult) }
        : m,
    );
  }

  /** Reset conversation history (keeps provider/db wiring). */
  reset(): void {
    this.history = [];
  }

  /** Run one full user turn through the tool loop. */
  async runTurn(userMessage: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    const system = await buildSystemPrompt(this.db, this.providerConfig);
    const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
    this.history.push({ role: 'user', content: userMessage });

    let finalText = '';
    let rounds = 0;

    while (rounds < this.maxRounds) {
      if (deadline && Date.now() > deadline) {
        throw new AgentError('Turn timed out before the model produced a final answer.');
      }
      rounds += 1;

      const response: LLMResponse = await this.llm.complete(this.history, this.tools, system);
      const toolCalls = response.toolCalls ?? [];

      options.onStep?.({
        kind: 'llm_response',
        text: response.text,
        toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });

      if (response.text) finalText = response.text;

      if (toolCalls.length === 0) {
        if (!finalText.trim()) {
          // Model said nothing at all — nudge instead of looping forever.
          this.history.push({ role: 'assistant', content: response.text ?? '' });
          this.history.push({
            role: 'user',
            content:
              'You returned an empty response. Use the available database tools to answer the question.',
          });
          continue;
        }
        this.history.push({ role: 'assistant', content: response.text ?? '' });
        return { text: finalText, rounds };
      }

      // Record the assistant's tool-call message, then execute each call.
      this.history.push({
        role: 'assistant',
        content: response.text ?? '',
        toolCalls,
      });

      for (const call of toolCalls) {
        const step = await this.invokeTool(call, deadline);
        options.onStep?.(step);
        this.history.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          toolResult: step.ok ? { ok: true, result: safeParse(step.summary) } : { ok: false, error: step.summary },
        });
      }
    }

    throw new AgentError(
      `Tool loop did not converge after ${this.maxRounds} model rounds. Try a narrower question.`,
    );
  }

  /**
   * Streaming variant of runTurn: emits live events (token deltas, tool
   * starts/completions) via onEvent and honors an AbortSignal (user Esc).
   * Shares all state machine logic with runTurn.
   */
  async runTurnStream(
    userMessage: string,
    options: AgentTurnStreamOptions = {},
  ): Promise<AgentTurnResult> {
    const system = await buildSystemPrompt(this.db, this.providerConfig);
    const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
    this.history.push({ role: 'user', content: userMessage });

    let finalText = '';
    let rounds = 0;

    while (rounds < this.maxRounds) {
      if (deadline && Date.now() > deadline) {
        throw new AgentError('Turn timed out before the model produced a final answer.');
      }
      rounds += 1;

      const llmStream = this.llm.stream;
      const response: LLMResponse = llmStream
        ? await llmStream.call(this.llm, this.history, this.tools, system, (ev: StreamEvent) => {
            if (ev.type === 'text_delta') {
              finalText = finalText + ev.text;
              options.onEvent?.({ kind: 'text_delta', text: ev.text });
            } else if (ev.type === 'tool_call') {
              options.onEvent?.({ kind: 'tool_start', id: ev.id, name: ev.name, args: ev.args });
            }
          }, { signal: options.signal })
        : await this.llm.complete(this.history, this.tools, system);

      // Surface token usage to the UI (cost/status line).
      if (response.usage) {
        options.onEvent?.({ kind: 'usage', usage: response.usage });
      }

      const toolCalls = response.toolCalls ?? [];
      if (response.text && !llmStream) {
        finalText = response.text;
      }

      if (toolCalls.length === 0) {
        if (!finalText.trim()) {
          this.history.push({ role: 'assistant', content: response.text ?? '' });
          this.history.push({
            role: 'user',
            content:
              'You returned an empty response. Use the available database tools to answer the question.',
          });
          finalText = '';
          continue;
        }
        this.history.push({ role: 'assistant', content: response.text ?? finalText });
        options.onEvent?.({ kind: 'turn_done', text: finalText, rounds });
        return { text: finalText, rounds };
      }

      this.history.push({
        role: 'assistant',
        content: response.text ?? '',
        toolCalls,
      });

      for (const call of toolCalls) {
        const t0 = Date.now();
        const step = await this.invokeTool(call, deadline);
        const durationMs = Date.now() - t0;
        options.onEvent?.({
          kind: 'tool_done',
          id: call.id,
          name: call.name,
          ok: step.ok,
          durationMs,
          preview: step.summary.slice(0, 200),
          data: extractToolData(call.name, call.args, step.ok ? step.summary : undefined, step.ok, durationMs),
        });
        this.history.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          toolResult: step.ok ? { ok: true, result: safeParse(step.summary) } : { ok: false, error: step.summary },
        });
      }

      options.onEvent?.({ kind: 'round_done', round: rounds });
      // Next round's model text is a fresh answer; reset accumulated text.
      finalText = '';
    }

    throw new AgentError(
      `Tool loop did not converge after ${this.maxRounds} model rounds. Try a narrower question.`,
    );
  }

  private async invokeTool(
    call: { id: string; name: string; args: Record<string, unknown> },
    deadline?: number,
  ): Promise<Extract<AgentStep, { kind: 'tool_result' }>> {
    const handler = this.registry.get(call.name);
    if (!handler) {
      return {
        kind: 'tool_result',
        toolCallId: call.id,
        name: call.name,
        ok: false,
        summary: `Unknown tool "${call.name}". Available tools: ${[...this.registry.keys()].join(', ')}`,
      };
    }
    try {
      const remaining = deadline ? deadline - Date.now() : undefined;
      const result = await runWithTimeout(handler(call.args), remaining);
      return {
        kind: 'tool_result',
        toolCallId: call.id,
        name: call.name,
        ok: true,
        summary: JSON.stringify(result),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: 'tool_result',
        toolCallId: call.id,
        name: call.name,
        ok: false,
        summary: message,
      };
    }
  }
}

/**
 * Build structured ToolResultData from a completed tool call so the TUI can
 * offer an interactive table viewer (ctrl+o) for query/sample results.
 */
function extractToolData(
  toolName: string,
  args: Record<string, unknown>,
  okSummary: string | undefined,
  ok: boolean,
  durationMs: number,
): ToolResultData | undefined {
  if (!ok || !okSummary) return undefined;
  try {
    const parsed = JSON.parse(okSummary) as any;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const columns: string[] | undefined = parsed.columns;
    const rows: unknown[][] | undefined = parsed.rows;
    if (!Array.isArray(columns) || !Array.isArray(rows)) return undefined;
    return {
      kind: 'table',
      columns: columns.map(String),
      rows,
      rowCount: Number(parsed.rowCount ?? rows.length),
      truncated: rows.length > 0 && rows.length >= Number(parsed.rowCount ?? rows.length) && toolName !== 'query' ? true : undefined,
      sql: typeof args.sql === 'string' ? args.sql : undefined,
      table: typeof args.table === 'string' ? args.table : undefined,
      durationMs,
    };
  } catch {
    return undefined;
  }
}

function runWithTimeout<T>(promise: Promise<T>, ms?: number): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool execution timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** Keep only a tiny preview of a tool result when storing long transcripts. */
function summarizeToolResult(result: unknown, max = 400): unknown {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (text && text.length > max) return `${text.slice(0, max)}… (truncated)`;
  return result;
}
