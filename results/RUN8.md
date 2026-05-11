# Run8 Benchmark Analysis

**Date**: 2026-05-08
**Cluster**: 3 datanodes × (4 vCPU / 16 GiB) + 2 frontends, HAProxy LB (per [README.md](../README.md))
**Image**: `greptime/greptimedb:v1.0.0` (stable)
**Scale**: 100 tenants, 500k spans/tenant, 1M conversation items/tenant, 50k conversations/tenant
**Variant**: `ITEM_PK=true` with BLOOM retained (same as run7 on A); **Strategy B partition column changed from `trace_id` / `conversation_id` to `tenant_id`** on both shared tables (see [ddl.ts:90-120](../src/schema/ddl.ts#L90-L120), commit `ab5a309`).

Schema difference vs run7:
- A S1: `PRIMARY KEY (trace_id)` + BLOOM on `trace_id` (unchanged).
- A S2: `PRIMARY KEY (conversation_id)` + BLOOM on `conversation_id` (unchanged).
- B S1: `PRIMARY KEY (tenant_id, trace_id)` + BLOOM on `trace_id`; `PARTITION ON (tenant_id)` (was `PARTITION ON (trace_id)`).
- B S2: `PRIMARY KEY (tenant_id, conversation_id)` + BLOOM on `conversation_id`; `PARTITION ON (tenant_id)` (was `PARTITION ON (conversation_id)`).

Every query carries `WHERE tenant_id = ?`, so partitioning on `tenant_id` prunes the scan to a single partition instead of fanning out across all 16. Same tenant count, per-tenant volume, and seeding as run5–7. Single session, zero errors on writes and M1–M4. All workloads ran at 10 VU / 120 s unless otherwise stated.

---

## Summary

**Strategy B finally works for most workloads.** Partitioning on `tenant_id` eliminates the 16-way partition fan-out that made every B read collapse in runs 5–7 — B Q-id S1 went from 48 s → 110 ms p50 (~430× faster), mixed 10 VU from 1.2 → 93 QPS (77×), M1 1-tenant from 31 → 155 QPS (5×). The sole remaining B cliff is **Q-conv**, which is now *worse* than run7 (clustered 28 s → 36 s, scattered 23 s → 46 s). The run7 explain analysis called this: Q-conv's bottleneck is shared-region SST fan-in on the conversation_id equality path, not partition fan-out — concentrating a tenant's rows into one partition makes that region's SST pile larger, not smaller.

**Unexpected: Strategy A regressed on multiple workloads despite zero schema change vs run7.** A Q-conv clustered went 61 ms → 384 ms (6.3×), A Q-id S2 went 55 ms → 179 ms (3.3×), A M1 1-tenant went 74 ms → 333 ms (4.5×). Writes and Q-time on A actually improved slightly. Since no DDL changed for A, this is most likely SST layout / bloom population drift from re-seeding, or compaction state at scrape time — worth confirming with a rerun or EXPLAIN ANALYZE VERBOSE on the current dataset before treating it as a real regression.

**Recommendation:** `tenant_id` partitioning is a keeper for B — it takes B from "production-broken" to "production-viable on every workload except Q-conv". Next experiment should target B's Q-conv SST fan-in (smaller regions, more aggressive compaction, tenant-aware region policy). The A regressions should be isolated before drawing further conclusions on the A schema.

---

## Write Performance

### W2 — Span batch ingest (S1, 5 spans/batch)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | vs run7 | vs run5 |
|---|---|---|---|---|---|---|---|---|
| 1 | 8 ms | 16 ms | 118 | 7 ms | 14 ms | 130 | A −3 %, B +2 % | A −17 %, B −10 % |
| 10 | 10 ms | 66 ms | 869 | 10 ms | 43 ms | 930 | A **+11 %**, B **+25 %** | A −15 %, B −19 % |
| 50 | 31 ms | 87 ms | 1,476 | 32 ms | 88 ms | 1,442 | A +3 %, B +6 % | A −5 %, B −6 % |

Writes on A are moderately better than run7 at 10 VU (780 → 869 QPS), still short of run5's 1,029. B writes moved in the same direction. The `tenant_id` partitioning on B didn't regress ingest — rows still distribute evenly across the 16 hex-range partitions because UUID first-char is uniform.

### W1 — Conversation item insert (S2, sequential per conversation)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | vs run7 | vs run5 |
|---|---|---|---|---|---|---|---|---|
| 1 | 47 ms | 81 ms | 21 | 52 ms | 105 ms | 19 | A −3 %, B −4 % | A −14 %, B −21 % |
| 10 | 62 ms | 121 ms | 160 | 64 ms | 136 ms | 152 | A **+16 %**, B **+18 %** | A −11 %, B −12 % |
| 50 | 160 ms | 308 ms | 302 | 169 ms | 353 ms | 284 | A +7 %, B +7 % | A −1 %, B −4 % |

Same shape as W2 — both strategies ~15 % faster than run7 at 10 VU and close to run5 at 50 VU.

---

## Query Performance

### S1 — Spans

#### Time-range queries (Q-time, 10 VU)

| Window | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio | vs run7 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|
| 1 h | 46 ms | 163 ms | 192 | 92 ms | 255 ms | 108 | **1.8×** | A +28 %, **B +10×** | A +33 %, **B +12×** |
| 24 h | 46 ms | 164 ms | 192 | 93 ms | 253 ms | 107 | **1.8×** | A +31 %, **B +11×** | A +32 %, **B +12×** |
| 7 d | 49 ms | 164 ms | 184 | 121 ms | 444 ms | 69 | **2.7×** | A +26 %, **B +90×** | A +24 %, **B +61×** |

**B Q-time went from 10 QPS to 100+ QPS across all windows.** The 7d window — which was 12 s p50 in run7 — is now 121 ms, a ~100× improvement. This is the clearest expression of the `tenant_id` partitioning win: the whole query now hits one partition on one datanode instead of fanning out across 16. A also improved meaningfully vs run7 (150 → 192 QPS on 1h) and is now the best A Q-time result across any run.

#### Cursor pagination (Q-id, S1, 10 VU)

| | p50 | p99 | QPS | vs run7 | vs run5 |
|---|---|---|---|---|---|
| A | 36 ms | 110 ms | 235 | +2 % | −7 % |
| B | 110 ms | 478 ms | 71 | **p50: 48 s → 110 ms (436×)**, **QPS +474×** | **p50: 38 s → 110 ms (345×)**, **QPS +366×** |

A is essentially flat vs run7 and within noise of run5. **B S1 cursor pagination is finally usable** — 110 ms p50 / 71 QPS compared to 48 s / 0.15 QPS in run7. The tie-breaker sort that exploded across 16 partitions in prior runs now resolves inside a single partition.

### S2 — Conversation items

#### Time-range queries (Q-time, S2, 10 VU)

| Window | A p50 | A p99 | A QPS | A err | B p50 | B p99 | B QPS | B err | vs run7 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 h | 21 ms | 56 ms | 448 | 30 | 50 ms | 125 ms | 180 | 7 | A −4 %, B −31 % | A −18 %, B −58 % |
| 24 h | 21 ms | 58 ms | 436 | 13 | 50 ms | 123 ms | 180 | 10 | A −9 %, B −35 % | A −20 %, B −57 % |
| 7 d | 30 ms | 74 ms | 325 | 0 | 102 ms | 409 ms | 74 | 0 | A −10 %, B −39 % | A +11 %, B −67 % |

A is nearly tied with run7. **B regressed on S2 Q-time** — 259 → 180 QPS at 1h, 121 → 74 QPS at 7d. With partitioning on `tenant_id`, all 50k conversations for a tenant now land in one region, so the S2 scan pays a higher per-query planning cost against a bigger local SST set than when rows were scattered across 16 partitions. S2 Q-time is one of the few B workloads where the old partition layout helped.

#### Cursor pagination (Q-id, S2, 10 VU)

| | p50 | p99 | QPS | vs run7 | vs run5 |
|---|---|---|---|---|---|
| A | 179 ms | 812 ms | 46 | **p50: 55 → 179 ms (−71 % QPS)** | **p50: 45 → 179 ms (−75 % QPS)** |
| B | 17,724 ms | 67,487 ms | 0.49 | ≈ flat | −89 % QPS |

A **regressed sharply** (55 → 179 ms p50) despite unchanged schema — see the "A regression" note in the summary. B S2 Q-id is unchanged from run7 and still unusable. Same mechanism as B Q-conv: the scan is bound by local SST fan-in, not partition fan-out.

### Conversation history (Q-conv, S2, 10 VU)

| Workload | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio | vs run7 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|
| Clustered | 384 ms | 1,273 ms | 22 | 35,971 ms | 64,216 ms | 0.21 | **105×** | **A −84 % QPS**, B −28 % | A −56 % QPS, **B −92 %** |
| Scattered | 612 ms | 2,009 ms | 14 | 46,260 ms | 92,973 ms | 0.18 | **78×** | A −41 %, B −39 % | A −30 %, **B −91 %** |

**Both strategies regressed on Q-conv vs run7.** A clustered went 61 ms → 384 ms despite zero schema change — this is the headline unexplained result of run8. B actually got *worse* than run7 on Q-conv (clustered 28 s → 36 s, scattered 23 s → 46 s), which the run7 analysis predicted: concentrating a tenant's rows into one partition enlarges the shared-region SST pile that already dominated Q-conv's scan-planning cost. `tenant_id` partitioning helps every query that scales with partition count (Q-time, Q-id pagination) and hurts the one query that already scaled with region size (Q-conv).

**Action item:** re-run `EXPLAIN ANALYZE VERBOSE` on A Q-conv clustered in the current dataset to confirm whether the regression is SST-file-count drift, bloom population drift, or compaction state. Without that, we can't distinguish schema effect from environmental drift.

---

## Memory Pressure (M1–M3)

50 VUs, 5 minutes, S1 Q-time (24h window).

| Scenario | Tenants | A p50 | A QPS | B p50 | B QPS | vs run7 | vs run5 |
|---|---|---|---|---|---|---|---|
| M1 | 1 | 333 ms | 146 | 311 ms | 155 | **A −78 % QPS**, **B +5×** | A +65 %, **B +7×** |
| M2 | 5 % (5) | 68 ms | 452 | 207 ms | 231 | A −26 %, **B +7.3×** | A +20 %, **B +5.9×** |
| M3 | 50 % (50) | 39 ms | 803 | 31 ms | 444 | A +15 %, **B +13.6×** | A −9 %, **B +11×** |
| M4 (B only) | 50 % (50) | — | — | 30 ms | 443 | **B +13.8×** | **B +11×** |

**B's memory-pressure results are transformed.** M1 went from 31 QPS to 155 (5×); M3 from 33 to 444 (13.6×). For the first time B M1 actually edges out A M1 (155 vs 146). Partitioning on `tenant_id` is doing exactly what it was supposed to: every VU hits one partition, so concurrent queries against different tenants fan out across datanodes instead of competing for the same region.

**A M1 regressed 78 % vs run7** (74 → 333 ms p50). Same schema, same seed — likely noise or compaction state drift. A M3 improved modestly (699 → 803 QPS).

---

## Mixed Workload

70 % Q-time (1 h S1), 15 % Q-id (S1), 10 % W2, 5 % W1. 15-minute runs.

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | B err | vs run7 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 71 ms | 281 ms | 121 | 94 ms | 358 ms | 93 | 0 | A +3 %, **B +77×** | A −7 %, **B +67×** |
| 50 | 90 ms | 1,588 ms | 303 | 81 ms | 13,746 ms | 76 | 0 | A +16 %, **B +145×** | A −3 %, **B +114×** |
| 100 | 126 ms | 2,787 ms | 398 | 430 ms | 15,208 ms | 72 | 0 | A +28 %, **B +158×** | A +3 %, **B +100×** |

**Mixed workload is the biggest headline for B.** B went from 0.45 QPS / 1,083 s p99 in run7 to 72 QPS / 15 s p99 in run8 — still the weakest on the tail but finally in the same order of magnitude as A. A is also at its best mixed result across any run (398 QPS at 100 VU). The error-count collapse (B errors went from hundreds to zero) is a direct consequence of Q-id no longer stalling VU pools for minutes.

---

## Comparison with Run5, Run6, Run7

| Workload | Run5 | Run6 | Run7 | **Run8** | Δ run7 → run8 |
|---|---|---|---|---|---|
| **A Q-conv clustered** | 167 ms / 50 | 1,349 ms / 6 | **61 ms / 140** | 384 ms / 22 | **−84 % QPS** (unexplained) |
| A Q-conv scattered | 390 ms / 20 | 1,346 ms / 6 | 362 ms / 24 | 612 ms / 14 | −41 % QPS |
| A Q-id S1 | 32 ms / 252 | 39 ms / 195 | 36 ms / 231 | 36 ms / 235 | ≈ tied |
| A Q-id S2 | 45 ms / 186 | 126 ms / 60 | 55 ms / 156 | 179 ms / 46 | **−71 % QPS** (unexplained) |
| A Q-time S1 1h | 67 ms / 144 | 62 ms / 157 | 63 ms / 150 | 46 ms / 192 | **+28 %** |
| A Q-time S2 1h | 16 ms / 546 | 30 ms / 306 | 20 ms / 469 | 21 ms / 448 | ≈ tied |
| A M1 1-tenant | 441 ms / 89 | 359 ms / 136 | **74 ms / 655** | 333 ms / 146 | **−78 % QPS** (unexplained) |
| A M3 50% | 30 ms / 878 | 42 ms / 766 | 50 ms / 699 | 39 ms / 803 | +15 % |
| A W2 10 VU | 1,029 | 1,047 | 780 | 869 | +11 % |
| A mixed 100 VU | 384 | 357 | 310 | 398 | **+28 %** |
| **B Q-time S1 1h** | 9.1 / 1,058 ms | 9.6 / 980 ms | 10.3 / 931 ms | **108 / 92 ms** | **+10×** |
| **B Q-time S1 7d** | 1.1 / 8.3 s | 0.82 / 11.7 s | 0.76 / 12.2 s | **69 / 121 ms** | **+90×** |
| **B Q-id S1** | 0.19 / 38 s | 0.055 / 157 s | 0.15 / 48 s | **71 / 110 ms** | **+474×** |
| B Q-time S2 1h | 424 | 236 | 259 | 180 | −31 % |
| B Q-id S2 | 4.4 / 1.3 s | 0.49 / 19 s | 0.46 / 13 s | 0.49 / 18 s | ≈ flat |
| B Q-conv clustered | 2.9 s | 42 s | 28 s | **36 s** | **−28 % QPS (regressed)** |
| B Q-conv scattered | 4.7 s | 38 s | 23 s | **46 s** | **−39 % QPS (regressed)** |
| **B M1 1-tenant** | 22.6 | 29.0 | 30.9 | **155** | **+5×** |
| **B M3 50%** | 40 | 31 | 33 | **444** | **+13.6×** |
| **B mixed 10 VU** | 1.4 | 0.35 | 1.21 | **93** | **+77×** |
| **B mixed 100 VU** | 0.71 | 0.38 | 0.45 | **72** | **+158×** |

Run8 is the first run where Strategy B is production-viable on anything other than pure writes. The A/B ratio on Q-time S1 7d collapsed from 188× to 2.7×. But Q-conv is now the sole B-specific read cliff, and A picked up a cluster of unexplained regressions on the conversation_id equality path.

---

## Conclusions

1. **Partitioning on `tenant_id` is the right move for B** and should be the baseline going forward. Every workload that has `WHERE tenant_id = ?` as the dominant filter (all of them) benefits: Q-time S1 improved 10–90×, Q-id S1 improved 430×, memory-pressure tests improved 5–14×, mixed workloads improved 77–158×. Writes were unaffected because UUID first-char distributes uniformly across the 16 hex ranges.

2. **Q-conv is B's remaining problem, and partition alignment made it slightly worse.** The run7 explain analysis showed Q-conv's cost was dominated by shared-region SST fan-in (40k+ files), not partition fan-out. Consolidating a tenant's rows into a single partition increases local SST density, which is exactly the wrong direction for Q-conv. Next experiment should target region size / compaction policy, not partitioning — e.g. smaller regions, more aggressive compaction triggers, or tenant-scoped region splits.

3. **Strategy A's unexplained regressions need investigation before any schema conclusions.** A Q-conv clustered (61 → 384 ms), A Q-id S2 (55 → 179 ms), and A M1 (74 → 333 ms) all regressed sharply against a schema that didn't change between run7 and run8. Re-running A on the current cluster, or running `EXPLAIN ANALYZE VERBOSE` on the affected queries, should isolate whether this is SST layout drift, bloom population drift after reseeding, compaction state at scrape time, or a genuine environmental regression.

4. **A still wins on absolute Q-conv and Q-id S2 latency, by a smaller margin than before.** Q-conv clustered A/B ratio went from 467× (run7) to 105× (run8). A is still the only option if Q-conv latency is a product requirement. But if the A regression turns out to be real, the gap is narrower still.

5. **The product-schema decision now has a clear next step.** Run5 → run8 have converged on a shortlist: Strategy A with ITEM_PK+BLOOM (run7 schema) for Q-conv-dominated workloads, Strategy B with `tenant_id` partitioning (run8 schema) if Q-conv can be either tolerated or worked around. The remaining open question for B is whether region-level tuning can close the Q-conv gap without re-introducing the partition-fan-out tax that run8 just removed.

6. **Remaining open questions:**
   - Why did A regress on conversation_id-equality workloads with zero schema change? Re-run to confirm, then EXPLAIN ANALYZE VERBOSE to identify the scan cost delta.
   - Can B Q-conv be improved with smaller regions or more aggressive compaction, given that 40k+ SSTs per region dominated the run7 explain? Next B experiment should target this, not partitioning.
   - Does the B recovery hold under 500 tenants or 1M conversations/tenant, or does the per-region SST count scale linearly with partition count reduction?
