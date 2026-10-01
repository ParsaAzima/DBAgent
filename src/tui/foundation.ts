/**
 * TUI foundation: rich transcript types (full session model), model pricing
 * engine for live cost estimation, and small formatting helpers.
 */

import type { ToolResultData, TokenUsage } from '../core/types.js';

/* ─────────────────── transcript model ─────────────────── */

export interface ToolRun {
  id: string;
  name: string;
  /** Args summary for the collapsed header, e.g. sql or table name. */
  argsSummary?: string;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
  /** One-line preview of the result. */
  preview?: string;
  /** Full structured result for the interactive table viewer. */
  data?: ToolResultData;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD (0 when pricing unknown). */
  costUsd: number;
}

export interface TurnUsage {
  model: string;
  rounds: number;
  durationMs: number;
  usage: UsageInfo;
  /** Per-round usage entries for detail view. */
  entries: { round: number; usage: TokenUsage; costUsd: number }[];
}

export interface TranscriptItem {
  role: 'user' | 'assistant' | 'info' | 'error';
  text: string;
  tools?: ToolRun[];
  /** Assistant turn metadata: rounds, duration, usage, model. */
  turn?: TurnUsage;
  ts?: number;
}

/* ─────────────────── pricing engine ─────────────────── */

interface ModelPricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Static price table (USD / 1M tokens) for cost estimation. Unknown models
 * return 0 cost (counter keeps working). Prices are approximate and may drift;
 * openrouter.ai/models is authoritative.
 */
const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // Anthropic
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-haiku-4': { input: 0.8, output: 4 },
  // Google (direct + openrouter vendor paths)
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  // Meta
  'llama-3.1-70b-instruct': { input: 0.12, output: 0.3 },
  'llama-3.1-8b-instruct': { input: 0.02, output: 0.05 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek/deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-r1': { input: 0.5, output: 2 },
};

/** Look up pricing for a model id like "openai/gpt-4o-mini" or "gpt-4o-mini". */
export function findPricing(model: string): ModelPricing | undefined {
  const m = model.toLowerCase();
  if (PRICING[m]) return PRICING[m];
  // try the tail after any vendor prefix (openrouter style vendor/model)
  const tail = m.split('/').pop() ?? m;
  return PRICING[tail];
}

/** Estimate USD cost for a usage amount (0 when pricing unknown). */
export function estimateCost(model: string, usage: TokenUsage): number {
  const p = findPricing(model);
  if (!p) return 0;
  const inTok = usage.promptTokens ?? usage.totalTokens ?? 0;
  const outTok = usage.completionTokens ?? 0;
  return (inTok / 1e6) * p.input + (outTok / 1e6) * p.output;
}

export function usageToInfo(model: string, usage: TokenUsage): UsageInfo {
  return {
    inputTokens: usage.promptTokens ?? 0,
    outputTokens: usage.completionTokens ?? 0,
    costUsd: estimateCost(model, usage),
  };
}

/* ─────────────────── formatting helpers ─────────────────── */

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Short human label for a tool call, e.g. query → SQL snippet. */
export function argsSummaryOf(name: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.sql === 'string') {
    const s = args.sql.replace(/\s+/g, ' ').trim();
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  }
  if (typeof args.table === 'string') {
    return args.limit ? `${args.table} (n=${args.limit})` : args.table;
  }
  return undefined;
}

export function previewOf(data: ToolResultData | undefined, okPreview: string): string {
  if (data?.kind === 'table') {
    return `${data.rowCount} row${data.rowCount === 1 ? '' : 's'}`;
  }
  return okPreview.split('\n')[0].slice(0, 80);
}
