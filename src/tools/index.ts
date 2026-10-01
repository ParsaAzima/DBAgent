/**
 * Agent tools — the model's hands on the database.
 *
 * Every DB access the model can do goes through one of these handlers, which
 * use the DatabaseDriver and its guardrails. No direct SQL from the model
 * bypasses this layer.
 */

import type { DatabaseDriver, ToolSpec } from '../core/types.js';
import { createSystemToolRegistry, type SystemToolDeps } from './system-tools.js';
import { createFileToolRegistry, type FileToolDeps } from './file-tools.js';
import { createShellToolRegistry, type ShellToolDeps } from './shell-tool.js';

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
}

export function buildTools(db: DatabaseDriver, opts: BuildToolsOptions = {}): BuiltTools {
  const tools: ToolSpec[] = [
    {
      name: 'list_tables',
      description:
        'List all tables and views in the connected database with row-count estimates and columns.',
      parameters: { type: 'object', description: 'No arguments.', properties: {}, required: [] },
    },
    {
      name: 'describe_table',
      description:
        'Get detailed column metadata for one table or view: names, data types, nullability, primary keys, defaults.',
      parameters: {
        type: 'object',
        description: 'Arguments for describe_table.',
        properties: {
          table: { type: 'string', description: 'Table (or view) name. Use schema-qualified names like "public.users" when needed.' },
        },
        required: ['table'],
      },
    },
    {
      name: 'sample_rows',
      description:
        'Peek at the first N rows (default 5, max limited by guardrails) of a table to learn value formats.',
      parameters: {
        type: 'object',
        description: 'Arguments for sample_rows.',
        properties: {
          table: { type: 'string', description: 'Table (or view) name.' },
          limit: { type: 'number', description: 'How many rows to sample (default 5).' },
        },
        required: ['table'],
      },
    },
    {
      name: 'query',
      description:
        'Run a read-only SQL statement (SELECT/WITH) against the database and return the result rows.',
      parameters: {
        type: 'object',
        description: 'Arguments for query.',
        properties: {
          sql: { type: 'string', description: `A single read-only ${'`'}SELECT${'`'} statement in the database's dialect.` },
        },
        required: ['sql'],
      },
    },
    {
      name: 'execute',
      description:
        'Run a single data-modifying statement (INSERT/UPDATE/DELETE). Only available when write mode is enabled; otherwise it fails.',
      parameters: {
        type: 'object',
        description: 'Arguments for execute.',
        properties: {
          sql: { type: 'string', description: 'A single INSERT, UPDATE or DELETE statement.' },
        },
        required: ['sql'],
      },
    },
  ];

  const registry = new Map<string, ToolHandler>([
    ['list_tables', async () => db.listTables()],
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
        if (!name) throw new Error('sample_rows requires "table".');
        if (!Number.isFinite(limit) || limit < 1) throw new Error('"limit" must be a positive number.');
        return db.sampleRows(name, limit);
      },
    ],
    [
      'query',
      async (args) => {
        const sql = String(args.sql ?? '').trim();
        if (!sql) throw new Error('query requires "sql".');
        return db.execute(sql);
      },
    ],
    [
      'execute',
      async (args) => {
        const sql = String(args.sql ?? '').trim();
        if (!sql) throw new Error('execute requires "sql".');
        return db.execute(sql);
      },
    ],
  ]);

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
            createTable: { type: 'boolean', description: 'Create the table from CSV headers (all TEXT columns).' },
          },
          required: ['file', 'table'],
        },
      },
      {
        name: 'backup',
        description:
          'Create a database backup file: SQLite uses VACUUM INTO; PostgreSQL/MySQL use pg_dump/mysqldump when available.',
        parameters: {
          type: 'object',
          description: 'Arguments for backup.',
          properties: {
            file: { type: 'string', description: 'Optional output file name (defaults to timestamped name in ./dbagent-out/).' },
          },
          required: [],
        },
      },
      {
        name: 'discover_local_databases',
        description:
          'Scan this machine for usable databases: running PostgreSQL/MySQL servers (port probe), SQLite files under the working directory, and available client tools.',
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
            path: { type: 'string', description: 'File path (absolute, or relative to the working directory).' },
            offset: { type: 'number', description: 'Line number to start from (0-based, default 0).' },
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
            overwrite: { type: 'string', description: 'Set "true" to overwrite without confirmation.' },
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
          properties: { path: { type: 'string', description: 'Directory path (default: working directory).' } },
          required: [],
        },
      },
      {
        name: 'glob_files',
        description: 'Find files by glob pattern, e.g. **/*.sql or migrations/*.ts. node_modules is skipped.',
        parameters: {
          type: 'object',
          description: 'Arguments for glob_files.',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern.' },
            cwd: { type: 'string', description: 'Directory to search in (default: working directory).' },
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
            ext: { type: 'string', description: 'Comma-separated file extensions to scan (default: .sql,.txt,.md,.csv,.json,.ts,.js,.py,.mjs).' },
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
        'Run a shell command (cmd.exe on Windows, /bin/sh elsewhere) in the working directory. Use for psql/mysql clients, running migration scripts, git, etc. Hard timeout 30s (max 120s); output capped. Prefer dedicated tools when available.',
      parameters: {
        type: 'object',
        description: 'Arguments for bash.',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          cwd: { type: 'string', description: 'Working directory for the command (default: current directory).' },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000, max 120000).' },
        },
        required: ['command'],
      },
    });
    for (const [k, v] of shellRegistry) registry.set(k, v);
  }

  return { tools, registry };
}
