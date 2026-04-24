# Run5 Benchmark Analysis

**Date**: 2026-04-23
**Cluster**: 3 datanodes × (2 vCPU / 8 GiB) + 2 frontends, HAProxy LB
**Image**: `greptime/greptimedb:v1.0.0` (stable)
**Scale**: 100 tenants, 500k spans/tenant, 1M conversation items/tenant, 50k conversations/tenant

Single session, zero errors on all write and memory-pressure scenarios. Small error counts remain on S2 time-range reads (noted per-section). All workloads ran at 10 VUs / 120 s unless otherwise stated.

Schema/seeding changes since run4:
- Strategy A: removed the partition clause entirely (single unpartitioned table per tenant).
- Strategy B: kept `PRIMARY KEY (tenant_id)` and the high-cardinality partition columns — S1 partitions on `trace_id`, S2 on `conversation_id`. Within each partition, one tenant's rows cluster contiguously under the tenant-id PK; across partitions, each tenant is fanned out 16-way.
- Seeding: stratified timestamps for scattered paths, sorted timestamps within clustered conversation batches, monotonic per-item timestamp offsets in W1 inserts.

---

## Summary

**Strategy A remains the recommended choice, with a much healthier profile under mixed load.** Run5's headline change is the collapse of A's Q-id cursor pagination latency (583 ms → 32 ms p50, +33× QPS) and a corresponding 8–10× improvement in mixed-workload throughput across all concurrency levels. The 134-second B Q-id catastrophe from run4 partially recovered but is still production-broken at 38 s p50. Strategy B's S1 time-range reads regressed 7–17× — driven by the non-selectable partition column (`trace_id` for spans): every tenant query fans out to all 16 partitions and the frontend merge-sorts 16 streams to honour the global `ORDER BY timestamp DESC`. S2 Q-time improved materially for both strategies because the `conversation_id` equality filter prunes B to a single partition.

---

## Write Performance

### W2 — Span batch ingest (S1, 5 spans/batch)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 1 | 6 ms | 14 ms | 142 | 6 ms | 14 ms | 144 |
| 10 | 8 ms | 60 ms | 1,029 | 8 ms | 28 ms | 1,153 |
| 50 | 30 ms | 82 ms | 1,559 | 31 ms | 86 ms | 1,528 |

W2 throughput improved for both strategies at every concurrency level compared to run4 — most visibly at 10 VU where B jumped from 831 to 1,153 QPS (+39%) and A from 856 to 1,029 QPS (+20%). B's p99 at 10 VU halved (68 → 28 ms). For writes, the high-cardinality `trace_id` partition column is actively *helpful*: each batch of 5 spans (one trace) lands in a single partition, and different traces spread evenly across all 16 — producing balanced per-partition write load with no cross-partition coordination. At 50 VU B is now marginally behind A in throughput (1,528 vs 1,559) but with comparable p99 (86 vs 82 ms) — run4's 176 ms B p99 is gone.

### W1 — Conversation item insert (S2, sequential per conversation)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 1 | 40 ms | 71 ms | 24 | 41 ms | 69 ms | 24 |
| 10 | 55 ms | 99 ms | 179 | 58 ms | 101 ms | 172 |
| 50 | 163 ms | 271 ms | 305 | 168 ms | 282 ms | 295 |

Small but consistent improvement over run4 (~10% at 10 VU). Strategies remain effectively tied; the write path is not a differentiator.

---

## Query Performance

### S1 — Spans

#### Time-range queries (Q-time, 10 VU)

| Window | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio |
|---|---|---|---|---|---|---|---|
| 1 h | 67 ms | 160 ms | 144 | 1,058 ms | 2,077 ms | 9.1 | **15.9×** |
| 24 h | 66 ms | 160 ms | 146 | 1,066 ms | 2,087 ms | 8.9 | **16.4×** |
| 7 d | 65 ms | 157 ms | 148 | 8,321 ms | 13,586 ms | 1.1 | **134×** |

A is slightly slower than run4 (54 → 67 ms p50 on 1h) but throughput remains stable across window widths. **B regressed sharply**: 1h went from 150 → 1,058 ms p50, 7d from 514 → 8,321 ms. The query filters on `tenant_id` and `timestamp` but *not* on `trace_id`, so B's planner cannot prune any of the 16 partitions — each query fans out to all datanodes and the frontend merge-sorts 16 streams to honour `ORDER BY timestamp DESC`. Within each partition, the tenant's ~31k rows must be scanned (PK=tenant_id means the rows are contiguous, but every partition contains some rows for every tenant). Why worse than run4: the combination of stratified seeding (more, narrower-time-range SSTs per partition), increased per-query planning overhead from the 16-way fan-out, and the `service_name` column no longer being the series key (in run4 that skipping-BLOOM attribute probably helped prune SST blocks) all compound.

#### Cursor pagination (Q-id, S1, 10 VU)

| A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio |
|---|---|---|---|---|---|---|
| 32 ms | 117 ms | 252 | 37,955 ms | 89,485 ms | 0.19 | **1,326× (QPS)** |

**Strategy A's cursor pagination is transformed**: p50 dropped from 583 ms to 32 ms (18× faster) and QPS rose from 7.6 to 252 (33× higher). Stratified seeding timestamps mean recent rows cluster in recent SSTs instead of being smeared across every SST in the table — the cursor range predicate now prunes most files. Strategy B improved too (134 s → 38 s p50, 0.08 → 0.19 QPS) but remains production-broken: every query still takes over half a minute. Q-id pays B's full tax: (1) no `trace_id` filter → all 16 partitions fan out; (2) no time lower bound (only `timestamp < cursor_ts`) → SST time-pruning is weak and the working set grows as pagination walks back through 18 months of history; (3) the tie-breaker `span_id` is not part of the PK, so each partition re-sorts candidate rows on `(timestamp DESC, span_id DESC)` before merging upstream.

### S2 — Conversation items

#### Time-range queries (Q-time, S2, 10 VU)

| Window | A p50 | A p99 | A QPS | A errors | B p50 | B p99 | B QPS | B errors |
|---|---|---|---|---|---|---|---|---|
| 1 h | 16 ms | 50 ms | 546 | 29 | 23 ms | 48 ms | 424 | 15 |
| 24 h | 16 ms | 50 ms | 545 | 36 | 23 ms | 48 ms | 422 | 20 |
| 7 d | 28 ms | 88 ms | 294 | 5 | 39 ms | 127 ms | 220 | 2 |

Both strategies improved substantially on S2 Q-time. B at 24h window went from 142 → 422 QPS (3×); 7d went from 59 → 220 QPS (3.7×). A/B ratio narrowed from 2.4–6.6× (run4) to 1.3–1.8× (run5) — S2 access is now roughly comparable between strategies. The reason this workload escapes B's fan-out tax is that S2 is partitioned on `conversation_id` *and* the query filters `conversation_id = ?` — the planner prunes to a single partition. Smaller S2 rows and no JSON payload columns compound the advantage, but the pruning is what keeps B within 1.3× of A.

Errors remain on 1h and 24h windows (~0.05% rate) and are unchanged in character from run4.

#### Cursor pagination (Q-id, S2, 10 VU)

| A p50 | A p99 | A QPS | A errors | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 45 ms | 191 ms | 186 | 9 | 1,345 ms | 7,380 ms | 4.4 |

Strategy A is essentially flat vs run4 (42 → 45 ms p50). Strategy B improved 2× in p50 (2,650 → 1,345 ms) and QPS (2.3 → 4.4). A leads by 42× on throughput. Unlike S1 Q-id, this workload *does* filter on the partition column (`conversation_id = ?`) — so it should prune B to a single partition and the 42× penalty is not fan-out. Likely causes worth investigating with `EXPLAIN ANALYZE`: (a) the cursor's disjunctive predicate `(created_at < x OR (created_at = x AND id < y))` may defeat the BLOOM skipping index on `conversation_id` that the first (pure-equality) call uses cleanly; (b) the extra `tenant_id = ?` filter combined with the PK=tenant_id clustering may cause the planner to pick a suboptimal access order once the cursor predicate is present.

### Conversation history (Q-conv, S2, 10 VU)

| Workload | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio |
|---|---|---|---|---|---|---|---|
| Clustered | 167 ms | 532 ms | 50 | 2,916 ms | 12,324 ms | 2.7 | **18.7×** |
| Scattered | 390 ms | 1,507 ms | 20 | 4,674 ms | 10,271 ms | 2.0 | **9.9×** |

A's clustered p50 got *slower* (57 → 167 ms), likely because sorting clustered items within the per-conversation batch at seed time changed the SST layout — rows for one conversation are now interleaved differently. B improved significantly on both (clustered 8,861 → 2,916 ms, scattered 9,189 → 4,674 ms), narrowing the ratio from 142×/24× in run4 to 19×/10× here. Partition alignment helped B pay less overhead per scan, though the full-table filter by `conversation_id` (BLOOM) still drives multi-second latency.

---

## Memory Pressure (M1–M3)

50 VUs, 5 minutes, S1 Q-time (24h window). Tenant diversity varies.

| Scenario | Tenants | A p50 | A QPS | B p50 | B QPS |
|---|---|---|---|---|---|
| M1 | 1 | 441 ms | 89 | 1,981 ms | 22.6 |
| M2 | 5% (5) | 70 ms | 376 | 1,258 ms | 39.2 |
| M3 | 50% (50) | 30 ms | 878 | 1,234 ms | 40.1 |
| M4 (B only) | 50% (50) | — | — | 1,225 ms | 40.2 |

**Both strategies regressed across the board versus run4.** A's M1 went from 68 ms / 713 QPS to 441 ms / 89 QPS; B's M1 from 435 ms / 108 QPS to 1,981 ms / 22.6 QPS. The M1 case (single tenant, same query repeated) should be near-free if the working set is cached, so a 5–8× slowdown here is surprising. Candidate causes: (1) schema-optimization commit changed row/SST layout in a way that increases per-query scan work, (2) fewer parallel partitions for B means single-datanode bottleneck for a lone tenant, (3) the stratified seeding produced larger or more numerous SST files than the prior random distribution.

The M1 → M3 improvement pattern for A is still intact (diversity spreads load across more tables and improves QPS from 89 to 878), and B's M1 → M4 is also consistent with run4's shape. The *absolute level* is what dropped. Prometheus scrapes should be compared head-to-head with run4's to confirm whether cache hit rates are still >99%.

---

## Mixed Workload

70% Q-time (1h S1), 15% Q-id (S1), 10% W2, 5% W1. Uniform tenant selection. 15-minute runs.

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | B errors |
|---|---|---|---|---|---|---|---|
| 10 | 63 ms | 278 ms | 130 | 193 ms | 136,635 ms | 1.4 | 0 |
| 50 | 76 ms | 1,499 ms | 312 | 288 ms | 772,405 ms | 0.67 | 40 |
| 100 | 125 ms | 2,696 ms | 384 | 3,186 ms | 802,301 ms | 0.71 | 50 |

**Strategy A's mixed workload is effectively fixed.** 10 VU p99 dropped from 3,589 ms to 278 ms (13× better). 50 VU p99 from 25,459 to 1,499 ms (17×). 100 VU p99 from 29,512 to 2,696 ms (11×). Throughput climbs monotonically with concurrency (130 → 312 → 384 QPS) instead of collapsing. The driver is the Q-id improvement: 15% of requests no longer stall for hundreds of milliseconds.

**Strategy B remains non-viable under mixed load.** Q-id at 38 s p50 still dominates whenever a VU lands on that workload, and errors now appear at 50 VU (40) and 100 VU (50) — run4 had none. Throughput is 1.4 QPS at 10 VU (better than run4's 0.33) but drops at higher concurrency as queue contention grows.

---

## Comparison with Previous Runs

| Workload | Run4 A/B | Run5 A/B | Direction |
|---|---|---|---|
| S1 Q-time 1h | 3.3× | 15.9× | A advantage widened (B regressed) |
| S1 Q-time 7d | 12.9× | 134× | A advantage widened sharply (B regressed) |
| S1 Q-id | 95× | 1,326× | A dramatically improved; B still broken |
| S2 Q-time 1h | 2.4× | 1.3× | Gap narrowed — both improved |
| S2 Q-time 7d | 6.6× | 1.3× | Gap narrowed sharply |
| Q-conv clustered | 142× | 19× | Gap narrowed (A slower, B faster) |
| Q-conv scattered | 24× | 9.9× | Gap narrowed |
| Mixed 10 VU | 136× | 94× | Both improved; A much more |
| Mixed p99 (10 VU) | 3,589 ms | 278 ms | A now usable under mixed load |

A's win on S1-heavy workloads has widened; B's win would need to come from S2 patterns where the gap is now slim.

---

## Conclusions

1. **Strategy A is the clear choice, now with a usable mixed-workload profile.** The run4 mixed-workload p99 disasters (25–30 seconds) are resolved. A scales cleanly to 100 VU with sub-3-second p99.

2. **The stratified/sorted timestamp fix was the single biggest improvement.** A's Q-id p50 went from 583 ms to 32 ms — an 18× cut that cascades into the mixed-workload result. This validates the seeding-order hypothesis from the prior session.

3. **Strategy B's partition column drives most but not all of the gap.** Queries whose `WHERE` clause includes the partition column prune to 1 partition and sit within 1.3–42× of A depending on other factors. Queries that don't filter the partition column fan out to all 16 partitions and merge-sort upstream, which is where the catastrophic gaps live. The approximate ladder:
   - **1.3× — S2 Q-time** — `conversation_id = ?` prunes to 1 partition; BLOOM index on `conversation_id` makes the lookup near-point.
   - **16× — S1 Q-time** — no `trace_id` filter, so full 16-partition fan-out; the 1-hour time bound keeps per-partition scan small.
   - **42× — S2 Q-id** — `conversation_id = ?` prunes to 1 partition (so *not* fan-out), but the disjunctive cursor predicate likely defeats the BLOOM index after the first page, and the extra `tenant_id = ?` filter may steer the planner into a suboptimal access order. Needs `EXPLAIN ANALYZE` to confirm.
   - **1,326× — S1 Q-id** — compounds every factor: no `trace_id` filter (fan-out), no time floor (per-partition SST pruning is weak and grows as pagination walks back), `ORDER BY timestamp DESC, span_id DESC` where `span_id` isn't in the PK (per-partition re-sort), and wide rows including 5–430 KB JSON payload columns.

4. **Strategy B cursor pagination is still broken.** 38 seconds at median is 200× better than run4's 134 s but still 1,200× slower than A. Any workload touching Q-id disqualifies B.

5. **Memory pressure absolute levels need investigation.** M1/M2/M3 slowed 3–8× across the board for both strategies despite no apparent change to the test. The relative M1→M3 shape is preserved, so the cache-pressure conclusion still holds, but the wall-clock numbers want an explanation before they are compared with future runs. Compare scrape-a-m1-1tenant / scrape-b-m1-1tenant JSON outputs against run4 to confirm cache hit rates.

6. **S2 time-range errors persist but halved on A 1h.** Run4 A 1h had 51 errors; run5 has 29. B 1h went from 30 to 15. Error rate remains ~0.05%; still worth a bug-report pass once the mechanism is identified.

7. **Next step: the B S1 Q-id bottleneck is partition fan-out, not cursor semantics.** Cursor pagination on time-indexed data is fast in GreptimeDB when the query touches one partition — A demonstrates this at 32 ms p50 with no time floor, walking back through 18 months of history via only `timestamp < cursor_ts`. B's 38 s latency on the same query shape comes from every pagination request hitting all 16 partitions and merge-sorting upstream, with most partitions contributing rows the cursor then discards. The fix direction is therefore about partition column choice or query shape, not about forcing a synthetic time floor into client code. Options worth evaluating: (a) partition S1 B on `tenant_id` and accept the known write hot-spot risk (one tenant's writes concentrate on one partition); (b) partition on a column the query actually filters on; (c) keep B's S1 out of cursor-pagination use cases entirely and route those reads to a different access pattern. A one-off diagnostic run with `AND timestamp > cursor_ts - INTERVAL '1 day'` would quantify how much of the 38 s is fan-out coordination vs. per-partition scan work — useful for picking between those options, not as a production fix.
