# DBAgent

An AI-powered database agent with a professional terminal UI — inspect, query, and administer SQL databases in natural language, in the style of Claude Code and opencode.

```
┌──────────┐    AgentMessage / ToolSpec     ┌─────────────┐
│   TUI    │ ─────────────────────────────► │ Agent Loop  │
└──────────┘                                └──────┬──────┘
                                                   │ LLMAdapter interface
                                 ┌───────────┬─────┴────────┬─────────┐
                                 ▼           ▼              ▼         ▼
                              OpenAI    OpenRouter      Anthropic  Gemini · Ollama
                                 (provider-agnostic loop, streaming, abortable)
                                                   │ DatabaseDriver interface
                                 ┌──────────┬──────┴────────┬───────────┐
                                 ▼          ▼               ▼           ▼
                               SQLite   PostgreSQL         MySQL   SQL Server
```

## Highlights

- **5 LLM providers** — OpenAI, OpenRouter (one key, hundreds of models as `vendor/model`), Anthropic, Google Gemini, Ollama (local), plus any OpenAI-compatible gateway (LM Studio, vLLM, ...)
- **4 databases** — SQLite, PostgreSQL, MySQL, SQL Server (T-SQL) with full schema introspection
- **Performance-first agent** — `performance_report` (broken/disabled/invalid, missing, unused and duplicate indexes · cache hit · wait stats · top expensive queries · blocking · bloat) and `explain_query` (dialect-aware plan analysis) are core tools; the system prompt makes performance the primary workflow
- **Claude-Code-class TUI** — streaming markdown, collapsible tool blocks, interactive table viewer, live token/cost status bar
- **Token-level streaming** — SSE for all providers, cancel any response with `Esc`
- **Hard safety rails** — read-only by default, enforced LIMIT, single-statement rule, DROP/ALTER always blocked, path sandbox, permission tiers
- **System operations** — stats, server info, CSV/JSON export, CSV import, backups (`VACUUM INTO`, `pg_dump`, `mysqldump`, `BACKUP DATABASE`), local database discovery
- **File & shell tools** — read/write/edit/glob/grep files, run shell commands, behind explicit opt-in gates
- **Persistent sessions** — full transcript (tool results, usage, timestamps) auto-saved and restorable with `--resume`

## Installation

Requires Node.js ≥ 22.5 (built-in `node:sqlite`; falls back to `better-sqlite3`).

```bash
git clone <repo> && cd dbagent
npm install
npm run build
cp .env.example .env    # add at least one provider API key
```

## Quick start

```bash
# 1. Create a demo database (e-commerce: customers, orders, products)
node scripts/make-demo-sqlite.mjs

# 2. Chat with it
node dist/cli.js chat --db sqlite://./demo.db --provider openrouter
```

Ask things like *"Which product sold the most last month?"* or *"Export the customers table and tell me the DB size"* — the agent explores the schema, writes and runs SQL, and answers with rendered tables.


## The TUI

`chat` opens a full terminal experience (falls back to a plain REPL when stdin isn't a TTY; `--plain` forces it):

| Key / Command | Action |
|---|---|
| *(type + Enter)* | Ask anything — answers stream token-by-token as rendered markdown |
| `Esc` | Abort the in-flight response |
| `ctrl+o` | Interactive table viewer over the latest query result (scroll `↑↓←→`/`jkhl`, page `PgUp/PgDn`, jump `g`/`G`) |
| `ctrl+t` | Expand/collapse tool-call details (SQL, result previews) |
| `ctrl+l` | Clear screen (session keeps the transcript) |
| `/model <name>` | Switch models mid-session, e.g. `/model anthropic/claude-sonnet-4` |
| `/schema` | Dump tables, columns, types, primary keys |
| `/save` · `/reset` · `/exit` | Persist session · clear conversation · quit |

The status bar is always visible: current `provider/model`, safety mode, session id, cumulative tokens in/out, and **estimated cost** (built-in price table for popular models; shows `$0` when pricing is unknown).

Session transcripts — including tool results, per-turn usage and timestamps — are auto-saved after every turn to `~/.dbagent/sessions/` and restored with `--resume`.

Database URLs: `sqlite://./app.db` · `postgres://user:pass@host:5432/db?ssl=true` · `mysql://user:pass@host:3306/db` · `sqlserver://user:pass@host:1433/db?encrypt=true&trustServerCertificate=false` (named instance: `&instance=SQLEXPRESS`)

## Agent tools

**Core (always available)**

| Tool | Purpose |
|---|---|
| `list_tables` | Tables + views with row-count estimates |
| `describe_table` | Columns, types, nullability, primary keys, defaults |
| `sample_rows` | Peek at the first N rows of a table |
| `query` | Run read-only SQL (LIMIT auto-enforced) |
| `execute` | Run INSERT/UPDATE/DELETE (only with `--allow-writes`) |
| `performance_report` | Dialect-aware diagnostics: broken/disabled/invalid indexes, missing indexes, unused/duplicate indexes, cache hit ratio, waits, top queries, blocking, bloat (`deep: true` adds fragmentation scans) |
| `explain_query` | Run the dialect's plan analyzer on one read-only statement (SQLite `EXPLAIN QUERY PLAN`, PostgreSQL `EXPLAIN [ANALYZE]`, MySQL `EXPLAIN`, SQL Server `SET STATISTICS PROFILE`) |

**System mode (`--allow-system`)**

| Tool | Purpose |
|---|---|
| `db_stats` | Per-table sizes, row counts, index counts, total DB size |
| `system_info` | Server version, uptime, active connections, key settings |
| `export_data` | Dump any table to CSV/JSON under `./dbagent-out/` |
| `import_csv` | Load a CSV into a table, auto-creating it from headers (also needs `--allow-writes`) |
| `backup` | SQLite: `VACUUM INTO` · PostgreSQL: `pg_dump` · MySQL: `mysqldump` · SQL Server: `BACKUP DATABASE` (the `.bak` is written on the server host) |
| `discover_local_databases` | Probe local servers, scan for SQLite files, check client tools |
| `read_file` / `write_file` / `edit_file` | Read (paged, 512 KB cap), create (overwrite-protected), surgical-edit files |
| `list_dir` / `glob_files` / `grep_files` | Navigate and search the project (`node_modules` skipped) |
| `delete_file` | Delete a single file (directories refused) |

**Shell mode (`--allow-shell`) — separate, stronger gate**

| Tool | Purpose |
|---|---|
| `bash` | Run shell commands (psql, migration runners, git...) with a hard 30 s timeout (max 120 s), capped output, sandboxed cwd |

## Performance analysis

Performance work is the agent's primary workflow. A typical session:

```bash
node dist/cli.js chat --db "postgres://user:pass@host:5432/prod" --provider openrouter
```

1. Ask *"why is this slow?"* — the agent starts with `performance_report`, which runs a per-dialect diagnostic catalog (each section best-effort: a missing system view or privilege degrades to an error note, never a failed report).
2. For a suspect query it runs `explain_query` on the exact SQL — plans come back as rows the agent can interpret (full scans, missing indexes, estimate gaps, sort/temp spills).
3. Recommendations come with evidence and trade-offs: exact `CREATE INDEX` / `DROP INDEX` / `REINDEX` / `REBUILD` SQL, write and maintenance cost, and the constraint checks that prevent bad drops (unique/FK-backing indexes are excluded from "unused" lists). Nothing is executed — DDL stays blocked.

| Dialect | Highlights in the report |
|---|---|
| SQL Server | `dm_db_missing_index_*`, disabled indexes, usage stats, duplicates, fragmentation (`deep`), wait stats, top queries by reads, blocking, buffer cache hit |
| PostgreSQL | invalid indexes (`indisvalid`), unused/duplicate indexes, seq-scan hotspots, dead tuples/autovacuum, cache hit, long queries, `pg_stat_statements` |
| MySQL | `sys` unused/redundant indexes, full-scan and slow statements, InnoDB buffer hit, temp-disk counters, table free space |
| SQLite | page/freelist space, index inventory, `sqlite_stat1` (ANALYZE) stats, per-object sizes (`deep`) |

## Safety model

Safety is layered and opt-in. Out of the box the agent **cannot** modify anything.

| Layer | Default | Enabled by |
|---|---|---|
| Data writes (INSERT/UPDATE/DELETE) | blocked | `--allow-writes` |
| DROP / ALTER / TRUNCATE | **always blocked** | — |
| Multi-statement SQL | blocked (1 statement per call) | — |
| Read result size | hard LIMIT 100 rows | `--max-rows` |
| File access | outside workdir blocked | `--allow-system` + sandbox |
| Escaping the path sandbox | impossible | `DBAGENT_ANY_PATH=1` (dangerous) |
| Shell execution | unavailable | `--allow-shell` |

When `--allow-system` is on, exports and backups always land inside the working directory (`./dbagent-out/` by default), and the system prompt instructs the agent to take a backup before risky operations and to prefer dedicated tools over shell commands.

## Configuration

Provider keys go in `.env` (see [.env.example](.env.example)). Any one provider is enough.

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI or any compatible gateway |
| `OPENROUTER_API_KEY` | OpenRouter — models as `vendor/model` |
| `ANTHROPIC_API_KEY` | Claude |
| `GEMINI_API_KEY` | Gemini |
| `OLLAMA_BASE_URL` | defaults to `http://localhost:11434` |
| `DBAGENT_PROVIDER` / `DBAGENT_MODEL` | defaults, overridable by CLI flags |
| `DBAGENT_DB_URL` | default database |
| `DBAGENT_ALLOW_WRITES` / `DBAGENT_ALLOW_SYSTEM` / `DBAGENT_ALLOW_SHELL` | permission tiers |
| `DBAGENT_MAX_ROWS` / `DBAGENT_MAX_ROUNDS` / `DBAGENT_TIMEOUT_MS` | guardrail tuning |
| `DBAGENT_OUT_DIR` | export/backup output directory |
| `DBAGENT_TEMPERATURE` / `DBAGENT_MAX_OUTPUT_TOKENS` | model sampling |

## Library usage

The agent loop is provider- and database-agnostic — use it programmatically:

```ts
import { Agent, createDatabaseDriver, createLLMAdapter } from './src/index.js';

const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 100 });
const llm = createLLMAdapter({
  id: 'openrouter',
  model: 'anthropic/claude-sonnet-4',
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const agent = new Agent(llm, db, { id: 'openrouter', model: 'anthropic/claude-sonnet-4' });

// Simple
const { text } = await agent.runTurn('Top 5 customers by total spend?');

// Streaming with live events
const result = await agent.runTurnStream('How many orders per status?', {
  onEvent: (ev) => {
    if (ev.kind === 'text_delta') process.stdout.write(ev.text);
    if (ev.kind === 'tool_done') console.log(`\n[tool] ${ev.name} (${ev.durationMs}ms)`);
  },
});

await db.close();
```

## Development

```bash
npm run dev          # run the CLI from source (tsx)
npm run build        # compile to dist/
npm test             # full suite (130+ checks):
                     #   typecheck · agent-loop smoke · e2e over HTTP (mock
                     #   OpenAI + OpenRouter) · SSE streaming e2e · TUI render
                     #   · markdown render · system ops · file/shell tools
                     #   · SQL Server dialect · performance diagnostics
npm run demo:seed    # regenerate demo.db
```

Test suites run without any real API keys — LLMs are scripted or served by a local mock.

## Project layout

```
src/
  core/       agent loop, shared types, config, system prompt
  llm/        adapters (OpenAI-compatible/OpenRouter, Anthropic, Gemini) + SSE streaming
  db/         drivers (SQLite, PostgreSQL, MySQL, SQL Server), SQL guardrails, URL factory
  tools/      tool registry: core DB tools, system tools, file tools, shell
  session/    transcript persistence
  tui/        Ink/React UI: app, components, markdown renderer, table viewer
  system/     stats/export/import/backup ops, performance diagnostics, local discovery, path sandbox
scripts/      demo seeding + smoke/e2e test suites
```

## Roadmap

- [ ] Foreign-key relationship discovery → schema graph in the prompt
- [ ] Embedding-based schema search for very large schemas (100+ tables)
- [ ] Web UI on the same core (REST API)
- [ ] MongoDB support
- [ ] Scheduled backups with retention

## License

MIT
