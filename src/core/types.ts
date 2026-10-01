/**
 * Core shared types for the DB agent.
 *
 * The agent loop is provider-agnostic: LLM adapters translate between these
 * types and each provider's wire format, and DB adapters implement the
 * DatabaseDriver interface.
 */

/** Identifier of the LLM backend to use for a session. */
export type LLMProviderId = 'openai' | 'openrouter' | 'anthropic' | 'gemini' | 'ollama';

/** JSON-schema-ish description of a tool parameter. */
export interface ToolParamSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  /** JSON-schema-style nested properties (only used when type is 'object'). */
  properties?: Record<string, ToolParamSpec>;
  required?: string[];
}

/** A tool the agent may call (rendered into each provider's tool format). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParamSpec;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments object produced by the LLM adapter. */
  args: Record<string, unknown>;
}

/** Role of a conversation message. */
export type AgentMessageRole = 'user' | 'assistant' | 'tool';

/**
 * Normalized conversation message. Assistant messages may carry text, tool
 * calls or both. Tool results are sent back with role 'tool'.
 */
export interface AgentMessage {
  role: AgentMessageRole;
  /** Plain text content (may be empty when the assistant only called tools). */
  content?: string;
  /** Tool calls requested by the assistant. */
  toolCalls?: ToolCall[];
  /** For role 'tool': identifier of the ToolCall this result answers. */
  toolCallId?: string;
  /** For role 'tool': tool name, required by some providers (Gemini/Anthropic). */
  name?: string;
  /** For role 'tool': the JSON-encoded result payload. */
  toolResult?: unknown;
}

/** Aggregated usage counters returned by a provider. */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Result of a single LLM turn. */
export interface LLMResponse {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  stopReason?: string;
}

/** Live events emitted while an agent turn runs. */
export type AgentTurnEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'tool_done'; id: string; name: string; ok: boolean; durationMs: number; preview: string; data?: ToolResultData }
  | { kind: 'round_done'; round: number }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'turn_done'; text: string; rounds: number }
  | { kind: 'error'; message: string };

/** Structured tool result (query/table results) for rich TUI rendering. */
export interface ToolResultData {
  kind: 'table';
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated?: boolean;
  sql?: string;
  table?: string;
  durationMs?: number;
}

/** Options for agent.runTurnStream. */
export interface AgentTurnStreamOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentTurnEvent) => void;
}

/** Configuration for one LLM provider. */
export interface LLMProviderConfig {
  id: LLMProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Extra JSON-schema settings, e.g. Gemini API version. */
  apiVersion?: string;
}

/** Normalized chunk emitted by a streaming LLM round-trip. */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { type: 'done'; stopReason?: string };

/** LLM adapters must implement this interface. */
export interface LLMAdapter {
  readonly id: LLMProviderId;
  readonly model: string;
  /** Single round-trip: send conversation + tools, get one model response. */
  complete(messages: AgentMessage[], tools: ToolSpec[], system: string): Promise<LLMResponse>;
  /**
   * Streaming round-trip: emits StreamEvent chunks as they arrive and resolves
   * with the aggregated LLMResponse. Adapters may default to complete() if
   * streaming is unavailable.
   */
  stream?(
    messages: AgentMessage[],
    tools: ToolSpec[],
    system: string,
    sink: (ev: StreamEvent) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<LLMResponse>;
}

/** Table column metadata exposed to the agent. */
export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue: string | null;
}

/** Table metadata exposed to the agent. */
export interface TableInfo {
  name: string;
  schema?: string;
  kind: 'table' | 'view';
  rowCountEstimate?: number;
  columns: ColumnInfo[];
}

/** Result of executing a statement through a DatabaseDriver. */
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
}

/** Execution guardrails shared by all drivers. */
export interface SafetyConfig {
  /** Allow INSERT/UPDATE/DELETE/DDL (still never DROP/ALTER). Default false. */
  allowWrites?: boolean;
  /** Hard LIMIT applied to read queries. Default 100. */
  maxRows?: number;
  /** Max statements the driver may execute per request. Default 1. */
  maxStatements?: number;
}

/** Database adapters must implement this interface. */
export interface DatabaseDriver {
  readonly dialect: DatabaseDialect;
  /** Human-readable, redacted connection target (no credentials). */
  describeTarget(): string;
  listTables(): Promise<TableInfo[]>;
  describeTable(name: string): Promise<TableInfo | null>;
  /** Peek at table contents; always a read-only SELECT with LIMIT. */
  sampleRows(name: string, limit: number): Promise<QueryResult>;
  /** Execute a guarded SQL statement. */
  execute(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

export type DatabaseDialect = 'sqlite' | 'postgres' | 'mysql';

/** Parsed database connection descriptor. */
export interface DatabaseConnection {
  dialect: DatabaseDialect;
  /** File path for sqlite; host:port/db for servers. */
  target: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}
