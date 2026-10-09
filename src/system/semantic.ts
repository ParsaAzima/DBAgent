/**
 * Semantic table search for large schemas.
 *
 * Dumping list_tables() (names + every column) into context breaks down
 * past ~30 tables, so the agent gets search_tables instead: the table
 * catalog is embedded once per session and ranked by cosine similarity.
 *
 * Two backends, in order of preference:
 *   1. embeddings — OpenAI-compatible POST {base}/embeddings
 *      (OpenAI, OpenRouter, LM Studio, vLLM, modern Ollama /v1).
 *      Model via DBAGENT_EMBED_MODEL (default text-embedding-3-small,
 *      nomic-embed-text on Ollama).
 *   2. keyword fallback — token-overlap scoring on table/column names.
 *      Always available (offline, Anthropic/Gemini sessions), deterministic.
 *
 * The index is built lazily on first search and invalidated on writes and
 * refresh_schema. describe_table stays the lazy per-table detail call.
 */

import type { DatabaseDriver, LLMProviderConfig, TableInfo } from '../core/types.js';

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface SearchHit {
  name: string;
  schema?: string;
  kind: 'table' | 'view';
  /** Cosine similarity (embeddings) or 0..1 overlap (keyword). */
  score: number;
  /** Column names (slim — call describe_table for types). */
  columns: string[];
  /** Which backend ranked this hit. */
  via: 'embedding' | 'keyword';
}

function apiBase(raw: string | undefined, fallback: string): string {
  const base = (raw ?? fallback).replace(/\/+$/, '');
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

function defaultEmbedModel(provider: string): string {
  const override = process.env.DBAGENT_EMBED_MODEL?.trim();
  if (override) return override;
  return provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small';
}

/**
 * Embedding function for OpenAI-compatible providers. Returns undefined
 * for Anthropic/Gemini (different embedding APIs — keyword fallback).
 * Throws on network/auth errors so the caller can fall back.
 */
export function defaultEmbedFn(cfg: LLMProviderConfig): EmbedFn | undefined {
  if (cfg.id !== 'openai' && cfg.id !== 'openrouter' && cfg.id !== 'ollama') {
    return undefined;
  }
  const fallback = cfg.id === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com';
  const base = apiBase(cfg.baseUrl ?? fallback, fallback);
  const model = defaultEmbedModel(cfg.id);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.id === 'openrouter') {
    if (process.env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
    if (process.env.OPENROUTER_APP_NAME) headers['X-Title'] = process.env.OPENROUTER_APP_NAME;
  }
  return async (texts: string[]): Promise<number[][]> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok)
        throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      if (!Array.isArray(json.data) || json.data.length !== texts.length) {
        throw new Error('embeddings response shape unexpected');
      }
      return json.data.map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  };
}

function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Doc {
  table: TableInfo;
  text: string;
  tokens: Set<string>;
  nameTokens: Set<string>;
  vector?: number[];
}

export class SchemaSearch {
  private docs: Doc[] | null = null;
  private via: 'embedding' | 'keyword' = 'keyword';

  constructor(
    private readonly db: DatabaseDriver,
    private readonly opts: { embed?: EmbedFn } = {},
  ) {}

  /** Drop the cached index (writes, refresh_schema). Rebuilt lazily. */
  invalidate(): void {
    this.docs = null;
  }

  async tableCount(): Promise<number> {
    const docs = await this.ensureIndex();
    return docs.length;
  }

  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const docs = await this.ensureIndex();
    const k = Math.max(1, Math.min(limit, 20));
    const q = query.trim();
    if (!q) {
      // Overview mode: alphabetical, no scores to misread.
      return [...docs]
        .sort((a, b) => a.table.name.localeCompare(b.table.name))
        .slice(0, k)
        .map((d) => toHit(d, 0, this.via));
    }
    if (this.via === 'embedding' && docs[0]?.vector) {
      const [qv] = await this.embed([q]);
      return docs
        .map((d) => ({ d, score: cosine(qv, d.vector as number[]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ d, score }) => toHit(d, round(score), 'embedding'));
    }
    const qtokens = tokenize(q);
    return docs
      .map((d) => ({ d, score: keywordScore(qtokens, d) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ d, score }) => toHit(d, round(score), 'keyword'));
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const fn = this.opts.embed;
    if (!fn) throw new Error('no embedding backend');
    return fn(texts);
  }

  private async ensureIndex(): Promise<Doc[]> {
    if (this.docs) return this.docs;
    const [tables, relations] = await Promise.all([this.db.listTables(), this.db.listRelations()]);
    const relByTable = new Map<string, string[]>();
    for (const r of relations) {
      const push = (key: string, desc: string) => {
        const list = relByTable.get(key.toLowerCase()) ?? [];
        if (list.length < 5) list.push(desc);
        relByTable.set(key.toLowerCase(), list);
      };
      push(r.fromTable, `${r.fromTable}.${r.fromColumn} references ${r.toTable}.${r.toColumn}`);
      push(r.toTable, `${r.fromTable}.${r.fromColumn} references ${r.toTable}.${r.toColumn}`);
    }
    const docs: Doc[] = tables.map((table) => {
      const qualified = table.schema ? `${table.schema}.${table.name}` : table.name;
      const cols = table.columns.map((c) => c.name);
      const rel = relByTable.get(table.name.toLowerCase()) ?? [];
      const text = [
        `table ${qualified} (${table.kind})`,
        `columns: ${cols.join(', ')}`,
        ...rel.map((d) => `related: ${d}`),
      ].join('. ');
      return {
        table,
        text,
        tokens: new Set(tokenize(`${qualified} ${cols.join(' ')}`)),
        nameTokens: new Set(tokenize(qualified)),
      };
    });
    // One batched embedding call; any failure → keyword fallback for the session.
    if (this.opts.embed && docs.length > 0) {
      try {
        const vectors = await this.embed(docs.map((d) => d.text));
        if (vectors.length === docs.length) {
          docs.forEach((d, i) => {
            d.vector = vectors[i];
          });
          this.via = 'embedding';
        }
      } catch {
        this.via = 'keyword';
      }
    }
    this.docs = docs;
    return docs;
  }
}

/** Name tokens weigh 3x: "orders" should beat "a column mentioning order". */
function keywordScore(qtokens: string[], doc: Doc): number {
  if (qtokens.length === 0) return 0;
  let hit = 0;
  for (const q of qtokens) {
    if (doc.nameTokens.has(q)) hit += 3;
    else if ([...doc.nameTokens].some((t) => t.includes(q) || q.includes(t))) hit += 2;
    else if (doc.tokens.has(q)) hit += 1;
    else if ([...doc.tokens].some((t) => t.includes(q) || q.includes(t))) hit += 0.5;
  }
  return hit / (qtokens.length * 3);
}

function toHit(d: Doc, score: number, via: 'embedding' | 'keyword'): SearchHit {
  return {
    name: d.table.name,
    ...(d.table.schema ? { schema: d.table.schema } : {}),
    kind: d.table.kind,
    score,
    columns: d.table.columns.map((c) => c.name),
    via,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
