/**
 * Agent tools — the model's hands on the database.
 *
 * Every DB access the model can do goes through one of these handlers, which
 * use the DatabaseDriver and its guardrails. No direct SQL from the model
 * bypasses this layer.
 */

import type {
  AgentHooks,
  DatabaseDriver,
  DdlMode,
  QueryResult,
  ToolSpec,
  WriteConfirmRequest,
} from '../core/types.js';
import { createSystemToolRegistry, type SystemToolDeps } from './system-tools.js';
import { createFileToolRegistry, type FileToolDeps } from './file-tools.js';
import { createShellToolRegistry, type ShellToolDeps } from './shell-tool.js';
import { runExplain, runPerformanceReport } from '../system/perf.js';
import { classifyStatement, parseCreateIndex, singleStatement } from '../db/guard.js';
import { maskResult } from '../system/pii.js';
import { estimateWriteImpact, extractWriteTables, hasNoWhere } from '../system/impact.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface BuiltTools {
  tools: ToolSpec[];
  registry: Map<string, ToolHandler>;
}

export interface BuildToolsOptions {
  /** Enable system-level tools (stats/export/import/backup/discover). */
  allowSystem?: boolean;
  allowWrites?: boolean;
  /** Enable the bash shell tool (separate, stronger gate). */
  allowShell?: boolean;
  /**
   * CREATE INDEX gate, mirrored from the driver's SafetyConfig: 'off'
   * hides apply_ddl entirely, 'dry-run' offers propose_index analysis
   * only, 'on' additionally registers apply_ddl (still human-confirmed).
   */
  ddlMode?: DdlMode;
  /**
   * Mask PII-looking columns in sample_rows/query results (default true).
   * Disable with --no-mask-pii / DBAGENT_MASK_PII=0.
   */
  maskPii?: boolean;
  /**
   * Runtime hooks shared by reference with the Agent/CLI: audit sink for
   * every SQL statement and the human-confirmation gate for writes.
   * Read at call time, so the CLI may install handlers after construction.
   */
  hooks?: AgentHooks;
}

export function buildTools(db: DatabaseDriver, opts: BuildToolsOptions = {}): BuiltTools {
  /**
   * Run a SQL tool with audit logging. Failures (including driver write
   * blocks) are logged too — the audit trail covers attempts, not just
   * successes.
   */
  async function runAudited(
    tool: string,
    sql: string | undefined,
    detail: string | undefined,
    fn: () => Promise<QueryResult>,
    confirmed?: boolean,
  ): Promise<QueryResult> {
    const t0 = Date.now();
    try {
      const res = await fn();
      opts.hooks?.audit?.({
        tool,
        ...(sql !== undefined ? { sql } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ok: true,
        rowCount: res.rowCount,
        durationMs: Date.now() - t0,
        ...(confirmed !== undefined ? { confirmed } : {}),
        ...(res.maskedColumns?.length ? { maskedColumns: res.maskedColumns } : {}),
        ...(res.unmasked ? { unmasked: true } : {}),
      });
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.hooks?.audit?.({
        tool,
        ...(sql !== undefined ? { sql } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ok: false,
        error: message.slice(0, 500),
        durationMs: Date.now() - t0,
        ...(confirmed !== undefined ? { confirmed } : {}),
      });
      throw err;
    }
  }

  /**
   * PII-mask an agent-facing result unless masking is disabled globally
   * or the caller passes unmask (explicit exact-value request, audited).
   */
  function maybeMask(res: QueryResult, unmask: boolean): QueryResult {
    if ((opts.maskPii ?? true) !== true) return res;
    if (unmask) return res.unmasked ? res : { ...res, unmasked: true };
    const { rows, maskedColumns } = maskResult(res.columns, res.rows);
    if (maskedColumns.length === 0) return res;
    return { ...res, rows, maskedColumns };
  }

  /**
   * Run a mutating statement behind the human-confirmation gate.
   * Without write mode the driver rejects with the standard blocked
   * error (audited); without a confirm handler (non-interactive ask)
   * the write is denied instead of hanging on an unanswerable prompt.
   */
  async function runConfirmedWrite(tool: string, sql: string, kind: string): Promise<QueryResult> {
    if (!opts.allowWrites) {
      return runAudited(tool, sql, undefined, () => db.execute(sql));
    }
    const request: WriteConfirmRequest = {
      tool,
      sql,
      kind,
      tables: extractWriteTables(sql),
      noWhereWarning: hasNoWhere(sql),
      impactEstimate: await estimateWriteImpact(db, sql),
    };
    const confirmed = opts.hooks?.confirm ? await opts.hooks.confirm(request) : false;
    if (!confirmed) {
      const error = 'Write cancelled: the operator did not confirm this statement.';
      opts.hooks?.audit?.({ tool, sql, ok: false, error, durationMs: 0, confirmed: false });
      throw new Error(error);
    }
    return runAudited(tool, sql, undefined, () => db.execute(sql), true);
  }

  const tools: ToolSpec[] = [
    {
      name: 'list_tables',
      description:
        'List all tables and views in the connected database with row-count estimates and columns. Results are cached per session; call refresh_schema after external DDL or migrations.',
      parameters: { type: 'object', description: 'No arguments.', properties: {}, required: [] },
    },
    {
      name: 'refresh_schema',
      description:
        'Drop the cached schema snapshot and re-read the live catalog (tables, views, columns). Use after migrations, imports, or any DDL applied outside this session, or when a table looks missing/stale.',
      parameters: { type: 'object', description: 'No arguments.', properties: {}, required: [] },
    },
    {
      name: 'list_relations',
      description:
        'List foreign-key relationships (cached per session): which columns reference which tables. Use before writing JOINs — never guess join keys. Optional "table" narrows to edges touching that table.',
      parameters: {
        type: 'object',
        description: 'Arguments for list_relations.',
        properties: {
          table: {
            type: 'string',
            description: 'Optional table name (bare or schema-qualified) to filter relationships.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_schema_graph',
      description:
        'Full join graph: all foreign-key edges plus the tables with no edges. The compact map for multi-table questions.',
      parameters: { type: 'object', description: 'No arguments.', properties: {}, required: [] },
    },
    {
      name: 'list_routines',
      description:
        'List stored procedures, functions and triggers (SQLite: triggers only). Use to find business logic hidden in the database before assuming it lives in app code.',
      parameters: {
        type: 'object',
        description: 'Arguments for list_routines.',
        properties: {
          kind: {
            type: 'string',
            description: 'Optional filter: "procedure", "function" or "trigger".',
          },
        },
        required: [],
      },
    },
    {
      name: 'describe_table',
      description:
        'Get detailed column metadata for one table or view: names, data types, nullability, primary keys, defaults.',
      parameters: {
        type: 'object',
        description: 'Arguments for describe_table.',
        properties: {
          table: {
            type: 'string',
            description:
              'Table (or view) name. Use schema-qualified names like "public.users" when needed.',
          },
        },
        required: ['table'],
      },
    },
    {
      name: 'sample_rows',
      description:
        'Peek at the first N rows (default 5, max limited by guardrails) of a table to learn value formats. PII-looking columns (email/phone/…) are masked unless unmask is set.',
      parameters: {
        type: 'object',
        description: 'Arguments for sample_rows.',
        properties: {
          table: { type: 'string', description: 'Table (or view) name.' },
          limit: { type: 'number', description: 'How many rows to sample (default 5).' },
          unmask: {
            type: 'boolean',
            description:
              'Return exact values for masked columns (audited). Use only when the user explicitly asked for those values.',
          },
        },
        required: ['table'],
      },
    },
    {
      name: 'query',
      description:
        'Run a read-only SQL statement (SELECT/WITH) against the database and return the result rows. PII-looking columns are masked unless unmask is set (audited — use only for values the user explicitly requested).',
      parameters: {
        type: 'object',
        description: 'Arguments for query.',
        properties: {
          sql: {
            type: 'string',
            description: `A single read-only ${'`'}SELECT${'`'} statement in the database's dialect.`,
          },
          unmask: {
            type: 'boolean',
            description:
              'Return exact values for masked columns (audited). Use only when the user explicitly asked for those values.',
          },
        },
        required: ['sql'],
      },
    },
    {
      name: 'execute',
      description:
        'Run a single data-modifying statement (INSERT/UPDATE/DELETE). Needs write mode AND explicit human confirmation: the operator sees the SQL plus an impact estimate and approves each run. Every call is audit-logged.',
      parameters: {
        type: 'object',
        description: 'Arguments for execute.',
        properties: {
          sql: { type: 'string', description: 'A single INSERT, UPDATE or DELETE statement.' },
        },
        required: ['sql'],
      },
    },
    {
      name: 'propose_index',
      description:
        'Analyze a CREATE INDEX proposal without executing it: validates the statement, parses table/columns, and runs explain_query on the target query when given. Always read-only; the way to justify an index in dry-run mode.',
      parameters: {
        type: 'object',
        description: 'Arguments for propose_index.',
        properties: {
          indexSql: {
            type: 'string',
            description: 'One CREATE [UNIQUE] INDEX statement to analyze.',
          },
          query: {
            type: 'string',
            description: 'Optional read-only SELECT the index should speed up (plan analyzed).',
          },
        },
        required: ['indexSql'],
      },
    },
    {
      name: 'performance_report',
      description:
        'Collect performance diagnostics for this database: broken/disabled/invalid indexes, missing indexes, unused and duplicate indexes, cache hit ratio, wait stats, top expensive queries, blocking and bloat. Sections degrade gracefully when a system view or permission is unavailable. Start performance investigations here.',
      parameters: {
        type: 'object',
        description: 'Arguments for performance_report.',
        properties: {
          deep: {
            type: 'boolean',
            description:
              'Include expensive checks (SQL Server index fragmentation scan, SQLite dbstat file scan). Default false.',
          },
        },
        required: [],
      },
    },
    {
      name: 'explain_query',
      description:
        "Run the dialect's query-plan analyzer on a single read-only statement and return the plan rows. Use it to spot full table scans, missing indexes, row-estimate mismatches, sorts/temp spills and blocking operators. SQLite/MySQL/PostgreSQL do not execute the query unless analyze is set.",
      parameters: {
        type: 'object',
        description: 'Arguments for explain_query.',
        properties: {
          sql: { type: 'string', description: 'One read-only SELECT/WITH statement to analyze.' },
          analyze: {
            type: 'boolean',
            description:
              'PostgreSQL: also execute the plan to include actual row counts and buffer usage. SQL Server profiles always execute. Default false.',
          },
        },
        required: ['sql'],
      },
    },
  ];

  const registry = new Map<string, ToolHandler>([
    ['list_tables', async () => db.listTables()],
    [
      'refresh_schema',
      async () => {
        await db.refreshSchema();
        return db.listTables();
      },
    ],
    [
      'list_relations',
      async (args) => {
        const table = String(args.table ?? '').trim();
        const relations = await db.listRelations();
        if (!table) return relations;
        const want = table.replace(/["`[\]]/g, '').toLowerCase();
        return relations.filter(
          (r) =>
            r.fromTable.toLowerCase() === want ||
            r.toTable.toLowerCase() === want ||
            `${r.fromSchema ?? ''}.${r.fromTable}`.toLowerCase() === want ||
            `${r.toSchema ?? ''}.${r.toTable}`.toLowerCase() === want,
        );
      },
    ],
    ['get_schema_graph', async () => db.getSchemaGraph()],
    [
      'list_routines',
      async (args) => {
        const kind = String(args.kind ?? '')
          .trim()
          .toLowerCase();
        if (kind && !['procedure', 'function', 'trigger'].includes(kind)) {
          throw new Error('list_routines "kind" must be procedure, function or trigger.');
        }
        const routines = await db.listRoutines();
        return kind ? routines.filter((r) => r.kind === kind) : routines;
      },
    ],
    [
      'describe_table',
      async (args) => {
        const name = String(args.table ?? '').trim();
        if (!name) throw new Error('describe_table requires "table".');
        const info = await db.describeTable(name);
        if (!info) throw new Error(`Table "${name}" not found.`);
        return info;
      },
    ],
    [
      'sample_rows',
      async (args) => {
        const name = String(args.table ?? '').trim();
        const limit = Number(args.limit ?? 5);
        const unmask = args.unmask === true || String(args.unmask ?? '').toLowerCase() === 'true';
        if (!name) throw new Error('sample_rows requires "table".');
        if (!Number.isFinite(limit) || limit < 1)
          throw new Error('"limit" must be a positive number.');
        return runAudited('sample_rows', undefined, `table=${name} limit=${limit}`, async () =>
          maybeMask(await db.sampleRows(name, limit), unmask),
        );
      },
    ],
    [
      'query',
      async (args) => {
        const sql = String(args.sql ?? '').trim();
        const unmask = args.unmask === true || String(args.unmask ?? '').toLowerCase() === 'true';
        if (!sql) throw new Error('query requires "sql".');
        return runAudited('query', sql, undefined, async () =>
          maybeMask(await db.execute(sql), unmask),
        );
      },
    ],
    [
      'execute',
      async (args) => {
        const sql = String(args.sql ?? '').trim();
        if (!sql) throw new Error('execute requires "sql".');
        const label = /^\s*INSERT\b/i.test(sql)
          ? 'insert'
          : /^\s*UPDATE\b/i.test(sql)
            ? 'update'
            : /^\s*DELETE\b/i.test(sql)
              ? 'delete'
              : classifyStatement(sql);
        return runConfirmedWrite('execute', sql, label);
      },
    ],
    [
      'propose_index',
      async (args) => {
        const indexSql = String(args.indexSql ?? '').trim();
        if (!indexSql) throw new Error('propose_index requires "indexSql".');
        const stmt = singleStatement(indexSql, 1);
        const parsed = parseCreateIndex(stmt);
        if (!parsed) {
          throw new Error(
            'propose_index needs one CREATE [UNIQUE] INDEX statement, e.g. CREATE INDEX idx_orders_customer ON orders (customer_id).',
          );
        }
        const query = String(args.query ?? '').trim();
        let plan: unknown = null;
        if (query) {
          plan = await runExplain(db, query, { analyze: false });
        }
        return {
          indexSql: stmt,
          table: parsed.table,
          columns: parsed.columns,
          unique: parsed.unique,
          executed: false,
          planBefore: plan,
          guidance: [
            'Not executed (analysis only).',
            `Expected win: faster lookups/joins on ${parsed.table}(${parsed.columns.join(', ')}); verify with explain_query after applying.`,
            'Costs: slower writes on the table, extra disk, maintenance during VACUUM/REINDEX windows.',
            parsed.unique
              ? 'UNIQUE also enforces a constraint: duplicate values will fail inserts.'
              : 'Non-unique: safe for reads; still needs the apply confirmation.',
            'To apply: re-run with --allow-ddl=on plus human confirmation (apply_ddl).',
          ],
        };
      },
    ],
    ['performance_report', async (args) => runPerformanceReport(db, { deep: !!args.deep })],
    [
      'explain_query',
      async (args) => {
        const sql = String(args.sql ?? '').trim();
        if (!sql) throw new Error('explain_query requires "sql".');
        return runExplain(db, sql, { analyze: !!args.analyze });
      },
    ],
  ]);

  // ── apply_ddl: only in --allow-ddl=on (plus --allow-writes + human confirm) ──
  if ((opts.ddlMode ?? 'off') === 'on') {
    tools.push({
      name: 'apply_ddl',
      description:
        'Execute one CREATE [UNIQUE] INDEX statement after explicit human confirmation (same y/n gate as execute, audit-logged). DROP/ALTER/TRUNCATE and every other DDL stay blocked.',
      parameters: {
        type: 'object',
        description: 'Arguments for apply_ddl.',
        properties: {
          sql: {
            type: 'string',
            description: 'One CREATE [UNIQUE] INDEX statement to execute.',
          },
        },
        required: ['sql'],
      },
    });
    registry.set('apply_ddl', async (args) => {
      const sql = String(args.sql ?? '').trim();
      if (!sql) throw new Error('apply_ddl requires "sql".');
      // Tool-level validation mirrors the driver gate (defense in depth).
      if (!parseCreateIndex(singleStatement(sql, 1))) {
        throw new Error('apply_ddl runs only CREATE [UNIQUE] INDEX statements.');
      }
      return runConfirmedWrite('apply_ddl', sql, 'create_index');
    });
  }

  // System-level tools (stats/export/import/backup/discover) when opted in.
  if (opts.allowSystem) {
    const sysDeps: SystemToolDeps = {
      db,
      allowSystem: true,
      allowWrites: opts.allowWrites ?? false,
    };
    const sysRegistry = createSystemToolRegistry(sysDeps);

    const systemSpecs: ToolSpec[] = [
      {
        name: 'db_stats',
        description:
          'Database statistics: per-table row estimates, sizes on disk, index counts, total DB size.',
        parameters: { type: 'object', description: 'No arguments.', properties: {}, required: [] },
      },
      {
        name: 'system_info',
        description:
          'Database server info: version, uptime, active connections, key settings (per dialect).',
        parameters: { type: 'object', description: 'No arguments.', properties: {}, required: [] },
      },
      {
        name: 'export_data',
        description:
          'Export a full table to a CSV or JSON file under ./dbagent-out/. Returns file path, row and byte counts.',
        parameters: {
          type: 'object',
          description: 'Arguments for export_data.',
          properties: {
            table: { type: 'string', description: 'Table name to export.' },
            format: { type: 'string', description: '"csv" (default) or "json".' },
          },
          required: ['table'],
        },
      },
      {
        name: 'import_csv',
        description:
          'Import a local CSV file into a table (requires write mode). Can auto-create the table from headers.',
        parameters: {
          type: 'object',
          description: 'Arguments for import_csv.',
          properties: {
            file: { type: 'string', description: 'Path to the CSV file.' },
            table: { type: 'string', description: 'Target table name.' },
            createTable: {
              type: 'boolean',
              description: 'Create the table from CSV headers (all TEXT columns).',
            },
          },
          required: ['file', 'table'],
        },
      },
      {
        name: 'backup',
        description:
          'Create a database backup file: SQLite uses VACUUM INTO; PostgreSQL/MySQL use pg_dump/mysqldump; SQL Server runs BACKUP DATABASE (the .bak is written on the server host).',
        parameters: {
          type: 'object',
          description: 'Arguments for backup.',
          properties: {
            file: {
              type: 'string',
              description:
                'Optional output file name (defaults to timestamped name in ./dbagent-out/).',
            },
          },
          required: [],
        },
      },
      {
        name: 'discover_local_databases',
        description:
          'Scan this machine for usable databases: running PostgreSQL/MySQL/SQL Server servers (port probe), SQLite files under the working directory, and available client tools.',
        parameters: { type: 'object', description: 'No arguments.', properties: {}, required: [] },
      },
    ];

    tools.push(...systemSpecs);
    for (const [k, v] of sysRegistry) registry.set(k, v);

    // ── File tools (same gate as system tools) ──
    const fileRegistry = createFileToolRegistry({ allowSystem: true });
    const fileSpecs: ToolSpec[] = [
      {
        name: 'read_file',
        description:
          'Read a text file (SQL scripts, configs, CSVs, code) from the working directory. Returns up to 400 lines per call with an offset for paging.',
        parameters: {
          type: 'object',
          description: 'Arguments for read_file.',
          properties: {
            path: {
              type: 'string',
              description: 'File path (absolute, or relative to the working directory).',
            },
            offset: {
              type: 'number',
              description: 'Line number to start from (0-based, default 0).',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description:
          'Create or overwrite a text file — e.g. save a migration .sql or a report. Overwriting an existing file requires confirmation via expected/overwrite.',
        parameters: {
          type: 'object',
          description: 'Arguments for write_file.',
          properties: {
            path: { type: 'string', description: 'File path to write.' },
            content: { type: 'string', description: 'Full file content.' },
            overwrite: {
              type: 'string',
              description: 'Set "true" to overwrite without confirmation.',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'edit_file',
        description:
          'Surgical edit: replace an exact substring in a file. Fails if oldString appears multiple times unless allowMultiple.',
        parameters: {
          type: 'object',
          description: 'Arguments for edit_file.',
          properties: {
            path: { type: 'string', description: 'File path.' },
            oldString: { type: 'string', description: 'Exact text to replace.' },
            newString: { type: 'string', description: 'Replacement text.' },
            allowMultiple: { type: 'boolean', description: 'Replace all occurrences.' },
          },
          required: ['path', 'oldString', 'newString'],
        },
      },
      {
        name: 'list_dir',
        description: 'List a directory (files + subdirs with sizes).',
        parameters: {
          type: 'object',
          description: 'Arguments for list_dir.',
          properties: {
            path: { type: 'string', description: 'Directory path (default: working directory).' },
          },
          required: [],
        },
      },
      {
        name: 'glob_files',
        description:
          'Find files by glob pattern, e.g. **/*.sql or migrations/*.ts. node_modules is skipped.',
        parameters: {
          type: 'object',
          description: 'Arguments for glob_files.',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern.' },
            cwd: {
              type: 'string',
              description: 'Directory to search in (default: working directory).',
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'grep_files',
        description:
          'Search file contents with a case-insensitive regex across common text/code files. Returns file, line number and matching text.',
        parameters: {
          type: 'object',
          description: 'Arguments for grep_files.',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern.' },
            cwd: { type: 'string', description: 'Directory to search in.' },
            ext: {
              type: 'string',
              description:
                'Comma-separated file extensions to scan (default: .sql,.txt,.md,.csv,.json,.ts,.js,.py,.mjs).',
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'delete_file',
        description: 'Delete a single file (refuses directories). Use sparingly.',
        parameters: {
          type: 'object',
          description: 'Arguments for delete_file.',
          properties: { path: { type: 'string', description: 'File path to delete.' } },
          required: ['path'],
        },
      },
    ];
    tools.push(...fileSpecs);
    for (const [k, v] of fileRegistry) registry.set(k, v);
  }

  // ── Shell tool: its own stronger gate (--allow-shell) ──
  if (opts.allowShell) {
    const shellRegistry = createShellToolRegistry({ allowShell: true });
    tools.push({
      name: 'bash',
      description:
        'Run a shell command (cmd.exe on Windows, /bin/sh elsewhere) in the working directory. Use for psql/mysql/sqlcmd clients, running migration scripts, git, etc. Hard timeout 30s (max 120s); output capped. Prefer dedicated tools when available.',
      parameters: {
        type: 'object',
        description: 'Arguments for bash.',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          cwd: {
            type: 'string',
            description: 'Working directory for the command (default: current directory).',
          },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000, max 120000).' },
        },
        required: ['command'],
      },
    });
    for (const [k, v] of shellRegistry) registry.set(k, v);
  }

  return { tools, registry };
}
