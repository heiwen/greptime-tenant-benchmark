# Run 3 — Benchmark Analysis

**Date:** 2026-04-09  
**Version:** `v1.0.0-rc.2-nightly-20260330`  
**Cluster:** 1× metasrv, 3× datanode (8 GB / 2 CPU), 2× frontend (24 GB / 2 CPU), HAProxy

## Setup

10 tenants, 5,000 conversations/tenant, 100,000 items/tenant, 5,000 spans/tenant.

Two schema variants were benchmarked:

- **Strategy A:** one table per tenant (e.g. `conversation_items_<tenant_id>`)
- **Strategy B:** single shared table partitioned on `tenant_id` (16 hex-prefix partitions), with `INVERTED INDEX` on `tenant_id`

Each variant was run twice — once with no explicit primary key on `conversation_items` (`CONV_PK=false`) and once with `PRIMARY KEY (tenant_id, conversation_id)` (`CONV_PK=true`).

Workloads, 10 concurrent requests, 120 s each:

| Name | Query |
|---|---|
| `q-conv-clustered` | Full conversation history — items seeded within ±48 h of a single anchor (single-session conversations) |
| `q-conv-scattered` | Full conversation history — items spread randomly across 18 months (long-running conversations) |
| `q-time-1h` | Most recent items for a given tenant + conversation in a 1-hour rolling window |
| `q-time-24h` | Same with a 24-hour window |

---

## Results

### CONV_PK=false (file: `results-combined-2026-04-09T01-57-15.csv`)

| Workload | Strategy | QPS | p50 ms | p99 ms | Errors |
|---|---|---|---|---|---|
| q-conv-clustered | A | 90 | 74 | 450 | 0 |
| q-conv-clustered | B | **276** | **29** | 115 | 0 |
| q-conv-scattered | A | **73** | **111** | 399 | 0 |
| q-conv-scattered | B | 64 | 122 | 470 | 0 |
| q-time-1h | A | **971** | **10** | 16 | 0 |
| q-time-1h | B | 713 | 14 | 22 | 0 |
| q-time-24h | A | **949** | **11** | 16 | 0 |
| q-time-24h | B | 706 | 14 | 22 | 0 |

### CONV_PK=true (file: `results-combined-2026-04-09T02-20-28.csv`)

| Workload | Strategy | QPS | p50 ms | p99 ms | Errors |
|---|---|---|---|---|---|
| q-conv-clustered | A | 75 | 113 | 373 | 0 |
| q-conv-clustered | B | **260** | **31** | 116 | 0 |
| q-conv-scattered | A | **74** | **113** | 407 | 0 |
| q-conv-scattered | B | 43 | 186 | 668 | 0 |
| q-time-1h | A | 1,454 ⚠ | 7 | 12 | 19 |
| q-time-1h | B | 1,158 ⚠ | 8 | 16 | 9 |
| q-time-24h | A | 1,314 ⚠ | 7 | 14 | 18 |
| q-time-24h | B | 682 ⚠ | 14 | 36 | 22 |

⚠ QPS numbers for CONV_PK=true q-time are unreliable — errors inflate throughput figures because failed requests return immediately.

---

## Key findings

### Strategy B is 3× faster for clustered conversations

With `CONV_PK=false`, strategy B serves `q-conv-clustered` at 276 QPS (p50 29 ms) vs. strategy A's 90 QPS (p50 74 ms). Strategy B's tenant partitioning keeps all items for a tenant in a small set of regions, and the `INVERTED INDEX` on `tenant_id` prunes non-matching rows efficiently. This is the dominant production access pattern.

### Strategy A has an edge on time-range and scattered queries

Strategy A leads `q-time` by ~36% (971 vs 713 QPS) and `q-conv-scattered` by ~14% (73 vs 64 QPS). Per-tenant tables are smaller, so a time-range scan touches fewer SST files.

### CONV_PK=true is net negative

Adding `PRIMARY KEY (tenant_id, conversation_id)` was expected to co-locate conversation items physically in SST files and speed up the full-history query. In practice it makes things worse across the board:

- **q-conv-clustered:** −17% on strategy A, −6% on strategy B. The series cardinality increase (1 series/tenant → 5,000 series/tenant) adds more overhead than the co-location saves.
- **q-conv-scattered:** −33% on strategy B (43 vs 64 QPS). Higher cardinality means more regions to open for a scattered-time scan.
- **q-time:** nominally faster QPS but with errors — results are not valid (see below).

### CONV_PK=true triggers Arrow Flight resource exhaustion

Under concurrent load with 50,000 series (5,000 conversations × 10 tenants), the frontend exhausts its Arrow Flight (gRPC/HTTP2) connection pool to the datanodes during `merge_scan_region`. Queries fail with `code: Some resource has been exhausted` / `h2 protocol error: http2 error`. The same workload on the no-PK table (10 series) produces zero errors. Filed as a separate bug report.

---

## Recommendation

Use **strategy B, CONV_PK=false**:

- Best performance on the dominant access pattern (clustered conversation history, 276 QPS, p50 29 ms)
- Stable under concurrent load — no errors in any run
- Acceptable performance on time-range queries (713–706 QPS) and scattered conversations (64 QPS)
