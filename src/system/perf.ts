/**
 * Performance diagnostics — the agent's core mission tools.
 *
 *   performance_report : per-dialect catalog of read-only diagnostic queries
 *                        (missing/unused/broken indexes, cache, waits, top
 *                        queries, blocking, bloat). Every section is
 *                        best-effort: missing views/permissions degrade to an
 *                        error note instead of failing the whole report.
 *   explain_query      : run the dialect's query-plan analyzer and return the
 *                        plan rows so the model can spot bottlenecks.
 *
 * Everything here is read-only. The catalogs are exported as pure data so
 * tests can assert the diagnostic SQL without a live server.
 */

import type { DatabaseDialect, DatabaseDriver, QueryResult } from '../core/types.js';
import { classifyStatement, enforceLimit, normalizeSql, singleStatement } from '../db/guard.js';

/* ─────────────────── report ─────────────────── */

export interface PerfQuerySpec {
  /** Stable section id, e.g. 'missing_indexes'. */
  name: string;
  /** Interpretation hint shown with the section (what to look for). */
  note: string;
  sql: string;
  /** Only run when opts.deep is set (expensive scans). */
  deepOnly?: boolean;
  /** Used when the main sql fails (e.g. renamed pg_stat_statements column). */
  fallbackSql?: string;
}

export interface PerfSection {
  name: string;
  ok: boolean;
  note: string;
  error?: string;
  columns: string[];
  rows: unknown[][];
}

export interface PerfReport {
  dialect: DatabaseDialect;
  target: string;
  generatedAt: string;
  deep: boolean;
  sections: PerfSection[];
}

const MAX_SECTION_ROWS = 25;
const MAX_CELL = 400;

function clip(columns: string[], rows: unknown[][]): unknown[][] {
  return rows.slice(0, MAX_SECTION_ROWS).map((r) =>
    r.map((v) => {
      if (typeof v === 'string' && v.length > MAX_CELL) return `${v.slice(0, MAX_CELL)}…`;
      if (v instanceof Date) return v.toISOString();
      return v;
    }),
  );
}

/**
 * Diagnostic query catalog per dialect. All statements are read-only and
 * bounded (LIMIT/TOP) — they run through the driver's normal guardrails.
 */
export function performanceQueries(dialect: DatabaseDialect): PerfQuerySpec[] {
  switch (dialect) {
    case 'sqlserver':
      return [
        {
          name: 'disabled_indexes',
          note: 'A disabled index is not maintained and never used — "broken": re-enable it (ALTER INDEX ... REBUILD) or drop it after confirming the workload.',
          sql: `SELECT TOP 20 OBJECT_NAME(object_id) AS [table_name], name AS [index_name], type_desc AS [type]
                FROM sys.indexes
                WHERE is_disabled = 1 AND is_hypothetical = 0
                ORDER BY OBJECT_NAME(object_id)`,
        },
        {
          name: 'missing_indexes',
          note: 'Estimated impact from the query optimizer. score = avg_total_user_cost × avg_user_impact. Validate the top candidates with explain_query and real workload before CREATE INDEX — indexes slow writes and take space.',
          sql: `SELECT TOP 10 mid.statement AS [table],
                       mid.equality_columns, mid.inequality_columns, mid.included_columns,
                       migs.user_seeks, migs.user_scans,
                       migs.avg_user_impact AS [avg_impact_pct],
                       CONVERT(decimal(18,2), migs.avg_total_user_cost * migs.avg_user_impact / 100.0) AS [score]
                FROM sys.dm_db_missing_index_groups mig
                JOIN sys.dm_db_missing_index_details mid ON mid.index_handle = mig.index_handle
                JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.group_handle
                ORDER BY score DESC`,
        },
        {
          name: 'unused_indexes',
          note: 'Read 0 times but written (or no stats row) — candidates for removal. Confirm the stats window (resets on restart), and that the index is not unique / not supporting a FK or a rare monthly query.',
          sql: `SELECT TOP 15 OBJECT_NAME(i.object_id) AS [table_name], i.name AS [index_name],
                       ISNULL(ius.user_seeks, 0) AS [seeks], ISNULL(ius.user_scans, 0) AS [scans],
                       ISNULL(ius.user_lookups, 0) AS [lookups], ISNULL(ius.user_updates, 0) AS [updates],
                       ius.last_user_update AS [last_update]
                FROM sys.indexes i
                LEFT JOIN sys.dm_db_index_usage_stats ius
                  ON ius.object_id = i.object_id AND ius.index_id = i.index_id AND ius.database_id = DB_ID()
                WHERE i.type IN (1, 2) AND i.is_hypothetical = 0
                  AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_unique = 0
                  AND (ius.index_id IS NULL OR ius.user_seeks + ius.user_scans + ius.user_lookups = 0)
                ORDER BY ISNULL(ius.user_updates, 0) DESC`,
        },
        {
          name: 'duplicate_indexes',
          note: 'Indexes with identical key columns — usually one is redundant. Check included columns, uniqueness and WHERE predicates before dropping either.',
          sql: `WITH idx AS (
                  SELECT i.object_id, i.index_id, i.name AS [index_name], i.is_unique,
                    CAST((SELECT ',' + c.name
                          FROM sys.index_columns ic
                          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                          WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                            AND ic.is_included_column = 0
                          ORDER BY ic.key_ordinal FOR XML PATH('')) AS nvarchar(max)) AS key_cols
                  FROM sys.indexes i
                  WHERE i.type IN (1, 2) AND i.is_hypothetical = 0
                    AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
                )
                SELECT TOP 15 OBJECT_NAME(a.object_id) AS [table_name],
                       a.index_name AS [index_a], b.index_name AS [index_b], a.key_cols AS [key_columns]
                FROM idx a
                JOIN idx b ON a.object_id = b.object_id AND a.key_cols = b.key_cols
                          AND a.is_unique = b.is_unique AND a.index_id < b.index_id
                ORDER BY OBJECT_NAME(a.object_id)`,
        },
        {
          name: 'fragmentation',
          deepOnly: true,
          note: 'LIMITED-mode scan (cheap but reads page metadata). >30% on large indexes → REBUILD; 10-30% → REORGANIZE. Needs admin rights; rebuilding requires write mode and downtime planning.',
          sql: `SELECT TOP 12 OBJECT_NAME(ips.object_id) AS [table_name], i.name AS [index_name],
                       CONVERT(decimal(5,2), ips.avg_fragmentation_in_percent) AS [frag_pct],
                       ips.page_count
                FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
                JOIN sys.indexes i ON i.object_id = ips.object_id AND i.index_id = ips.index_id
                WHERE ips.avg_fragmentation_in_percent > 10 AND ips.page_count > 500
                  AND ips.index_id > 0
                ORDER BY ips.avg_fragmentation_in_percent DESC`,
        },
        {
          name: 'wait_stats',
          note: 'Cumulative wait time by type (since server start) — identifies the bottleneck class: PAGEIOLATCH = I/O, CXPACKET/PARAALLEL = CPU parallelism, LCK_M = locking, PAGELATCH = tempdb/latch contention.',
          sql: `SELECT TOP 10 wait_type, waiting_tasks_count,
                       wait_time_ms, CONVERT(decimal(12,1), wait_time_ms / 1000.0) AS [wait_time_s],
                       CONVERT(decimal(12,1), wait_time_ms / NULLIF(waiting_tasks_count, 0) / 1000.0) AS [avg_wait_s]
                FROM sys.dm_os_wait_stats
                WHERE waiting_tasks_count > 0 AND wait_type NOT IN (
                  'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK','SLEEP_SYSTEMTASK',
                  'SQLTRACE_BUFFER_FLUSH','WAITFOR','LOGMGR_QUEUE','CHECKPOINT_QUEUE',
                  'REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT','BROKER_TO_FLUSH','BROKER_TASK_STOP',
                  'CLR_MANUAL_EVENT','CLR_AUTO_EVENT','DISPATCHER_QUEUE_SEMAPHORE',
                  'FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN',
                  'SQLTRACE_INCREMENTAL_FLUSH_SLEEP','ONDEMAND_TASK_QUEUE','BROKER_EVENTHANDLER',
                  'SLEEP_BPOOL_FLUSH','DIRTY_PAGE_POLL','HADR_FILESTREAM_IOMGR_IOCOMPLETION')
                ORDER BY wait_time_ms DESC`,
        },
        {
          name: 'expensive_queries',
          note: 'Queries with the most cumulative logical reads — prime candidates for indexing or rewriting. Run explain_query on the exact SQL to see the plan.',
          sql: `SELECT TOP 10 CONVERT(bigint, qs.total_logical_reads) AS [total_reads],
                       qs.total_logical_reads / NULLIF(qs.execution_count, 0) AS [avg_reads],
                       qs.execution_count,
                       CONVERT(bigint, qs.total_worker_time / 1000) AS [total_cpu_ms],
                       qs.last_execution_time,
                       LEFT(st.text, 200) AS [query]
                FROM sys.dm_exec_query_stats qs
                CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
                ORDER BY qs.total_logical_reads DESC`,
        },
        {
          name: 'blocking',
          note: 'Sessions currently blocked by another session — fix blocking first; it multiplies into application timeouts.',
          sql: `SELECT TOP 8 r.session_id AS [session_id], r.blocking_session_id AS [blocked_by],
                       r.wait_type, r.wait_time AS [wait_time_ms], r.status, LEFT(t.text, 200) AS [query]
                FROM sys.dm_exec_requests r
                CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
                WHERE r.blocking_session_id > 0
                ORDER BY r.wait_time DESC`,
        },
        {
          name: 'buffer_cache',
          note: 'Buffer cache hit ratio should be ~99%. Much lower → the working set does not fit in memory or reads bypass indexes (large scans).',
          sql: `SELECT
                  MAX(CASE WHEN counter_name = 'Buffer cache hit ratio' THEN cntr_value END) * 100.0 /
                  NULLIF(MAX(CASE WHEN counter_name = 'Buffer cache hit ratio base' THEN cntr_value END), 0)
                    AS [buffer_cache_hit_pct]
                FROM sys.dm_os_performance_counters
                WHERE counter_name IN ('Buffer cache hit ratio', 'Buffer cache hit ratio base')
                  AND object_name LIKE '%Buffer Manager%'`,
        },
      ];

    case 'postgres':
      return [
        {
          name: 'invalid_indexes',
          note: 'A broken/invalid index (usually an interrupted CREATE INDEX CONCURRENTLY) is invisible to the planner — queries scan the table instead. REINDEX or DROP it.',
          sql: `SELECT c.relname AS "table_name", i.indexrelid::regclass::text AS "index_name",
                       i.indisvalid AS "valid", i.indisready AS "ready"
                FROM pg_index i
                JOIN pg_class c ON c.oid = i.indrelid
                WHERE NOT i.indisvalid
                ORDER BY c.relname
                LIMIT 20`,
        },
        {
          name: 'unused_indexes',
          note: 'Never queried since the stats reset — candidates for removal. Primary keys, unique constraints and FK-supporting indexes are excluded.',
          sql: `SELECT s.schemaname, s.relname AS "table_name", s.indexrelname AS "index_name",
                       pg_size_pretty(pg_relation_size(s.indexrelid)) AS "size", s.idx_scan AS "scans"
                FROM pg_stat_user_indexes s
                JOIN pg_index i ON i.indexrelid = s.indexrelid
                WHERE s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique
                  AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = s.indexrelid)
                ORDER BY pg_relation_size(s.indexrelid) DESC
                LIMIT 15`,
        },
        {
          name: 'duplicate_indexes',
          note: 'Exact same key columns and uniqueness — usually one is redundant. Compare included columns (indnkeyatts/INCLUDE) and WHERE predicates before dropping.',
          sql: `SELECT pg_class.relname AS "table_name",
                       a.indexrelid::regclass::text AS "index_a",
                       b.indexrelid::regclass::text AS "index_b",
                       pg_size_pretty(pg_relation_size(a.indexrelid)) AS "size_a",
                       a.indkey::text AS "key_columns"
                FROM pg_index a
                JOIN pg_index b ON a.indrelid = b.indrelid AND a.indexrelid < b.indexrelid
                  AND a.indkey::text = b.indkey::text
                  AND a.indisunique = b.indisunique AND a.indisprimary = b.indisprimary
                  AND pg_get_expr(a.indpred, a.indrelid) IS NOT DISTINCT FROM
                      pg_get_expr(b.indpred, b.indrelid)
                JOIN pg_class ON pg_class.oid = a.indrelid
                WHERE NOT a.indisprimary
                ORDER BY pg_relation_size(a.indexrelid) DESC
                LIMIT 10`,
        },
        {
          name: 'seq_scan_hotspots',
          note: 'Heavy sequential scans = missing index candidates. Compare seq_scan vs idx_scan and row counts; confirm with explain_query before creating an index.',
          sql: `SELECT relname AS "table_name", seq_scan, idx_scan, n_live_tup AS "row_count",
                       seq_tup_read AS "rows_read_by_seq_scan",
                       n_tup_ins + n_tup_upd + n_tup_del AS "writes"
                FROM pg_stat_user_tables
                WHERE seq_scan > 0
                ORDER BY seq_tup_read DESC
                LIMIT 12`,
        },
        {
          name: 'dead_tuples',
          note: 'High dead tuples → autovacuum lag and table bloat: scans read invisible rows. Tune autovacuum or run VACUUM (needs write/admin).',
          sql: `SELECT relname AS "table_name", n_live_tup AS "row_count", n_dead_tup AS "dead_rows",
                       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS "dead_pct",
                       last_autovacuum, last_autoanalyze
                FROM pg_stat_user_tables
                WHERE n_dead_tup > 1000
                ORDER BY n_dead_tup DESC
                LIMIT 10`,
        },
        {
          name: 'cache_hit',
          note: 'Heap + index block cache hit ratio. Should be close to 99%; low values → memory pressure or unindexed scans.',
          sql: `SELECT ROUND(100.0 * SUM(hit) / NULLIF(SUM(hit + read), 0), 2) AS "cache_hit_pct",
                       SUM(read) AS "disk_reads"
                FROM (
                  SELECT heap_blks_hit AS hit, heap_blks_read AS read FROM pg_statio_user_tables
                  UNION ALL
                  SELECT idx_blks_hit, idx_blks_read FROM pg_statio_user_indexes
                ) s`,
        },
        {
          name: 'long_running',
          note: 'Active queries with their duration and wait events — a stuck/long query or lock wait is an immediate bottleneck.',
          sql: `SELECT pid, now() - query_start AS "duration", state,
                       wait_event_type, wait_event, LEFT(query, 200) AS "query"
                FROM pg_stat_activity
                WHERE state <> 'idle' AND pid <> pg_backend_pid()
                  AND query NOT ILIKE '%pg_stat_activity%'
                ORDER BY duration DESC
                LIMIT 10`,
        },
        {
          name: 'top_statements',
          note: 'Most expensive statements (pg_stat_statements extension). If this section fails, install/enable it: CREATE EXTENSION pg_stat_statements.',
          sql: `SELECT LEFT(query, 200) AS "query", calls,
                       ROUND(total_exec_time::numeric, 1) AS "exec_time_ms",
                       ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS "hit_pct"
                FROM pg_stat_statements
                ORDER BY total_exec_time DESC
                LIMIT 10`,
          fallbackSql: `SELECT LEFT(query, 200) AS "query", calls,
                       ROUND(total_time::numeric, 1) AS "total_time_ms"
                FROM pg_stat_statements
                ORDER BY total_time DESC
                LIMIT 10`,
        },
      ];

    case 'mysql':
      return [
        {
          name: 'unused_indexes',
          note: 'Never used by any statement since stats reset (sys schema) — removal candidates after confirming no rare/unique-constraint role.',
          sql: `SELECT object_schema AS \`db_name\`, object_name AS \`table_name\`, index_name
                FROM sys.schema_unused_indexes
                ORDER BY object_schema, object_name
                LIMIT 20`,
        },
        {
          name: 'redundant_indexes',
          note: 'Overlapping indexes where a dominant index already covers the key — dropping the redundant one saves write overhead.',
          sql: `SELECT schema_name AS \`db_name\`, table_name,
                       redundant_index_name, dominant_index_name, sql_drop AS \`drop_statement\`
                FROM sys.schema_redundant_indexes
                ORDER BY table_name
                LIMIT 20`,
        },
        {
          name: 'full_table_scans',
          note: 'Statements doing full table scans (no index used) — the top rows are the first indexing/rewrite targets.',
          sql: `SELECT db, LEFT(query, 200) AS \`query\`,
                       full_scan_count, no_index_used_count, exec_count
                FROM sys.statements_with_full_table_scans
                ORDER BY full_scan_count DESC
                LIMIT 10`,
        },
        {
          name: 'slow_statements',
          note: 'Statements ranked by average latency (sys schema; latency shown as time strings) — analyze the top ones with explain_query.',
          sql: `SELECT db, LEFT(query, 200) AS \`query\`, exec_count, avg_latency
                FROM sys.statements_with_runtimes_in_microseconds
                ORDER BY avg_latency DESC
                LIMIT 10`,
        },
        {
          name: 'buffer_pool',
          note: 'InnoDB buffer pool hit ratio: 1 - (reads / read_requests). Should be ~99%+; low → more RAM or more index-driven access.',
          sql: `SELECT ROUND(100.0 - 100.0 *
                  MAX(CASE WHEN variable_name = 'Innodb_buffer_pool_reads' THEN variable_value + 0 END) /
                  NULLIF(MAX(CASE WHEN variable_name = 'Innodb_buffer_pool_read_requests' THEN variable_value + 0 END), 0), 2)
                    AS \`buffer_pool_hit_pct\`
                FROM performance_schema.global_status
                WHERE variable_name IN ('Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests')`,
        },
        {
          name: 'server_counters',
          note: 'Temp tables on disk, full scans and slow-query count — disk-based temp tables and Select_scan usually mean missing indexes/memory.',
          sql: `SELECT variable_name, variable_value
                FROM performance_schema.global_status
                WHERE variable_name IN ('Created_tmp_disk_tables', 'Created_tmp_tables',
                                        'Select_scan', 'Select_full_join', 'Slow_queries',
                                        'Threads_connected', 'Innodb_row_lock_time')
                ORDER BY variable_name`,
        },
        {
          name: 'table_sizes',
          note: 'Large data_free = free space inside the table file (fragmentation) — OPTIMIZE TABLE can reclaim it (needs write/admin, locks the table).',
          sql: `SELECT table_name, table_rows,
                       ROUND(data_length / 1024 / 1024, 1) AS \`data_mb\`,
                       ROUND(index_length / 1024 / 1024, 1) AS \`index_mb\`,
                       ROUND(data_free / 1024 / 1024, 1) AS \`free_mb\`
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                ORDER BY data_length DESC
                LIMIT 15`,
        },
      ];

    case 'sqlite':
    default:
      return [
        {
          name: 'space',
          note: 'freelist_count = pages free for reuse; a high percentage means VACUUM would shrink the file.',
          sql: `SELECT * FROM pragma_page_count, pragma_freelist_count, pragma_page_size`,
        },
        {
          name: 'indexes',
          note: 'Index inventory (sql NULL = implicit index from PRIMARY KEY/UNIQUE). Check that hot columns in WHERE/JOIN/ORDER BY are covered.',
          sql: `SELECT name AS [index_name], tbl_name AS [table_name], [sql]
                FROM sqlite_master
                WHERE type = 'index'
                ORDER BY tbl_name, name`,
        },
        {
          name: 'stat1',
          note: 'Optimizer statistics from ANALYZE (table + index row counts). Empty → run ANALYZE so the planner stops guessing.',
          sql: `SELECT tbl AS [table_name], idx AS [index_name], stat
                FROM sqlite_stat1
                ORDER BY tbl`,
        },
        {
          name: 'table_sizes',
          deepOnly: true,
          note: 'Per-object page usage (dbstat scans the whole file — use only when needed).',
          sql: `SELECT name AS [object_name], SUM(pgsize) AS [bytes], COUNT(*) AS [pages]
                FROM dbstat
                GROUP BY name
                ORDER BY bytes DESC
                LIMIT 30`,
        },
      ];
  }
}

export async function runPerformanceReport(
  db: DatabaseDriver,
  opts: { deep?: boolean } = {},
): Promise<PerfReport> {
  const deep = opts.deep === true;
  const specs = performanceQueries(db.dialect).filter((s) => !s.deepOnly || deep);
  const sections: PerfSection[] = [];

  for (const spec of specs) {
    let columns: string[] = [];
    let rows: unknown[][] = [];
    let error: string | undefined;
    try {
      ({ columns, rows } = await runDiagnostic(db, spec.sql));
    } catch (err) {
      if (spec.fallbackSql) {
        try {
          ({ columns, rows } = await runDiagnostic(db, spec.fallbackSql));
        } catch (err2) {
          error = err2 instanceof Error ? err2.message : String(err2);
        }
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    sections.push({
      name: spec.name,
      ok: error === undefined,
      note: spec.note,
      ...(error ? { error } : {}),
      columns,
      rows: clip(columns, rows),
    });
  }

  return {
    dialect: db.dialect,
    target: db.describeTarget(),
    generatedAt: new Date().toISOString(),
    deep,
    sections,
  };
}

async function runDiagnostic(
  db: DatabaseDriver,
  sql: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const res = await db.execute(sql);
  return { columns: res.columns, rows: res.rows };
}

/* ─────────────────── explain ─────────────────── */

const PLAN_MAX_ROWS = 300;
const PLAN_MAX_CELL = 1000;

/** Row cap used for statements that execute under profiling (analyze/profile modes). */
const EXPLAIN_ROW_CAP = 100;

/**
 * Run the dialect's query-plan analyzer on one read-only statement.
 *
 *   sqlite     EXPLAIN QUERY PLAN (no execution)
 *   postgres   EXPLAIN [ (ANALYZE, BUFFERS) ] (analyze actually runs it)
 *   mysql      EXPLAIN (no execution)
 *   sqlserver  SET STATISTICS PROFILE ON + statement + OFF (executes)
 */
export async function runExplain(
  db: DatabaseDriver,
  rawSql: string,
  opts: { analyze?: boolean } = {},
): Promise<QueryResult> {
  const stmt = singleStatement(rawSql, 1);
  // Accept queries the model already wrapped in EXPLAIN — rebuild the prefix ourselves.
  const bare = normalizeSql(stmt).replace(/^EXPLAIN\s+(QUERY\s+PLAN\s+)?(\([^)]*\)\s*)?/i, '');
  if (classifyStatement(bare) !== 'read') {
    throw new Error(
      'explain_query only accepts read statements (SELECT/WITH). Writes cannot be profiled.',
    );
  }

  const start = Date.now();
  const capped = enforceLimit(bare, EXPLAIN_ROW_CAP, db.dialect);

  if (db.dialect === 'sqlserver') {
    return explainSqlServer(db, capped, start);
  }

  const prefix =
    db.dialect === 'postgres'
      ? `EXPLAIN ${opts.analyze ? '(ANALYZE, BUFFERS) ' : ''}`
      : db.dialect === 'mysql'
        ? 'EXPLAIN '
        : 'EXPLAIN QUERY PLAN ';
  const res = await db.execute(`${prefix}${capped}`);
  return {
    ...res,
    rows: res.rows
      .slice(0, PLAN_MAX_ROWS)
      .map((r) =>
        r.map((v) =>
          typeof v === 'string' && v.length > PLAN_MAX_CELL ? `${v.slice(0, PLAN_MAX_CELL)}…` : v,
        ),
      ),
    durationMs: Date.now() - start,
  };
}

/**
 * SQL Server has no plain EXPLAIN: SET STATISTICS PROFILE ON makes the query
 * return its actual plan (rows, executions, operator tree) as an extra
 * recordset. ON + query + OFF run in one batch so the session-scoped option
 * is guaranteed to apply regardless of which pooled connection is used.
 */
async function explainSqlServer(
  db: DatabaseDriver,
  sql: string,
  start: number,
): Promise<QueryResult> {
  const pool = await (db as any).ensurePool();
  const res = await pool
    .request()
    .query(`SET STATISTICS PROFILE ON\n${sql}\nSET STATISTICS PROFILE OFF`);
  const recordsets: any[] = res.recordsets ?? [];
  const profile = recordsets.length > 0 ? recordsets[recordsets.length - 1] : (res.recordset ?? []);
  const columns: string[] =
    profile.columns && Object.keys(profile.columns).length > 0
      ? Object.keys(profile.columns)
      : profile.length > 0
        ? Object.keys(profile[0])
        : [];
  const rows = (profile as any[]).slice(0, PLAN_MAX_ROWS).map((r) =>
    columns.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'string' && v.length > PLAN_MAX_CELL) return `${v.slice(0, PLAN_MAX_CELL)}…`;
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }),
  );
  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - start,
  };
}
