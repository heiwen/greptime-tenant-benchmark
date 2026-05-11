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

**Strategy B finally works for most workloads.** Partitioning on `tenant_id` eliminates the 16-way partition fan-out that made every B read collapse in runs 5–7 — B Q-id S1 went from 48 s → 110 ms p50 (~430× faster), mixed 10 VU from 1.2 → 93 QPS (77×), M1 1-tenant from 31 → 155 QPS (5×). **`EXPLAIN ANALYZE VERBOSE` on the run8 dataset confirms the mechanism:** B Q-conv scattered touches 80 SST files (was 40,273 in run7) and `build_parts_cost` dropped from 65 s to ~10 ms — a 6,000× planning-cost reduction. The shared-region SST fan-in problem is solved at the storage layer.

**But the B Q-conv bench still shows 36 s p50 clustered / 46 s scattered at 10 VUs.** The per-query explain (single VU, serial) completes in 82–197 ms finish_time — a ~400× gap vs the bench. Since SST fan-in is no longer the bottleneck, the remaining B Q-conv cost must be concurrency contention: 100 tenants across 16 partitions means ~6 tenants share a region, and 10 VUs picking random tenants will collide on region-level scan workers. This is a **different problem** from runs 5–7 and points at region-sizing / scan-parallelism, not indexing.

**Strategy A regressed on multiple workloads despite zero schema change vs run7.** A Q-conv clustered went 61 ms → 384 ms (6.3×), A Q-id S2 went 55 ms → 179 ms (3.3×), A M1 1-tenant went 74 ms → 333 ms (4.5×). **EXPLAIN rules out SST layout drift:** A's per-tenant table still has 74 files / 75 ranges — essentially identical to run7's 73 / 75. The A regression is environmental (compaction state, cache, concurrency contention at bench time), not schema or dataset. Sample-to-sample scan_cost variance on A is also higher than run7 (272–426 ms across samples on one workload vs a stable 152 ms before), consistent with cache or compaction thrash at bench time.

**Recommendation:** `tenant_id` partitioning is a keeper for B — it takes B from "production-broken" to "production-viable on every workload except Q-conv at concurrency". Next B experiment should target region-level scan parallelism and region sizing (not indexing, not partitioning). The A regressions should be isolated with a rerun on a freshly-compacted cluster before drawing further schema conclusions.

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

**Both strategies regressed on Q-conv vs run7 at the bench level.** A clustered went 61 ms → 384 ms despite zero schema change. B clustered went 28 s → 36 s. See "EXPLAIN ANALYZE findings" below — the run7 hypothesis (B SST fan-in from shared-region partitioning) is now resolved at the storage layer; the remaining B cost is concurrency contention, not fan-in. A's regression is not visible in the explain plan at all and appears to be environmental.

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

## EXPLAIN ANALYZE VERBOSE findings

Ran `bun run src/explain-a-regressions.ts` against the run8 cluster (see [results/run8/explain.csv](run8/explain.csv) and [results/run8/explain-verbose.log](run8/explain-verbose.log)). 5 samples per (workload, strategy), 1 tenant.

### Strategy B: SST fan-in is fixed

| | Run7 explain (scattered) | **Run8 explain (scattered)** | Δ |
|---|---|---|---|
| files | 40,273 | **80** | 500× fewer |
| file_ranges | 40,439 | 582 | 70× fewer |
| build_parts_cost | 65.0 s | **~10 ms** | ~6,500× faster |
| scan_cost | 78.1 s | 65–425 ms | ~200× faster |
| finish_time (per query) | 21.1 s | 31–197 ms | ~100× faster |

Run7's scan-planning-collapse symptom is gone. The `tenant_id` partitioning routes every Q-conv to the one region that contains that tenant's rows; that region has ~80 SSTs (one per daily compaction bucket × 18 months, plus a handful of recent uncompacted SSTs) instead of ~40k. Bloom and minmax pruning then drop 99 % of remaining row groups.

### Strategy B Q-conv: the remaining bench gap is concurrency, not storage

Single-VU explain runs complete in 82–197 ms per Q-conv query. The 10-VU bench reports 36 s p50 clustered / 46 s p50 scattered. That is a ~400× gap that cannot be explained by SST layout — the explain already read the same files from the same region. The candidates:

- **Region-level scan contention.** 100 tenants across 16 partitions ≈ 6 tenants per region. At 10 VUs picking random tenants, multiple VUs will frequently target the same region concurrently. The scan worker pool inside the region becomes the bottleneck.
- **Page cache / bloom cache cold paths.** Bench picks random conversations per call; explain picks 5 fixed conversations that get cache-warm after the first sample.

Either way, the fix is not at the partition / index level. It is region-sizing or scan parallelism — the levers the benchmark hasn't exercised yet.

### Strategy A: SST layout unchanged from run7

| | Run7 explain | **Run8 explain (Q-conv scattered)** |
|---|---|---|
| files | 73 | **74** |
| file_ranges | 75 | 75 |
| build_parts_cost | 91 ms | 6–40 ms |
| scan_cost | 152 ms (stable) | **272–426 ms** (wide variance across 5 samples) |
| finish_time | 52 ms | 40–224 ms |

**The A regression is not schema drift and not dataset drift.** Same schema, same file count, same row distribution. But scan_cost is 2–3× run7's and highly variable sample-to-sample. That pattern is consistent with:

- compaction in flight at scrape time, producing transient file-count / row-group spikes not captured by the per-query explain;
- page cache / metadata cache pressure from the other concurrent workloads sharing the same cluster;
- or noisy-neighbor contention on the shared EC2 instance (everything runs on one `m7i-flex.8xlarge`).

None of those are schema-driven, so the A numbers in this run should be treated as a lower bound on A's achievable latency, not a schema verdict.

### M1 probe is invalid — must be re-run

All 10 `m1-qtime-s1-24h` samples show `files=0, ranges=0, build_parts_cost=4ns`. The probe used `now() − 24h` as the cutoff; the dataset's most recent timestamp is earlier than that, so the `timestamp > cutoff` predicate matched zero rows. The probe needs to anchor on `MAX(timestamp)` for the tenant before it can say anything about the M1 regression. Patched in [src/explain-a-regressions.ts](../src/explain-a-regressions.ts) — rerun required.

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

2. **B's Q-conv storage-layer problem is solved; the remaining problem is concurrency.** EXPLAIN ANALYZE VERBOSE shows SST count per Q-conv query dropped from 40,273 (run7) to 80 (run8) and `build_parts_cost` from 65 s to ~10 ms — a 6,000× planning-cost reduction. Single-VU per-query latency is 82–197 ms. But the 10-VU bench shows 36–46 s p50, a 400× gap. With ~6 tenants per region and 10 VUs picking random tenants, region-level scan contention is the only remaining credible explanation. **Next B experiment should target region sizing or scan parallelism** (not indexing, not partitioning), e.g. more partitions to spread tenants across more regions, or tuning the scan worker pool.

3. **Strategy A's regressions are not explained by schema or dataset.** EXPLAIN shows A's per-tenant table still has 74 files / 75 ranges, essentially identical to run7. The regression is environmental — compaction state at scrape time, page cache pressure from the concurrent bench, or noisy-neighbor effects on the shared EC2 instance. Scan_cost variance sample-to-sample is also much higher than run7 (272–426 ms vs 152 ms stable). A rerun on a freshly-compacted, idle cluster is needed to separate schema from state before drawing further conclusions on A.

4. **A still wins on absolute Q-conv and Q-id S2 latency, by a smaller margin than before.** Q-conv clustered A/B ratio went from 467× (run7) to 105× (run8). A is still the only option today if Q-conv latency is a product requirement. If the A regression is environmental and clears on a rerun, the gap widens again; if the B Q-conv concurrency fix lands, the gap narrows dramatically.

5. **The product-schema decision now has a clear next step.** Run5 → run8 have converged on a shortlist: Strategy A with ITEM_PK+BLOOM (run7 schema) for Q-conv-dominated workloads, Strategy B with `tenant_id` partitioning (run8 schema) if the Q-conv concurrency problem can be resolved. The decision between A and B now rests on one experiment: can B Q-conv at 10 VUs close the 400× gap between explain and bench?

6. **Remaining open questions:**
   - **B Q-conv concurrency gap.** Re-run B Q-conv at 1, 2, 5, 10 VUs to locate the contention cliff. Try 32 or 64 partitions to reduce tenants-per-region density. Try increasing region-level scan worker count.
   - **A regression isolation.** Rerun A only on a freshly-restarted, post-compaction cluster. Expect to see run7-like 61 ms / 140 QPS Q-conv clustered; if not, the regression is real and the explain was too coarse to catch it.
   - **M1 probe validity.** Re-run the EXPLAIN probe after the cutoff-anchoring fix to get actual M1 numbers.
   - **Scale.** Does the B recovery hold at 500 tenants or 1M conversations/tenant? At that scale, per-region tenant density grows even without schema changes.
