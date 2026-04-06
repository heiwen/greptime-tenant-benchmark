# Frontend memory leak: linear RSS growth during INSERT with many-column schema

## Version

`greptime/greptimedb:v1.0.0-rc.2-nightly-20260330` — [GreptimeTeam/greptimedb](https://github.com/GreptimeTeam/greptimedb)

## Summary

The GreptimeDB frontend leaks memory during INSERT into an `append_mode = true` table when the schema has enough columns. For the full 28-column schema, RSS grows at ~26 MB per 1,000 rows and does not stabilise; the rate scales proportionally with column count. The frontend was OOM-killed at 138K rows with RSS at ~4 GiB.

The threshold is somewhere between 4 and 5 columns: a 4-column schema is stable at 385K rows; a 5-column schema leaks at ~5 MB/1K rows. Row size uniformity does not matter — uniform-size batches leak at the same rate as variable-size batches. Partitioning and index definitions are not required to trigger the leak.

## Environment

Reproduced on two hosts:

- **macOS 15** (Darwin 25.2.0), Docker Desktop
- **AWS EC2 `r6i.4xlarge`** — 16 vCPU, 128 GiB RAM, Amazon Linux 2023 (x86_64), EBS gp3

Both run GreptimeDB inside Linux Docker containers.

## Cluster setup

3 datanodes + 1 frontend, PostgreSQL-backed metasrv. See `docker-compose.cluster.yml`.

## Reproducing the leak

**Table schema** ([`oom-repro/repro.ts`](https://github.com/heiwen/greptime-tenant-benchmark/blob/master/oom-repro/repro.ts)):

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
PARTITION ON COLUMNS (tenant_id) ( /* 16 hex-range partitions */ )  -- not required; unpartitioned also leaks
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

**Observed memory growth** (`repro-frontend`):

| Rows inserted | Memory |
|---|---|
| 33,000 | 1.32 GiB |
| 69,000 | 2.20 GiB |
| 105,000 | 3.12 GiB |
| 138,000 | 3.97 GiB → **OOMKilled** |

Growth rate: ~26 MB / 1,000 rows.

**Run `repro.ts` to reproduce** ([heiwen/greptime-tenant-benchmark/oom-repro](https://github.com/heiwen/greptime-tenant-benchmark/tree/master/oom-repro)):

```
cd oom-repro
docker compose -f docker-compose.cluster.yml up -d
bun run repro.ts
```

## Isolation tests

| Schema | Row size | Rows tested | Peak RSS | Leak? |
|---|---|---|---|---|
| 4-column | Uniform ~20 KB | 385,000 | 330 MiB | No |
| **5-column** | **Uniform ~20 KB** | **193,000** | **1.28 GiB** | **Yes** |
| 7-column | Variable 2–430 KB | 475,000 | 3.0 GiB | Yes |
| 8-column | Variable 2–430 KB | 449,000 | 2.8 GiB | Yes |
| 10-column | Variable 2–430 KB | 337,000 | ~4 GiB | Yes |
| 12-column | Variable 2–430 KB | 309,000 | ~4 GiB | Yes |
| 17-column | Variable 2–430 KB | 193,000 | ~4.2 GiB | Yes |
| 28-column, no indexes | Variable 2–430 KB | 156,000 | 4.3 GiB | Yes |
| 28-column | Uniform ~20 KB | 160,000 | ~4.25 GiB | Yes |
| 28-column, no partitioning | Uniform ~20 KB | 125,000 | ~3.5 GiB | Yes |

All tests connect directly to a single frontend. Key findings:

- **The leak rate scales proportionally with column count**: ~6 MB/1K rows at 7 columns, ~26 MB/1K rows at 28 columns, consistent with ~(col/28) × 26 MB/1K
- **A 4-column schema does not leak** at 385K rows; a 5-column schema leaks at ~5 MB/1K rows — the threshold is between 4 and 5 columns
- **Uniform row sizes also leak** at the same rate — row size variation is not required
- **Index definitions are not required** — removing all indexes from the 28-column schema does not change the leak rate
- **Partitioning is not required** — an unpartitioned 28-column table leaks at the same rate

## Source code investigation

A read-through of the GreptimeDB frontend source by AI was done to understand the mechanism. The heap profiling (see below) suggests a true reference leak, but the exact allocation site was not identified — a flamegraph heap profile would be needed to pinpoint it. What follows is the current best hypothesis based on the source reading and the proportional scaling finding.

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

Growing RSS could in principle be explained by jemalloc heap fragmentation — dirty pages accumulating in the allocator without being returned to the OS — rather than a true reference leak. To distinguish between the two, `sys_jemalloc_allocated` (live bytes held by the application) was polled alongside RSS while running the full repro workload:

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

A flamegraph heap profile (via GreptimeDB's `/debug/prof/mem` endpoint, which requires the binary to be built with `MALLOC_CONF=prof:true`) would show which allocation site is responsible for the retained ~24 MB/1K rows. The `allocated` growth rate scales proportionally with column count across all tested schemas (5–28 columns), consistent with a per-parameter retention mechanism: a 28-column × 100-row batch produces 2,800 bound parameters, and retaining those would account for the observed growth rate.

### Worthwhile improvement: reduce plan cloning in the SQL INSERT path

The `plan.clone()` calls at `instance.rs:646` and `datafusion.rs:132` cause copies 2, 3, and 4 to coexist in memory simultaneously, multiplying peak in-flight memory for large batches. Eliminating these redundant clones would meaningfully reduce per-request memory pressure — independently of the leak. They are not the root cause of persistent retention (both are local variables that are freed when the request completes), but removing them is a low-risk improvement that makes the pipeline cheaper regardless.
