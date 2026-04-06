# Frontend memory leak: linear RSS growth with variable-size rows in partitioned table

## Version

`greptime/greptimedb:v1.0.0-rc.2-nightly-20260330`

## Summary

The GreptimeDB frontend leaks memory during INSERT into a partitioned `append_mode = true` table when batches contain rows of variable sizes. RSS grows at ~26 MB per 1,000 rows and does not stabilise. The frontend was OOM-killed by the host at 138K rows with RSS at ~4 GiB; the frontends have no `mem_limit` set in the compose file (only datanodes do).

The leak seems to require two conditions to be present simultaneously:
1. A table with multiple columns including large `STRING` fields (the full spans schema)
2. INSERT batches where rows have varying field sizes (the tier distribution produces mixed 2 KB–430 KB rows)

Uniform-size batches — even at 430 KB per row — do not leak.

## Cluster setup

3 datanodes + 2 frontends behind HAProxy, PostgreSQL-backed metasrv. Same topology as the benchmark's `docker-compose.yml`.

## Reproducing the leak

**Table schema** (`repro.ts`):

```sql
CREATE TABLE spans (
  tenant_id VARCHAR(36) NOT NULL INVERTED INDEX,
  "timestamp" TIMESTAMP(9) NOT NULL TIME INDEX,
  timestamp_end TIMESTAMP(9),
  duration_nano BIGINT UNSIGNED,
  trace_id VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=10240),
  span_id VARCHAR(16) NOT NULL,
  -- ... 22 more columns including:
  gen_ai_input_messages STRING,   -- up to 400 KB
  gen_ai_output_messages STRING,  -- up to 20 KB
  span_attributes STRING,
  PRIMARY KEY (service_name)
)
PARTITION ON COLUMNS (tenant_id) ( /* 16 hex-range partitions */ )
WITH ('append_mode' = 'true')
```

**Insert workload**: 100 rows per batch, 100 UUID tenants, rows randomly drawn from a tier distribution:

| Tier | Share | Row size |
|---|---|---|
| tiny | 10% | ~2 KB |
| small | 40% | ~5 KB |
| medium | 35% | ~20 KB |
| large | 12% | ~90 KB |
| xlarge | 3% | ~430 KB |

**Observed memory growth** (frontend1, other frontend idle):

| Rows inserted | Memory |
|---|---|
| 33,000 | 1.32 GiB |
| 69,000 | 2.20 GiB |
| 105,000 | 3.12 GiB |
| 138,000 | 3.97 GiB → **OOMKilled** |

Growth rate: ~26 MB / 1,000 rows.

**Run `repro.ts` to reproduce:**

```
cd oom-repro
docker compose -f docker-compose.cluster.yml up -d
bun run repro.ts
```

## Isolation tests

The following tests were run to narrow down which conditions trigger the growth:

| Test | Schema | Row size | Rows tested | Peak memory | Leak? |
|---|---|---|---|---|---|
| A | Full spans (25 col) | Uniform tiny (~100 B) | 2,400,000 | 465 MiB | No |
| B | Simple 4-column | Uniform xlarge (430 KB) | 70,000 | 1,045 MiB | No |
| C | Full spans (25 col) | Uniform xlarge (430 KB) | 50,000 | 1,232 MiB | No |
| D | Full spans (25 col) | Uniform medium (~20 KB) | 1,850,000 | 525 MiB | No |
| E | Simple 4-column | Uniform-random 2–430 KB | 146,000 | 944 MiB | No |
| **F** | **Full spans (25 col)** | **Mixed tiny/small/medium (max 20 KB)** | **174,000** | **3.88 GiB** | **Yes** |
| **Full** | **Full spans (25 col)** | **Full tier distribution** | **138,000** | **3.97 GiB** | **Yes** |

Key observations:
- Schema complexity alone did not trigger the leak (Test A: 2.4M rows, stable)
- Large payloads alone did not trigger the leak (Tests B, C: stable)
- A simplified 4-column schema did not leak under any conditions tested, including variable 2–430 KB payloads
- **Mixed row sizes with the full schema triggered the leak** (Test F: leaks even with 20 KB ceiling)
- The growth rate is similar in Tests F and Full (~26 MB/1K rows), whether or not xlarge rows are present

## Source code investigation

A read-through of the GreptimeDB frontend source was done by AI to try to understand the mechanism. No definitive root cause was identified — a heap profile (see below) would be needed to confirm. What follows is the current best hypothesis based on that reading.

### Observed: SQL INSERT pipeline passes data through multiple copies

For each `INSERT` batch, the PostgreSQL (and MySQL) extended-query handler can be traced through at least six points where string data is copied before it is serialised onto the wire:

| Step | Source location | What happens |
|---|---|---|
| 1 | `servers/src/postgres/types.rs:446` | `portal.parameter::<String>()` copies each bind parameter into an owned `String`; for a 100-row × 28-column batch this produces 2,800 `ScalarValue::LargeUtf8(String)` heap allocations |
| 2 | `servers/src/postgres/handler.rs:449` | `plan.clone().replace_params_with_values(…)` deep-clones every `ScalarValue`, embedding all 2,800 strings into a new `LogicalPlan` |
| 3 | `frontend/src/instance.rs:646` | `query_engine.execute(plan.clone(), …)` deep-clones the plan a second time |
| 4 | `query/src/datafusion.rs:132` | `(*dml.input).clone()` clones the VALUES sub-plan into `ValuesExec`, which holds every string as a `Literal` physical expression |
| 5 | `api/src/helper.rs:997` | `vectors_to_rows` iterates over the Arrow `RecordBatch` produced from step 4 and copies each string cell into a new owned `String` for the gRPC `RegionInsertRequest` |
| 6 | gRPC layer | Prost serialises the `RegionInsertRequest` to a byte buffer |

Copies 2, 3, and 4 appear to coexist in memory simultaneously: the `plan` variable (copy 2) and the `dml` variable (copy 3) are both still in scope while the stream from copy 4 is being consumed in `exec_dml_statement`. No persistent cache or explicit reference leak was found — all of these copies appear to be freed once the request completes.

The MySQL handler (`servers/src/mysql/handler.rs:311`) follows the same path: it calls `plan.clone().replace_params_with_values(…)` and then `do_exec_plan`, reaching steps 3–6 identically. The leak would be expected under MySQL with the same workload.

### OTLP takes a different path

The OTLP trace handler (`servers/src/otlp/trace/v1.rs`) does not go through SQL execution at all. It parses the protobuf payload and builds `RowInsertRequests` directly using `row_writer` functions, then calls `handle_trace_inserts` on the operator, skipping steps 1–5 entirely. The operator-level partition split (`splitter.rs:88`) uses `std::mem::take` to move rows into partition buckets without copying string data, so the row strings are moved rather than copied through the entire pipeline. The net result is roughly two copies (protobuf parse → owned `String`, then Prost serialisation to wire bytes) vs five or six for the SQL path. 

### Heap profile confirms a true reference leak

The jemalloc fragmentation hypothesis was tested by polling `sys_jemalloc_allocated` (live bytes held by the application) alongside RSS while running the full repro workload:

| Rows inserted | allocated | resident | RSS |
|---|---|---|---|
| 7,000 | 303 MiB | 579 MiB | 704 MiB |
| 17,000 | 518 MiB | 861 MiB | 924 MiB |
| 36,000 | 969 MiB | 1,316 MiB | 1.42 GiB |
| 55,000 | 1,429 MiB | 1,842 MiB | 1.93 GiB |
| 79,000 | 2,005 MiB | 2,470 MiB | 2.39 GiB |
| 101,000 | 2,513 MiB | 3,008 MiB | 2.99 GiB |
| 121,000 | 3,027 MiB | 3,542 MiB | 3.48 GiB |
| 141,000 | 3,490 MiB | 4,087 MiB | 3.97 GiB → **OOMKilled** |

**`allocated` grows at ~24 MB/1K rows, tracking RSS almost exactly.** jemalloc's `allocated` counter only includes live (not yet freed) bytes — fragmentation does not contribute to it. The fragmentation hypothesis is ruled out. Something is retaining references to row data and never freeing it.

The source code investigation did not find an obvious accumulation site, so the root cause within the code remains unidentified.

### Suggested next steps

A flamegraph heap profile (via GreptimeDB's `/debug/prof/mem` endpoint, which requires the binary to be built with `MALLOC_CONF=prof:true`) would show which allocation site is responsible for the retained ~24 MB/1K rows. The `allocated` growth rate of ~24 MB/1K rows against an average row payload of ~33 KB suggests roughly 70% of each row's data is being held alive somewhere after the INSERT completes.

### What reducing plan cloning would and would not fix

The `plan.clone()` calls at `instance.rs:646` and `datafusion.rs:132` increase peak in-flight memory per request but do not by themselves explain persistent retention — those clones are local variables that should be freed when the request completes. Eliminating them is still worthwhile to reduce peak memory pressure, but is unlikely to fix the leak.

Note: jemalloc allocator tuning (`dirty_decay_ms`, `background_thread`) has no effect on a true reference leak and is not a useful mitigation here.
