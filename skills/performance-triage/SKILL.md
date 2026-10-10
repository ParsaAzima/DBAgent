---
name: performance-triage
description: 'Investigate slow queries, database latency, missing or unhealthy indexes, blocking, or general database performance. Use when the user reports slowness or asks for optimization.'
---

# Performance Triage

1. Start with `performance_report` (`deep: true` only when the user asks for deeper diagnostics or the initial findings warrant the extra cost). Note unavailable or permission-limited report sections.
2. If the user supplied a slow query, run `explain_query` on that exact SQL. Enable runtime analysis only when appropriate: PostgreSQL `analyze: true` executes the query, and SQL Server profiling can execute it.
3. If the query or relevant objects are unknown, inspect the schema and retrieve the exact SQL before proposing a query-specific index.
4. Prioritize evidence: blocking and long-running work, broken indexes, high-impact missing indexes, then redundant or unused indexes. Consider statistics windows, table size, uniqueness/constraint backing, workload, and write overhead before recommending index removal.
5. Tie every finding to report or plan evidence. Separate observed facts from likely causes; do not claim that an index will help unless the plan or diagnostics support it.
6. For a candidate index, present the exact dialect-specific SQL and trade-offs. Use `propose_index` when available to validate and analyze a CREATE INDEX proposal.
7. Never apply DDL unless the operator has enabled the required DDL mode; any execution must remain subject to the normal confirmation gate. Do not run deep diagnostics or runtime plans without a relevant reason.

Keep the report concise: lead with the highest-impact verified finding, followed by evidence, next steps, and any relevant caveats.
