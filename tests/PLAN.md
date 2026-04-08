# Test Suite Plan: Bun.SQL + GreptimeDB Postgres Adapter

## Approach

Use Bun's built-in test runner (`bun test`). Each test file creates isolated temporary tables
(`test_spans_<uuid>`, `test_items_<uuid>`), runs assertions, and drops them on teardown.
No dependency on the benchmark seed data.

## File Structure

```
tests/
  helpers.ts                 # setup/teardown utilities, shared sql instance
  roundtrip.test.ts          # basic insert → select field-by-field correctness
  batch-inserts.test.ts      # batch insert patterns, NULL/non-NULL mixing
  data-types.test.ts         # type boundaries, precision, CAST
  query-patterns.test.ts     # time-range, cursor pagination, ORDER BY, LIMIT, COUNT
  aggregates.test.ts         # COUNT, MIN, MAX, SUM, AVG, GROUP BY, DISTINCT
  predicates.test.ts         # IS NULL, IN, NOT IN, BETWEEN, LIKE, CASE, string functions, index edge cases
  datetime-functions.test.ts # DATE_TRUNC, NOW(), interval arithmetic, EXTRACT, time histograms
  concurrency.test.ts        # parallel writes, connection pool behavior
  append-mode.test.ts        # APPEND_MODE semantics (duplicate PKs, no updates)
  large-payloads.test.ts     # 400KB STRING fields, large result sets
  cross-tenant.test.ts       # tenant isolation in Strategy B shared tables
  error-handling.test.ts     # invalid SQL, non-existent tables, recovery

  # Run separately — takes minutes, not seconds
  memory-regression.ts       # heap growth checks for known leak patterns (not bun test)
```

## Test Categories & Rationale

| # | File | What we're probing | Why it might reveal bugs |
|---|------|--------------------|--------------------------|
| 1 | `roundtrip` | Every column survives insert→select exactly | Type coercion, truncation, encoding |
| 2 | `batch-inserts` | Mixed NULL/non-NULL across rows in same batch | Known Bun.SQL prepared-stmt bug area |
| 3 | `data-types` | TIMESTAMP(9) ns precision, BIGINT UNSIGNED extremes, VARCHAR lengths, CAST | GreptimeDB may lose sub-ms precision; Bun.SQL date binding |
| 4 | `query-patterns` | Time-range boundaries, cursor OR-condition pagination, tied timestamps, LIMIT | Pagination gaps/duplicates; off-by-one on range boundaries |
| 5 | `aggregates` | COUNT, MIN, MAX, SUM, AVG, GROUP BY, DISTINCT | Aggregates over time-series data may miscount or skip rows |
| 6 | `predicates` | IS NULL, IN, NOT IN, BETWEEN, LIKE, CASE, string functions, INVERTED INDEX edge cases | Common filter patterns that may interact badly with GreptimeDB indexes |
| 7 | `datetime-functions` | DATE_TRUNC, NOW(), interval arithmetic, EXTRACT, time histograms with aggregates | Time bucketing is core to TSDB queries; precision bugs likely here |
| 8 | `concurrency` | 50 concurrent inserts simultaneously, COUNT after | Lost writes, connection pool exhaustion |
| 9 | `append-mode` | Re-inserting same PK, UPDATE/DELETE return errors | Silent loss vs error vs duplicate |
| 10 | `large-payloads` | 400KB STRING field insert + roundtrip, 1000-row result sets | Bun.SQL buffer limits, GreptimeDB row size limits |
| 11 | `cross-tenant` | Tenant A rows not visible when querying tenant B | Partition/index bugs leaking data across tenants |
| 12 | `error-handling` | Invalid SQL, missing table, error → next query still works | Connection poisoning after errors |

## Specific Edge Cases

### `roundtrip`
- All 28 span columns, null vs non-null for every nullable field
- UTF-8 and special characters in STRING fields
- ISO timestamp roundtrip without mutation

### `batch-inserts`
- All rows have `parent_span_id = NULL`
- All rows have `parent_span_id = <value>`
- Alternating NULL/non-NULL (the exact known Bun.SQL bug pattern)
- Batch sizes: 1, 10, 100, 500 rows
- Rows with different nullable column patterns within the same batch

### `data-types`
- `TIMESTAMP(9)` with sub-millisecond nanoseconds — does GreptimeDB store/return them?
- `TIMESTAMP(3)` millisecond boundary (conversation_items `created_at`)
- `BIGINT UNSIGNED` at 0, 1, `Number.MAX_SAFE_INTEGER`, `2^53`
- `VARCHAR(36)` at exactly 36 chars vs 37 chars (no hard constraint but worth observing)
- Empty string `""` vs `NULL` in VARCHAR columns
- `INT` signed: negative values in `gen_ai_input_tokens`
- `CAST(gen_ai_input_tokens AS BIGINT)` — upcast integer
- `CAST('2024-01-01' AS TIMESTAMP)` — string literal to timestamp
- `CAST(duration_nano AS DOUBLE) / 1e9` — integer to float division
- Invalid cast (`CAST('abc' AS INT)`) — expect error
- Implicit coercion: passing a JS `number` where column is `BIGINT UNSIGNED`

### `query-patterns`
- Cursor pagination: insert 200 rows, page through all 200 in pages of 50 — verify no gaps and no duplicates
- Time range: verify `>` is exclusive (the `AND "timestamp" > ${cutoff}` boundary)
- Tied timestamps (same millisecond): does `ORDER BY timestamp DESC, span_id DESC` produce stable ordering across queries?
- `COUNT(*)` before and after insert matches expected delta
- Empty result set (query with future cutoff date)
- LIMIT exactly at result set boundary (LIMIT 50 when exactly 50 rows match)
- `ORDER BY` multiple columns with mixed ASC/DESC
- `SELECT` specific columns vs `SELECT *` — same rows, subset of fields

### `aggregates`
- `COUNT(*)` vs `COUNT(column)` — do NULLs get excluded from column count?
- `MIN` / `MAX` on `timestamp` — returns correct boundary row
- `SUM` / `AVG` on `gen_ai_input_tokens` across all rows for a tenant
- `GROUP BY gen_ai_system` — correct row counts per group
- `DISTINCT` on `service_name` — returns deduplicated values
- `DISTINCT` on a column with NULLs — NULL appears at most once
- Aggregate over empty result set (no matching rows) — returns NULL or 0?

### `predicates`
- `IS NULL` on `parent_span_id` — returns only rows where field is null
- `IS NOT NULL` on `parent_span_id` — returns only rows where field is set
- `IN (v1, v2, v3)` on `gen_ai_system` — matches all listed values
- `NOT IN (v1, v2)` — excludes listed values; check behaviour when list contains NULL
- `BETWEEN t1 AND t2` on timestamp — inclusive on both ends
- `LIKE 'prefix%'` on `span_name` — prefix match
- `LIKE '%suffix'` on `span_name` — suffix match (may bypass index)
- `LIKE '%middle%'` — full scan substring match
- `CASE WHEN ... THEN ... ELSE ... END` in SELECT — conditional expression
- `LENGTH(span_name)` in WHERE — filter by string length
- `LOWER(gen_ai_system)` in SELECT — case normalization
- `CONCAT(service_name, '-', span_id)` in SELECT — string concatenation
- INVERTED INDEX with special characters in `span_name` (slashes, dots, colons) — tokenization edge case
- BLOOM SKIPPING INDEX: `trace_id` point lookup returns the correct row and non-existent trace_id returns empty

### `datetime-functions`
- `DATE_TRUNC('hour', timestamp)` — buckets rows into hourly bins correctly
- `DATE_TRUNC('day', timestamp)` — daily bucketing
- `DATE_TRUNC('minute', timestamp)` — minute bucketing
- `NOW()` used in WHERE — `WHERE timestamp > NOW() - INTERVAL '1 hour'`
- Interval arithmetic: `timestamp + INTERVAL '30 minutes'`
- `EXTRACT(EPOCH FROM timestamp)` — returns Unix seconds as float
- `EXTRACT(hour FROM timestamp)` — extracts hour component
- Time histogram: `SELECT DATE_TRUNC('hour', timestamp), COUNT(*) GROUP BY 1 ORDER BY 1` — the canonical TSDB query pattern; verifies aggregates and time functions work correctly together

### `append-mode`
- Insert row with PK `(timestamp=T, service_name=S)`, insert again with same PK but different `trace_id` — what comes back?
- Verify UPDATE returns an error (or silently fails)
- Verify DELETE returns an error (or silently fails)
- Insert then immediately query — is the row visible without a flush/compaction?

### `concurrency`
- 50 concurrent `Promise.all` inserts of 10 rows each → `COUNT(*)` must equal 500
- 20 concurrent reads of the same tenant don't deadlock or return partial results
- Mix of concurrent reads and writes to same table — no errors, no lost rows

### `large-payloads`
- Insert span with `gen_ai_input_messages` = 400 KB JSON string, verify roundtrip
- Insert 1000 rows then `SELECT *` — verify all 1000 come back
- Batch insert of 500 rows with large STRING fields — no truncation

### `cross-tenant`
- Insert 100 rows for tenant A, 100 for tenant B into shared `spans` table
- Query with `tenant_id = A` → exactly 100 rows, none from B
- Query with `tenant_id = B` → exactly 100 rows, none from A
- Tenant UUIDs at hex partition boundaries (`0x0...` prefix and `0xf...` prefix)
- `COUNT(*)` with and without tenant filter agree

### `error-handling`
- Query a non-existent table — expect a thrown error, not empty result
- Malformed SQL (syntax error) — error is thrown with message
- After a failed query, the next valid query on the same `sql` instance succeeds (no connection poisoning)
- Passing `undefined` as a parameter — does it become NULL or throw?
- Very long identifier as table name — graceful error

---

## Memory Regression (`memory-regression.ts`)

Run standalone with `bun run tests/memory-regression.ts`. Reports heap before/after each scenario.
Fails if growth exceeds a threshold (suggested: 50 MB over 10k iterations).

### Scenarios

1. **Variable-nullability batches** — insert batches of 10 rows where `parent_span_id` alternates NULL/non-NULL across iterations, 10k times. This is the exact pattern that caused the original Bun.SQL prepared-statement cache OOM. Verifies `prepare: false` holds.

2. **Error path connection leak** — execute an invalid SQL statement 1000 times, measure pool size and heap. Connections must be returned to the pool even after errors.

3. **Large result set GC** — query 1000 rows in a tight loop 500 times, verify heap doesn't grow linearly (result arrays must be GC'd between iterations).

Each scenario prints: iterations, heap before (MB), heap after (MB), delta (MB), pass/fail.
