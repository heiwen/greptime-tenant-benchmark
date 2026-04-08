# Run2 Benchmark Analysis

**Date**: 2026-04-07  
**Cluster**: 3 datanodes × (2 vCPU / 8 GiB) + 2 frontends, HAProxy LB  
**Image**: `greptime/greptimedb:v1.0.0-rc.2-nightly-20260330`  
**Scale**: 100 tenants, 500k spans/tenant, 1M conversation items/tenant

Two back-to-back sessions were run with zero errors across all scenarios:

| Session | Timestamp |
|---|---|
| Session 1 | 2026-04-07T09:55 |
| Session 2 | 2026-04-07T13:45 |

Results between sessions are consistent; averages below use both unless noted.

A prior attempt (`run2/run1`, 03:37) produced high error rates across most scenarios and is excluded from analysis.

---

## Summary

**Strategy A (per-tenant tables) wins across nearly every scenario.** Query throughput is 1.3–2.4× higher, write latency is 10–25% lower, and the expected cache-pressure collapse under 50-tenant concurrency did not materialise.

---

## Write Performance

### W2 — Span batch ingest (S1, 5 spans/batch)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 1 | 5 ms | 21 ms | 153 | 6 ms | 22 ms | 138 |
| 10 | 65 ms | 124 ms | 141 | 76 ms | 141 ms | 121 |
| 50 | 365 ms | 2560 ms | 115 | 348 ms | 1548 ms | 132 |

A leads at 1–10 VU. At 50 VU the strategies converge on p50, but B shows lower p99 in session 2 (704 ms vs 1624 ms), suggesting B handles write contention better at high concurrency. The run-to-run variance in p99 at 50 VU is high for both — this metric is dominated by occasional compaction stalls rather than steady-state performance.

### W1 — Conversation item insert (S2, sequential per conversation)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 1 | 20 ms | 32 ms | 50 | 26 ms | 66 ms | 37 |
| 10 | 211 ms | 326 ms | 47 | 233 ms | 385 ms | 43 |
| 50 | 1057 ms | 1707 ms | 47 | 1210 ms | 1863 ms | 41 |

A is consistently faster by ~15–25% at low concurrency, converging at 50 VU. The QPS plateau from 10 → 50 VU (both strategies) is expected: W1 is sequential within each conversation, so concurrency above the number of distinct conversations provides no throughput benefit.

---

## Query Performance

### S1 — Spans

#### Time-range queries (Q-time)

| Window | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio (QPS) |
|---|---|---|---|---|---|---|---|
| 1 h | 100 ms | 118 ms | 99 | 155 ms | 198 ms | 62 | **1.6×** |
| 24 h | 112 ms | 125 ms | 87 | 179 ms | 222 ms | 56 | **1.6×** |
| 7 d | 128 ms | 138 ms | 78 | 314 ms | 445 ms | 31 | **2.5×** |

The performance gap widens with the time window. Strategy A scans only one tenant's SST files; Strategy B scans all 16 partitions and filters by `tenant_id`, making wider windows disproportionately expensive for B.

#### Cursor pagination (Q-id)

| A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio (QPS) |
|---|---|---|---|---|---|---|---|
| 171 ms | 196 ms | 58 | 332 ms | 454 ms | 30 | **1.9×** |

Cursor queries require a composite sort on `(timestamp, span_id)` across the tenant's data. Strategy B's additional `tenant_id` predicate and larger partition scans drive the gap.

#### Full row fetch (Q-full, SELECT *)

| A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 25.8 s | 31 s | 0.38 | 35.1 s | 50 s | 0.27 |

Both strategies are extremely slow (~20–60 s per query). The `gen_ai_input_messages` and `gen_ai_output_messages` columns dominate: at the benchmark's row-size distribution (35% medium ~20 KB, 12% large ~90 KB, 3% XL ~430 KB), fetching 50 full rows returns tens of MB. **Avoid `SELECT *` on spans in production; always project away the message payload columns.**

The A/B gap here (1.4×) shows that columnar projection still benefits A, but the absolute numbers are bad for both. This is a schema/query concern, not a strategy selection concern.

### S2 — Conversation items

#### Time-range queries

| Window | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio (QPS) |
|---|---|---|---|---|---|---|---|
| 1 h | 70 ms | 89 ms | 143 | 93 ms | 107 ms | 108 | **1.3×** |
| 24 h | 110 ms | 144 ms | 91 | 108 ms | 143 ms | 93 | ~tie |
| 7 d | 120 ms | 145 ms | 84 | 188 ms | 230 ms | 53 | **1.6×** |

S2 follows the same pattern as S1 but with a smaller margin. The 24 h window is essentially tied — Strategy B's BLOOM index on `conversation_id` provides effective filtering that partially compensates for the shared-table overhead at this window size.

#### Cursor pagination

| A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 222 ms | 276 ms | 45 | 315 ms | 356 ms | 32 | **1.4×** |

---

## Memory Pressure (M1–M4)

The benchmark's primary hypothesis: at 50 concurrent readers each hitting a different tenant, Strategy A's per-tenant SST files cause cache thrashing and latency degrades.

**The hypothesis was not confirmed.**

| Scenario | Tenant diversity | A p50 | A QPS | B p50 | B QPS |
|---|---|---|---|---|---|
| M1 | 1 tenant | 703 ms | 71 | 989 ms | 50 |
| M2 | 5 tenants | 606 ms | 83 | 878 ms | 57 |
| M3 | 50 tenants | 538 ms | 93 | 691 ms | 72 |
| M4 (B only) | 50 tenants | — | — | 692 ms | 73 |

Both strategies *improve* as tenant diversity increases from 1 to 50. The dominant effect at low diversity is write/read contention: 50 VUs hammering a single tenant (M1) serialises against the same WAL, memtable, and index structures. Spreading load across 50 tenants removes that contention, and each query runs independently.

Strategy A outperforms Strategy B at every diversity level. M4 confirms that M3's result for B is reproducible (m4 and m3 are identical in parameters for Strategy B).

**What's missing**: the Prometheus scrape data (cache hit/miss rates, memtable usage, open file counts) was not captured in this run — all scrape files contain empty metrics due to a misconfigured `GREPTIMEDB_PROMETHEUS_URLS`. Without those metrics, it is not possible to confirm whether Strategy A's cache actually held up at 100 tenants, or whether the block cache was simply large enough to fit all active working sets. This must be verified in the next run.

---

## Mixed Workload

70% Q-time (1 h), 15% Q-id, 10% W2, 5% W1, uniform tenant selection.

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio (QPS) |
|---|---|---|---|---|---|---|---|
| 10 | 59 ms | 1393 ms | 91 | 74 ms | 1793 ms | 70 | **1.3×** |
| 50 | 253 ms | 6225 ms | 103 | 385 ms | 9798 ms | 68 | **1.5×** |
| 100 | 560 ms | 14415 ms | 92 | 744 ms | 19433 ms | 70 | **1.3×** |

A sustains ~30–50% higher throughput. The p99 spikes at 50–100 VU are driven by occasional large-span ingest batches (XL tier, ~430 KB) landing in the mixed write fraction.

Strategy B's throughput is relatively flat across 10–100 VU (68–70 QPS), suggesting it hits a fixed bottleneck earlier — likely the shared table's partition routing or `tenant_id` index overhead. Strategy A scales more gracefully up to 50 VU before also plateauing.

---

## Conclusions

1. **Use Strategy A at 100 tenants.** It is faster across reads, writes, and mixed workloads at this scale. The per-tenant table overhead (memory, compaction threads, open file handles) was not a visible bottleneck.

2. **The cache-pressure crossover point is not yet known.** The M1→M3 result contradicts the hypothesis but cannot be fully explained without cache hit/miss data. Run with Prometheus scraping fixed before drawing conclusions about scalability beyond 100 tenants.

3. **`SELECT *` on spans is a production anti-pattern.** Both strategies return 50 full rows in 20–60 seconds due to message payload column sizes. Enforce projection in all query paths.

4. **Strategy B's 24 h S2 window is competitive.** At this specific workload (conversation items, 24 h window), B's BLOOM index on `conversation_id` nearly closes the gap. If S2 is the dominant workload and 24 h dashboards are the primary query, B is not clearly inferior.

5. **Next step: 1000-tenant run.** BENCHMARK.md anticipated a follow-up at 1 000 tenants to find the Strategy A crossover point. The current results give no signal that the crossover is below 100 tenants, but 200 per-tenant tables (100 tenants × 2 schemas) at this data volume has not been stress-tested for background compaction overhead or startup time.
