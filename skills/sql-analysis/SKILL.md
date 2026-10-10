---
name: sql-analysis
description: 'Turn a database question into a precise SQL query, explain a query, debug incorrect results, or summarize query output. Use for read-only SQL analysis across supported database dialects.'
---

# SQL Analysis

1. Identify the requested measure, entity, time range, filters, grouping, and desired result shape. Resolve ambiguity before making consequential assumptions.
2. Confirm table, column, and join names with `search_tables` or `list_tables`, `describe_table`, and `list_relations` as needed. Never invent schema details.
3. Write one dialect-compatible `SELECT` or `WITH` statement. Use explicit columns, fully specified join conditions, and an explicit row limit for exploratory results. Avoid `SELECT *` on wide or sensitive tables.
4. Run the statement with `query`; use `explain_query` first when the user asks why it is slow or the query is operationally expensive.
5. Validate whether the result supports the requested conclusion. Check row counts, null behavior, duplicate-producing joins, date boundaries, and aggregation grain when relevant.
6. Answer in the user's language. State the key result and any important assumptions or limitations; include the final SQL only when it helps the user.

Keep analysis read-only. Never put credentials or secrets in SQL, and never bypass PII masking to obtain exact values unless the user explicitly requested those values.
