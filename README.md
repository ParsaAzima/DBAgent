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
- **Agent Skills** — SKILL.md packages following the open standard used by Claude Code, Codex CLI, GitHub Copilot and Qwen Code: reusable playbooks the model loads on demand, invocable directly as `/<name>`

## Installation

Requires Node.js ≥ 22.5 (built-in `node:sqlite`; falls back to `better-sqlite3`).

```bash
npm install -g dbagent        # or run without installing:
npx dbagent@latest chat --db sqlite://./app.db --provider openrouter
```

From source:

```bash
git clone https://github.com/ParsaAzima/DBAgent.git && cd DBAgent
npm install
npm run build
cp dbagent.example.toml dbagent.toml   # provider + database settings (or cp .env.example .env)
```

## Quick start

```bash
# 1. Create a demo database (e-commerce: customers, orders, products)
node scripts/make-demo-sqlite.mjs

# 2. Chat with it
node dist/cli.js chat --db sqlite://./demo.db --provider openrouter
```

Ask things like _"Which product sold the most last month?"_ or _"Export the customers table and tell me the DB size"_ — the agent explores the schema, writes and runs SQL, and answers with rendered tables.

## The TUI

`chat` opens a full terminal experience (falls back to a plain REPL when stdin isn't a TTY; `--plain` forces it):

| Key / Command                | Action                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| _(type + Enter)_             | Ask anything — answers stream token-by-token as rendered markdown                                            |
| `Esc`                        | Abort the in-flight response                                                                                 |
| `ctrl+o`                     | Interactive table viewer over the latest query result (scroll `↑↓←→`/`jkhl`, page `PgUp/PgDn`, jump `g`/`G`) |
| `ctrl+t`                     | Expand/collapse tool-call details (SQL, result previews)                                                     |
| `ctrl+l`                     | Clear screen (session keeps the transcript)                                                                  |
| `↑` / `↓` / `Tab`            | Navigate and complete slash-command suggestions; outside the menu, arrows browse input history               |
| `/help [command]`            | List commands or show details for one command                                                                |
| `/model [name]`              | Show or switch models mid-session, e.g. `/model anthropic/claude-sonnet-4`                                   |
| `/schema` · `/refresh`       | Show tables/columns/relationships · reload the live schema after external DDL                                |
| `/status` · `/cost`          | Show session/database/model state · cumulative tokens and estimated cost                                     |
| `/clear` · `ctrl+l`          | Clear the visible transcript; the agent context is retained                                                  |
| `/save` · `/reset` · `/exit` | Persist the session · clear transcript/context/usage · save and quit                                         |
| `/skills` · `/<name>`        | List installed skills · run one directly (its instructions are inlined into the prompt)                      |

Start typing `/` to see matching commands (installed skills appear in the menu too). Use `↑`/`↓` to highlight a suggestion, `Tab` to complete it, or `Enter` to complete a partial command; `Enter` on a complete command runs it. `/quit` is an alias for `/exit`, and `/cls` is an alias for `/clear`. Unknown slash commands are reported instead of being sent to the model.

The status bar is always visible: current `provider/model`, safety mode, session id, cumulative tokens in/out, and **estimated cost** (built-in price table for popular models; shows `$0` when pricing is unknown).

Session transcripts — including tool results, per-turn usage and timestamps — are auto-saved after every turn to `~/.dbagent/sessions/` and restored with `--resume`.

Database URLs: `sqlite://./app.db` · `postgres://user:pass@host:5432/db?ssl=true` · `mysql://user:pass@host:3306/db` · `sqlserver://user:pass@host:1433/db?encrypt=true&trustServerCertificate=false` (named instance: `&instance=SQLEXPRESS`)

## Skills

Skills are reusable **SKILL.md** packages — the open Agent Skills standard shared by Claude Code, Codex CLI, GitHub Copilot and Qwen Code. A skill packages a playbook (a slow-query triage, a weekly sales report, a data audit) as markdown. Only its name and description are ever loaded up front; the full instructions load when the skill is actually used, so long procedures cost nothing until you need them.

**Where skills live** — both locations are scanned at session start, and a project skill shadows a user skill of the same name:

| Location                            | Scope                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `.dbagent/skills/<name>/SKILL.md`   | this project — commit it so the whole team (and every agent in CI) gets it |
| `~/.dbagent/skills/<name>/SKILL.md` | your personal skills, available in every project on this machine           |

**Format** — YAML frontmatter between `---` markers (`description` is required; `name` is optional and defaults to the directory name) plus a markdown body with the instructions:

```markdown
---
name: slow-query-triage
description: Diagnose a slow SQL query end to end. Use when the user reports slowness for a specific statement.
---

1. Run `explain_query` on the exact SQL the user reports.
2. Check the plan for full scans, missing indexes and estimate gaps.
3. Rank the findings by impact, then present the exact CREATE INDEX SQL with its trade-offs.
```

**How skills run:**

- **Automatic** — the model sees each skill as a `name: description` line in its system prompt; when a task matches, it calls the `use_skill` tool and follows the returned instructions.
- **Explicit** — type `/<name> [arguments]` in chat (TUI or plain REPL) to run a skill directly; its body is inlined into the prompt and anything you type after the name is passed along as extra context.
- **Listing** — `/skills` inside the session, or `node dist/cli.js skills` in the terminal (shows each skill's source and path).

A skill directory may hold supporting files next to `SKILL.md` (SQL scripts, reference tables); mention them in the body and let the file tools (`--allow-system`) read them.

## Agent tools

**Core (always available)**

| Tool                 | Purpose                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tables`        | Tables + views with row-count estimates (cached per session) — avoid on 30+ table schemas, use `search_tables`                                                                                      |
| `refresh_schema`     | Clear the schema cache and re-read the live catalog (use after external DDL/migrations)                                                                                                             |
| `search_tables`      | Find tables by meaning (embedding-ranked, keyword fallback offline; `limit`, empty query lists alphabetically) + column names — then `describe_table` the hits                                      |
| `list_relations`     | Foreign-key edges (optional `table` filter) — join keys for correct JOINs                                                                                                                           |
| `get_schema_graph`   | Full FK graph: all edges plus tables with no edges                                                                                                                                                  |
| `list_routines`      | Stored procedures, functions, triggers (SQLite: triggers only; optional `kind` filter)                                                                                                              |
| `describe_table`     | Columns, types, nullability, primary keys, defaults (`sensitive` flags PII columns)                                                                                                                 |
| `sample_rows`        | Peek at the first N rows of a table (PII masked; `unmask: true` reveals, audited)                                                                                                                   |
| `query`              | Run read-only SQL (LIMIT auto-enforced; PII masked; `unmask: true` reveals, audited)                                                                                                                |
| `execute`            | Run INSERT/UPDATE/DELETE — needs `--allow-writes` plus interactive y/n confirmation (SQL + impact estimate); every call is audit-logged                                                             |
| `propose_index`      | Analyze a CREATE INDEX proposal without executing it (validates + EXPLAINs the target query); read-only, works in every DDL mode                                                                    |
| `apply_ddl`          | Execute one CREATE INDEX after y/n confirmation — only with `--allow-ddl=on` + `--allow-writes`                                                                                                     |
| `performance_report` | Dialect-aware diagnostics: broken/disabled/invalid indexes, missing indexes, unused/duplicate indexes, cache hit ratio, waits, top queries, blocking, bloat (`deep: true` adds fragmentation scans) |
| `explain_query`      | Run the dialect's plan analyzer on one read-only statement (SQLite `EXPLAIN QUERY PLAN`, PostgreSQL `EXPLAIN [ANALYZE]`, MySQL `EXPLAIN`, SQL Server `SET STATISTICS PROFILE`)                      |

**System mode (`--allow-system`)**

| Tool                                     | Purpose                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `db_stats`                               | Per-table sizes, row counts, index counts, total DB size                                                                                      |
| `system_info`                            | Server version, uptime, active connections, key settings                                                                                      |
| `export_data`                            | Dump any table to CSV/JSON under `./dbagent-out/` (streamed in chunks — full dump, flat memory)                                               |
| `import_csv`                             | Load a CSV into a table, auto-creating it from headers (also needs `--allow-writes`; single transaction, multi-row batches)                   |
| `backup`                                 | SQLite: `VACUUM INTO` · PostgreSQL: `pg_dump` · MySQL: `mysqldump` · SQL Server: `BACKUP DATABASE` (the `.bak` is written on the server host) |
| `discover_local_databases`               | Probe local servers, scan for SQLite files, check client tools                                                                                |
| `read_file` / `write_file` / `edit_file` | Read (paged, 512 KB cap), create (overwrite-protected), surgical-edit files                                                                   |
| `list_dir` / `glob_files` / `grep_files` | Navigate and search the project (`node_modules` skipped)                                                                                      |
| `delete_file`                            | Delete a single file (directories refused)                                                                                                    |

**Shell mode (`--allow-shell`) — separate, stronger gate**

| Tool   | Purpose                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `bash` | Run shell commands (psql, migration runners, git...) with a hard 30 s timeout (max 120 s), capped output, sandboxed cwd |

## Performance analysis

Performance work is the agent's primary workflow. A typical session:

```bash
node dist/cli.js chat --db "postgres://user:pass@host:5432/prod" --provider openrouter
```

1. Ask _"why is this slow?"_ — the agent starts with `performance_report`, which runs a per-dialect diagnostic catalog (each section best-effort: a missing system view or privilege degrades to an error note, never a failed report).
2. For a suspect query it runs `explain_query` on the exact SQL — plans come back as rows the agent can interpret (full scans, missing indexes, estimate gaps, sort/temp spills).
3. Recommendations come with evidence and trade-offs: exact `CREATE INDEX` / `DROP INDEX` / `REINDEX` / `REBUILD` SQL, write and maintenance cost, and the constraint checks that prevent bad drops (unique/FK-backing indexes are excluded from "unused" lists). Nothing is executed — DDL stays blocked.

| Dialect    | Highlights in the report                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Server | `dm_db_missing_index_*`, disabled indexes, usage stats, duplicates, fragmentation (`deep`), wait stats, top queries by reads, blocking, buffer cache hit |
| PostgreSQL | invalid indexes (`indisvalid`), unused/duplicate indexes, seq-scan hotspots, dead tuples/autovacuum, cache hit, long queries, `pg_stat_statements`       |
| MySQL      | `sys` unused/redundant indexes, full-scan and slow statements, InnoDB buffer hit, temp-disk counters, table free space                                   |
| SQLite     | page/freelist space, index inventory, `sqlite_stat1` (ANALYZE) stats, per-object sizes (`deep`)                                                          |

## Safety model

Safety is layered and opt-in. Out of the box the agent **cannot** modify anything.

| Layer                              | Default                        | Enabled by                                                                                    |
| ---------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| Data writes (INSERT/UPDATE/DELETE) | blocked                        | `--allow-writes`                                                                              |
| Write confirmation (SQL + impact)  | interactive y/n per statement  | `--yes` skips it (dangerous)                                                                  |
| Audit log (every SQL statement)    | on (`~/.dbagent/audit.log`)    | `DBAGENT_AUDIT_FILE` to relocate                                                              |
| PII masking (email/phone/…)        | on in `sample_rows`/`query`    | `unmask: true` per call (audited) or `--no-mask-pii` / `DBAGENT_MASK_PII=0`                   |
| CREATE INDEX (only executable DDL) | blocked                        | `--allow-ddl=dry-run` (analyze) or `--allow-ddl=on` (apply + confirm, needs `--allow-writes`) |
| DROP / ALTER / TRUNCATE / RENAME   | **always blocked**             | —                                                                                             |
| Multi-statement SQL                | blocked (1 statement per call) | —                                                                                             |
| Read result size                   | hard LIMIT 100 rows            | `--max-rows`                                                                                  |
| File access                        | outside workdir blocked        | `--allow-system` + sandbox                                                                    |
| Escaping the path sandbox          | impossible                     | `DBAGENT_ANY_PATH=1` (dangerous)                                                              |
| Shell execution                    | unavailable                    | `--allow-shell`                                                                               |

When `--allow-system` is on, exports and backups always land inside the working directory (`./dbagent-out/` by default), and the system prompt instructs the agent to take a backup before risky operations and to prefer dedicated tools over shell commands.

## Configuration

All settings live in one TOML file — copy [dbagent.example.toml](dbagent.example.toml) to `dbagent.toml`:

```toml
[llm]
provider = "openrouter"
model = "openai/gpt-4o-mini"
api_key = "${OPENROUTER_API_KEY}"   # ${VAR} / ${VAR:-fallback} read from the environment

[database]
url = "sqlite://./app.db"

[safety]
allow_writes = false
allow_ddl = "off"    # off | dry-run | on
```

Lookup order for the file: `--config <path>` → `$DBAGENT_CONFIG` → `./dbagent.toml` → `~/.dbagent/config.toml`. Unknown keys/sections and mistyped values fail fast with a _did-you-mean_ hint. Every setting resolves as **CLI flags > environment variables (`.env` still works) > `dbagent.toml` > defaults**, so existing env-based setups are unaffected. `dbagent.toml` is gitignored; prefer `${VAR}` interpolation for API keys instead of plain text.

| TOML key                                          | Env equivalent                    | Purpose                                                          |
| ------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `[llm] provider` / `model`                        | `DBAGENT_PROVIDER` / `_MODEL`     | active provider and model, overridable by `--provider`/`--model` |
| `[llm] api_key` / `base_url`                      | `DBAGENT_API_KEY` / `_BASE_URL`   | generic key/base URL for the active provider                     |
| `[llm] openrouter` / `[llm] gemini`               | `OPENROUTER_*` / `GEMINI_*`       | provider-specific extras (attribution headers, api version)      |
| `[database] url`                                  | `DBAGENT_DB_URL`                  | default database, overridable by `--db`                          |
| `[safety] allow_writes/system/shell`              | `DBAGENT_ALLOW_*`                 | permission tiers                                                 |
| `[safety] assume_yes`                             | `DBAGENT_ASSUME_YES`              | auto-confirm writes (`--yes`), default off                       |
| `[safety] allow_ddl`                              | `DBAGENT_ALLOW_DDL`               | `off` / `dry-run` / `on` (`--allow-ddl`), default `off`          |
| `[safety] mask_pii`                               | `DBAGENT_MASK_PII`                | `false` disables PII masking (`--no-mask-pii`), default on       |
| `[schema] embed_model`                            | `DBAGENT_EMBED_MODEL`             | embedding model for `search_tables`                              |
| `[schema] large_tables`                           | `DBAGENT_LARGE_SCHEMA_TABLES`     | search-first navigation threshold (default `30`)                 |
| `[limits] max_rows` / `max_rounds` / `timeout_ms` | `DBAGENT_MAX_*` / `_TIMEOUT_MS`   | guardrail tuning                                                 |
| `[output] dir` / `audit_file`                     | `DBAGENT_OUT_DIR` / `_AUDIT_FILE` | export/backup directory and audit log                            |
| `[output] allow_any_path`                         | `DBAGENT_ANY_PATH`                | escaping the path sandbox (dangerous)                            |

Provider key variables (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`) still work directly — any one provider is enough.

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
npm run lint         # eslint (0 errors; unused-var warnings allowed)
npm run format:check # prettier check (CI enforces this)
npm test             # full suite (130+ checks):
                     #   typecheck · agent-loop smoke · e2e over HTTP (mock
                     #   OpenAI + OpenRouter) · SSE streaming e2e · TUI render
                     #   · markdown render · system ops · skills · file/shell
                     #   tools · SQL Server dialect · performance diagnostics
npm run demo:seed    # regenerate demo.db
```

Test suites run without any real API keys — LLMs are scripted or served by a local mock.

## Project layout

```
src/
  core/       agent loop, shared types, config, system prompt, skills
  llm/        adapters (OpenAI-compatible/OpenRouter, Anthropic, Gemini) + SSE streaming
  db/         drivers (SQLite, PostgreSQL, MySQL, SQL Server), SQL guardrails, URL factory
  tools/      tool registry: core DB tools, system tools, file tools, shell
  session/    transcript persistence
  tui/        Ink/React UI: app, components, markdown renderer, table viewer
  system/     stats/export/import/backup ops, performance diagnostics, local discovery, path sandbox
scripts/      demo seeding + smoke/e2e test suites
```

## Roadmap

- [x] Foreign-key relationship discovery → schema graph in the prompt
- [x] Embedding-based schema search for very large schemas (100+ tables)
- [ ] Web UI on the same core (REST API)
- [ ] MongoDB support
- [ ] Scheduled backups with retention

## License

MIT
