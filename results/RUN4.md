# Run4 Benchmark Analysis

**Date**: 2026-04-15  
**Cluster**: 3 datanodes × (2 vCPU / 8 GiB) + 2 frontends, HAProxy LB  
**Image**: `greptime/greptimedb:v1.0.0` (stable)  
**Scale**: 100 tenants, 500k spans/tenant, 1M conversation items/tenant, 50k conversations/tenant

Single session, zero errors on all write and memory-pressure scenarios. Small error counts on S2 time-range reads (noted per-section). All workloads ran at 10 VUs / 120 s unless otherwise stated.

---

## Summary

**Strategy A (per-tenant tables) wins decisively across every workload.** Compared to run2, the performance gap has widened dramatically. Strategy B is non-functional under the mixed workload due to a catastrophic cursor-pagination regression. Two new conversation-history workloads added in this run invert the run3 finding: at 100 tenants, A is 24–142× faster than B. The cache-pressure hypothesis is now closed — Prometheus scraping was fixed this run and both strategies maintain >99.7% block cache hit rates under 50-tenant concurrent reads.

---

## Write Performance

### W2 — Span batch ingest (S1, 5 spans/batch)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 1 | 7 ms | 15 ms | 134 | 6 ms | 15 ms | 142 |
| 10 | 10 ms | 68 ms | 856 | 10 ms | 68 ms | 831 |
| 50 | 30 ms | 94 ms | 1,517 | 30 ms | 176 ms | 1,424 |

Write throughput is nearly tied at 1–10 VU. At 50 VU, Strategy A holds a ~6% throughput advantage and a much lower p99 (94 ms vs 176 ms). Strategy B's p99 variance at high concurrency was also visible in run2; the difference is consistent.

### W1 — Conversation item insert (S2, sequential per conversation)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 1 | 40 ms | 66 ms | 25 | 44 ms | 71 ms | 22 |
| 10 | 60 ms | 112 ms | 162 | 63 ms | 119 ms | 154 |
| 50 | 160 ms | 296 ms | 305 | 167 ms | 311 ms | 293 |

Strategy A is consistently 5–10% faster. QPS plateaus from 10→50 VU for both strategies as expected (sequential-per-conversation semantics limit effective concurrency).

---

## Query Performance

### S1 — Spans

#### Time-range queries (Q-time, 10 VU)

| Window | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio |
|---|---|---|---|---|---|---|---|
| 1 h | 54 ms | 143 ms | 178 | 150 ms | 511 ms | 54 | **3.3×** |
| 24 h | 55 ms | 150 ms | 174 | 156 ms | 542 ms | 53 | **3.3×** |
| 7 d | 56 ms | 152 ms | 175 | 514 ms | 2,403 ms | 14 | **12.9×** |

The gap has grown substantially since run2 (where 1h/24h were 1.6× and 7d was 2.5×). Strategy B degrades sharply at the 7d window: median latency is 9× higher than A, and throughput collapses to 14 QPS. A's throughput is essentially flat across all three windows, suggesting the tenant-local SST scans are entirely in cache.

#### Cursor pagination (Q-id, S1, 10 VU)

| A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio |
|---|---|---|---|---|---|---|---|
| 583 ms | 5,626 ms | 7.6 | 134,103 ms | 154,881 ms | 0.08 | **95× (QPS)** |

Strategy B is effectively non-functional for cursor pagination on S1. Only 13 queries completed in the 155-second window (versus 926 for A). Every B query took >2 minutes at median. This is a severe regression from run2, where B completed Q-id at 332 ms p50 / 30 QPS. The root cause is not yet identified but likely relates to the shared-table sort order over `(tenant_id, timestamp, span_id)` requiring a full-partition merge-sort under concurrent load at this data volume.

### S2 — Conversation items

#### Time-range queries (Q-time, S2, 10 VU)

| Window | A p50 | A p99 | A QPS | A errors | B p50 | B p99 | B QPS | B errors |
|---|---|---|---|---|---|---|---|---|
| 1 h | 19 ms | 45 ms | 518 | 51 | 42 ms | 108 ms | 212 | 30 |
| 24 h | 24 ms | 57 ms | 413 | 27 | 65 ms | 168 ms | 142 | 9 |
| 7 d | 25 ms | 61 ms | 393 | 19 | 145 ms | 470 ms | 59 | 0 |

Strategy A leads by 2.4× (1h) to 6.6× (7d). Both strategies show a small number of errors on 1h and 24h windows; error rates are low (~0.1% for A, ~0.1% for B) and do not materially affect throughput figures. The error pattern warrants investigation but did not recur on write workloads.

#### Cursor pagination (Q-id, S2, 10 VU)

| A p50 | A p99 | A QPS | A errors | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 42 ms | 165 ms | 205 | 8 | 2,650 ms | 12,991 ms | 2.3 |

Strategy A is 89× faster by QPS. Unlike the S1 catastrophe, B does complete queries here (284 in 125s), but at p50=2.65s and p99=13s versus A's 42ms p50. The same shared-table sort order explains the overhead.

### Conversation history (Q-conv, S2, 10 VU)

New workloads in this run. Both query all items for a randomly selected conversation:
- **Clustered**: items seeded within ±48 h of a single anchor (single-session)
- **Scattered**: items spread randomly across 18 months (long-running conversation)

| Workload | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio |
|---|---|---|---|---|---|---|---|
| Clustered | 57 ms | 193 ms | 149 | 8,861 ms | 19,423 ms | 1.05 | **142×** |
| Scattered | 314 ms | 1,217 ms | 26 | 9,189 ms | 20,975 ms | 1.06 | **24×** |

**This is the starkest inversion in the benchmark series.** Run3 (10 tenants) showed B was 3× faster than A on clustered conversations. Run4 (100 tenants) shows A is 142× faster. Strategy B's conversation history query requires scanning all rows for a `tenant_id` across up to 16 partitions. At 100 tenants × 1M items/tenant, this scan volume causes the 8–9 second medians. Strategy A scans only the single per-tenant table, finding the conversation's rows efficiently.

The scattered workload (cross-time range) is slower for both strategies but the ratio narrows to 24× because A also has to scan more SST files for widely-distributed timestamps.

---

## Memory Pressure (M1–M3)

50 VUs, 5 minutes, pure S1 time-range reads. Tenant diversity varies to test cache behaviour.

| Scenario | Tenants | A p50 | A QPS | A cache hit% | B p50 | B QPS | B cache hit% |
|---|---|---|---|---|---|---|---|
| M1 | 1 | 68 ms | 713 | 99.79% | 435 ms | 108 | 99.78% |
| M2 | 5% (5) | 38 ms | 803 | 99.94% | 288 ms | 131 | 99.80% |
| M3 | 50% (50) | 26 ms | 1,057 | 99.94% | 170 ms | 148 | 99.83% |
| M4 (B only) | 50% (50) | — | — | — | 165 ms | 150 | 99.92% |

**The cache-pressure hypothesis is definitively closed.** Both strategies maintain >99.7% block cache hit rates across all tenant diversity levels, including 50 concurrent readers each hitting a different tenant. The block cache (8 GiB per datanode) holds the active working set for 100 tenants at this data volume without thrashing.

The M1→M3 improvement pattern seen in run2 repeats: increasing diversity improves throughput for both strategies by spreading WAL/memtable contention across more series. Strategy A leads by 5–7× at every diversity level in this run, consistent with the widened S1 time-range gap seen in the direct query scenarios.

M4 (Strategy B, 50 tenants, control) confirms M3's result is reproducible.

---

## Mixed Workload

70% Q-time (1h S1), 15% Q-id (S1), 10% W2, 5% W1. Uniform tenant selection. 15-minute runs.

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS |
|---|---|---|---|---|---|---|
| 10 | 47 ms | 3,589 ms | 45 | 30 ms | 231,280 ms | 0.33 |
| 50 | 39 ms | 25,459 ms | 45 | 51 ms | 640,910 ms | 0.76 |
| 100 | 883 ms | 29,512 ms | 31 | 6,205 ms | 1,047,637 ms | 0.53 |

**Strategy B is non-functional under mixed load.** The 15% Q-id fraction drives this: since B's S1 cursor pagination takes 134 seconds at median, VUs assigned to that workload block for minutes. At 10 VU, the expected Q-id contribution alone limits throughput to ~0.075 QPS (10 VUs × 0.15 fraction / 134s per request). The observed 0.33 QPS reflects the remaining request types occasionally completing between stalled Q-id VUs.

Strategy A degrades gracefully: 45 QPS at 10–50 VU with a p99 spike at 50 VU driven by occasional large-span ingest batches in the write fraction. Throughput drops at 100 VU as query and write contention saturate the cluster.

---

## Comparison with Previous Runs

| Workload | Run2 A/B | Run4 A/B | Direction |
|---|---|---|---|
| S1 Q-time 1h | 1.6× | 3.3× | A advantage widened |
| S1 Q-time 7d | 2.5× | 12.9× | A advantage widened dramatically |
| S1 Q-id | 1.9× | 95× | B regressed severely |
| S2 Q-time 1h | 1.3× | 2.4× | A advantage widened |
| Mixed 10 VU | 1.3× | 136× | B regressed severely |
| Q-conv clustered | (run3) B 3× faster | A 142× faster | **Full inversion** |

The version change (rc.2-nightly → v1.0.0 stable) may account for some delta, but the magnitude of the Q-id and Q-conv regressions for B suggests a structural issue with the shared-table approach at this tenant × data-volume combination, not just a version regression.

---

## Conclusions

1. **Use Strategy A.** It is faster by a large margin on every query type: 3–13× on time-range, 95× on S1 pagination, 142× on clustered conversation history. The per-tenant table overhead has not manifested as a bottleneck at 100 tenants.

2. **Strategy B cursor pagination is broken at this scale.** S1 Q-id at 134 seconds median is not a production-viable latency. Any mixed workload that includes pagination is effectively unusable with B. Investigation needed before B can be recommended at 100 tenants.

3. **The run3 B advantage on conversation history does not scale.** Strategy B was 3× faster than A at 10 tenants. At 100 tenants it is 142× slower. The crossover appears to occur somewhere between 10 and 100 tenants. The mechanism is the shared-table scan volume: 100M rows must be filtered per query vs. 1M for A.

4. **Cache pressure is not the bottleneck for Strategy A.** Both strategies hold >99.7% cache hit rates under 50-tenant concurrent reads. Strategy A's higher throughput in memory pressure tests is a query execution efficiency advantage, not a cache advantage.

5. **S2 time-range errors warrant investigation.** Strategy A sees ~51 errors out of 62K requests on the 1h S2 window. Error rate is low (~0.1%) but non-zero and absent in run2. Could be an Arrow Flight connection pool issue under the higher S2 QPS (518 QPS vs run2's 143 QPS).

6. **Next step: identify the B pagination regression.** Before any further scale testing, reproduce the Q-id B regression in isolation and file a bug or identify the schema/query change responsible. Run2's B Q-id was 332 ms p50; run4's is 134,000 ms p50 — a 400× regression that cannot be explained by data volume alone.
