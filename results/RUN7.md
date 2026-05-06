# Run7 Benchmark Analysis

**Date**: 2026-05-04
**Cluster**: 3 datanodes × (4 vCPU / 16 GiB) + 2 frontends, HAProxy LB (per [README.md](../README.md))
**Image**: `greptime/greptimedb:v1.0.0` (stable)
**Scale**: 100 tenants, 500k spans/tenant, 1M conversation items/tenant, 50k conversations/tenant
**Variant**: `ITEM_PK=true` **with BLOOM retained** — same PK expansion as run6 (trace_id / conversation_id appended to the PK), but the `SKIPPING INDEX WITH(type='BLOOM', granularity=10240)` on the cluster column is now kept instead of dropped (see [ddl.ts:17-23](../src/schema/ddl.ts#L17-L23), commit `dc777c2`).

Schema difference vs run6:
- A S1: `PRIMARY KEY (trace_id)` + BLOOM on `trace_id` (was: PK only, no BLOOM).
- A S2: `PRIMARY KEY (conversation_id)` + BLOOM on `conversation_id` (was: PK only).
- B S1: `PRIMARY KEY (tenant_id, trace_id)` + BLOOM on `trace_id`.
- B S2: `PRIMARY KEY (tenant_id, conversation_id)` + BLOOM on `conversation_id`.

The BLOOM is now redundant with PK-tag indexing, but run6 showed that flat-SST equality pruning on non-leading PK columns didn't actually work well for Q-conv / Q-id — this run tests whether retaining the BLOOM recovers that performance. Same tenant count, per-tenant volume, and seeding as run5/run6. Single session, zero errors on writes and M1–M4. All workloads ran at 10 VU / 120 s unless otherwise stated.

---

## Summary

**Retaining the BLOOM index recovers almost all of run6's regressions and — for the first time — delivers on the ITEM_PK hypothesis: Strategy A's Q-conv clustered query is now 2.7× faster than run5** (167 ms → 61 ms p50, 50 → 140 QPS). Q-conv scattered, Q-id, and most Q-time workloads are back within a few percent of run5 on A. Strategy B partially recovered from the run6 collapse — Q-id went 157 s → 48 s (vs run5's 38 s), Q-conv clustered went 42 s → 28 s (vs run5's 2.9 s) — but it is still meaningfully worse than run5 and remains production-broken. Writes took a consistent 10–35 % hit across both strategies due to maintaining the BLOOM index on a high-cardinality PK column. **Recommendation: `ITEM_PK=true` with BLOOM retained is now a credible option for A if Q-conv latency matters; Strategy B should stay on the run5 schema.**

---

## Write Performance

### W2 — Span batch ingest (S1, 5 spans/batch)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | vs run6 | vs run5 |
|---|---|---|---|---|---|---|---|---|
| 1 | 7 ms | 19 ms | 121 | 7 ms | 22 ms | 127 | A −7 %, B −4 % | A −14 %, B −12 % |
| 10 | 11 ms | 64 ms | 780 | 12 ms | 43 ms | 746 | **A −25 %, B −34 %** | **A −24 %, B −35 %** |
| 50 | 31 ms | 95 ms | 1,434 | 33 ms | 99 ms | 1,358 | A −8 %, B −10 % | A −8 %, B −11 % |

The 10-VU middle band shows the clearest regression: A 1,047 → 780 QPS, B 1,139 → 746 QPS. Keeping the BLOOM on a per-row-unique id column means every inserted row mutates the bloom filter for its block; the write path now pays both the PK-sort cost (widened to include `trace_id`) *and* bloom maintenance on the same high-cardinality column. At 1 VU there isn't enough write pressure for it to matter; at 50 VU the system is already saturating compaction so the marginal cost per row is smaller.

### W1 — Conversation item insert (S2, sequential per conversation)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | vs run6 | vs run5 |
|---|---|---|---|---|---|---|---|---|
| 1 | 46 ms | 83 ms | 21 | 50 ms | 96 ms | 20 | A −4 %, B −15 % | A −14 %, B −18 % |
| 10 | 72 ms | 131 ms | 138 | 77 ms | 143 ms | 129 | A −19 %, B −19 % | A −23 %, B −25 % |
| 50 | 144 ms | 408 ms | 282 | 154 ms | 431 ms | 265 | A −7 %, B −8 % | A −8 %, B −10 % |

Same shape as W2 — a ~20 % hit at 10 VU, smaller at both ends. The `conversation_id` BLOOM is maintained on every insert even though `conversation_id` is now in the PK.

---

## Query Performance

### S1 — Spans

#### Time-range queries (Q-time, 10 VU)

| Window | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio | vs run6 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|
| 1 h | 63 ms | 190 ms | 150 | 931 ms | 1,727 ms | 10.3 | **15×** | A −4 %, B +8 % QPS | A +4 %, B +14 % |
| 24 h | 64 ms | 188 ms | 146 | 975 ms | 1,774 ms | 9.9 | **15×** | A −5 %, B +2 % | A ≈, B +11 % |
| 7 d | 65 ms | 194 ms | 146 | 12,229 ms | 19,584 ms | 0.76 | **188×** | A +2 %, B −7 % | A −2 %, **B −31 %** |

A is flat vs run5. B recovered from the run6 1 h / 24 h regression and is now slightly better than run5 on those windows (partition-PK alignment helps). **B 7 d is still 31 % slower than run5** and actually degraded slightly vs run6 — the higher series cardinality on wide scans is a cost that BLOOM retention cannot offset because the 7 d predicate has no equality filter for the BLOOM to prune.

#### Cursor pagination (Q-id, S1, 10 VU)

| | p50 | p99 | QPS | vs run6 | vs run5 |
|---|---|---|---|---|---|
| A | 36 ms | 122 ms | 231 | +18 % QPS | −8 % QPS |
| B | 47,927 ms | 159,404 ms | 0.15 | +176 % QPS | −22 % QPS |

Strategy A mostly recovered — 39 → 36 ms p50, 195 → 231 QPS, still 8 % short of run5's 252 QPS. Strategy B went from run6's 157 s back to 48 s, within 25 % of run5's 38 s; same partition-fan-out ceiling as always. The BLOOM on `trace_id` is doing real pruning work on the cursor's trace lookups that run6 was missing.

### S2 — Conversation items

#### Time-range queries (Q-time, S2, 10 VU)

| Window | A p50 | A p99 | A QPS | A err | B p50 | B p99 | B QPS | B err | vs run6 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 h | 20 ms | 48 ms | 469 | 53 | 37 ms | 80 ms | 259 | 27 | A +53 %, B +10 % | A −14 %, B −39 % |
| 24 h | 20 ms | 46 ms | 480 | 29 | 35 ms | 75 ms | 276 | 18 | A +79 %, B +16 % | A −12 %, B −35 % |
| 7 d | 25 ms | 66 ms | 363 | 22 | 71 ms | 222 ms | 121 | 9 | A +89 %, B +10 % | A +23 %, B −45 % |

A recovered strongly and is now 12–14 % below run5 on 1 h / 24 h but 23 % *better* than run5 on 7 d. B recovered partially from run6 but remains 35–45 % slower than run5 — the extra series cardinality from 50k conversation_ids per tenant still drives more merge work than run5's flat `(tenant_id)` PK. Error counts are at the usual 0.04–0.09 % rate on 1 h / 24 h, same as run5/run6.

#### Cursor pagination (Q-id, S2, 10 VU)

| | p50 | p99 | QPS | vs run6 | vs run5 |
|---|---|---|---|---|---|
| A | 55 ms | 214 ms | 156 | +159 % QPS | −16 % QPS |
| B | 12,685 ms | 83,310 ms | 0.46 | −6 % QPS | −90 % QPS |

A almost recovered: 126 → 55 ms p50, 60 → 156 QPS, now 16 % short of run5's 186 QPS. **B barely moved vs run6** and remains 10× worse than run5's 1.35 s p50 — the 16-way partition fan-out and tie-breaker sort problem is not something the BLOOM can fix on a cursor pagination pattern whose predicate is `(created_at, id) < ?` with no equality filter on `conversation_id`.

### Conversation history (Q-conv, S2, 10 VU)

| Workload | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio | vs run6 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|
| Clustered | 61 ms | 193 ms | 140 | 28,465 ms | 55,816 ms | 0.29 | **467×** | A +2,159 %, B +42 % | **A +180 %, B −89 %** |
| Scattered | 362 ms | 1,138 ms | 24 | 23,252 ms | 83,881 ms | 0.29 | **64×** | A +291 %, B +31 % | **A +18 %, B −86 %** |

**This is the headline result of the run, and the first time ITEM_PK has produced a real win on the query it was designed for.** Strategy A Q-conv clustered went from run6's 1,349 ms to 61 ms — a 22× speedup vs run6 and 2.7× faster than run5 (167 ms). A Q-conv scattered landed at 362 ms, effectively tied with run5's 390 ms after being 3.5× slower in run6.

The mechanism confirms run6's hypothesis: the BLOOM skipping index at 10k-row granularity was the primary pruning mechanism for equality lookup on the cluster column in flat SSTs. With both the BLOOM *and* the PK extension present, the scanner now combines two pruning paths — PK-range pruning gives a coarse filter and the BLOOM eliminates SST blocks that don't contain the target conversation_id — and the clustered case beats run5's BLOOM-only result handily.

Strategy B Q-conv recovered only partially: 42 s → 28 s clustered, 38 s → 23 s scattered. Still 8–14× worse than run5 because every query fans out to 16 partitions and the merge cost per-query has grown with series cardinality, regardless of per-partition pruning. **B should stay on the run5 schema; the BLOOM retention does not save it.**

---

## Memory Pressure (M1–M3)

50 VUs, 5 minutes, S1 Q-time (24h window).

| Scenario | Tenants | A p50 | A QPS | B p50 | B QPS | vs run6 | vs run5 |
|---|---|---|---|---|---|---|---|
| M1 | 1 | 74 ms | 655 | 1,559 ms | 30.9 | **A +381 %**, B +6 % | **A +638 % QPS**, B +37 % |
| M2 | 5 % (5) | 42 ms | 609 | 1,521 ms | 31.6 | A +128 %, B +1 % | A +62 %, B −19 % |
| M3 | 50 % (50) | 50 ms | 699 | 1,482 ms | 32.6 | A −9 %, B +5 % | A −20 %, B −19 % |
| M4 (B only) | 50 % (50) | — | — | 1,508 ms | 32.1 | B +2 % | B −20 % |

**M1 on Strategy A is the second-largest win in the run** — single-tenant repeated query went from run5's 441 ms / 89 QPS to 74 ms / 655 QPS (7.4× more throughput). This is the ideal scenario for BLOOM + PK combined: one tenant, one query shape, cache-friendly working set, and the BLOOM prunes everything the query doesn't need. M2/M3 are mixed; M3 A regressed 20 % vs run5 because broader tenant diversity hurts cache and amplifies the per-tenant series-merge cost that still exists in flat SSTs. B remains at its run6-era baseline: 20 % worse than run5 on M2/M3/M4.

---

## Mixed Workload

70 % Q-time (1 h S1), 15 % Q-id (S1), 10 % W2, 5 % W1. 15-minute runs.

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | B err | vs run6 | vs run5 |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 74 ms | 285 ms | 117 | 104 ms | 128,434 ms | 1.21 | 23 | A +2 %, **B +242 %** | A −10 %, B −12 % |
| 50 | 91 ms | 1,745 ms | 262 | 453 ms | 909,513 ms | 0.52 | 0 | A −11 %, B +64 % | A −16 %, B −22 % |
| 100 | 157 ms | 3,353 ms | 310 | 4,707 ms | 1,083,021 ms | 0.45 | 0 | A −13 %, B +19 % | A −19 %, B −36 % |

Strategy A degraded 10–19 % vs run5 across concurrency levels — consistent with the W2/W1 write cost and the small Q-id regression, diluted across the 70 % Q-time portion that didn't change. Strategy B mixed throughput actually recovered meaningfully vs run6 (357 → 1,210 mQPS at 10 VU), though p99 latencies are still in the 10-minute range because Q-id's multi-minute tail stalls VU pools. B mixed is not usable in any configuration tested.

---

## Comparison with Run5 and Run6

| Workload | Run5 | Run6 | Run7 | Direction vs run5 |
|---|---|---|---|---|
| **A Q-conv clustered** | 167 ms / 50 QPS | 1,349 ms / 6.2 QPS | **61 ms / 140 QPS** | **2.7× faster** |
| A Q-conv scattered | 390 ms / 20 QPS | 1,346 ms / 6.1 QPS | 362 ms / 24 QPS | ≈ tied |
| A Q-id S1 | 32 ms / 252 QPS | 39 ms / 195 QPS | 36 ms / 231 QPS | −8 % QPS |
| A Q-id S2 | 45 ms / 186 QPS | 126 ms / 60 QPS | 55 ms / 156 QPS | −16 % QPS |
| A Q-time S1 1h | 67 ms / 144 QPS | 62 ms / 157 QPS | 63 ms / 150 QPS | +4 % QPS |
| A Q-time S2 1h | 16 ms / 546 QPS | 30 ms / 306 QPS | 20 ms / 469 QPS | −14 % QPS |
| **A M1 1-tenant** | 441 ms / 89 QPS | 359 ms / 136 QPS | **74 ms / 655 QPS** | **7.4× QPS** |
| A W2 10 VU | 1,029 QPS | 1,047 QPS | 780 QPS | −24 % |
| A W1 10 VU | 179 QPS | 170 QPS | 138 QPS | −23 % |
| A mixed 50 VU | 312 QPS | 296 QPS | 262 QPS | −16 % |
| B Q-conv clustered | 2,916 ms | 41,971 ms | 28,465 ms | −89 % QPS |
| B Q-id S1 | 37,955 ms | 156,549 ms | 47,927 ms | −22 % QPS |
| B Q-time S1 7d | 8,321 ms | 11,739 ms | 12,229 ms | −31 % QPS |

Run7 essentially trades ~10–25 % write throughput for large per-item read wins on Strategy A. For Strategy B, the trade is worse on every axis except Q-conv where it partially recovered but remains unusable in absolute terms.

---

## Conclusions

1. **`ITEM_PK=true` with BLOOM retained is the first configuration where the hypothesis held.** Q-conv clustered, the target workload, is 2.7× faster on A than run5's BLOOM-only baseline. Q-conv scattered is tied. M1 single-tenant is 7.4× higher throughput. The run6 experiment (PK without BLOOM) proved the BLOOM was load-bearing; run7 proves PK *plus* BLOOM is additive on A's cluster-column equality path.

2. **Strategy A's run7 schema is now the recommended choice if Q-conv latency is a product requirement.** If it isn't, run5's schema is cheaper on writes (−20 % cost avoided) and close enough on reads. The decision is workload-driven: per-conversation lookup throughput vs ingest headroom.

3. **Strategy B should remain on the run5 schema.** B's Q-time 7 d regressed further, Q-id is still 10× worse than run5 in absolute terms, and mixed workloads are still in the multi-minute tail. The 16-way partition fan-out problem is the dominant cost for B and no amount of per-partition index tuning can close it. If B is pursued further, partition strategy (fewer partitions, different partition key) is the lever, not index layout.

4. **Write cost is real but bounded.** Maintaining the BLOOM on a high-cardinality PK column costs ~20 % of write throughput at the 10-VU middle band and ~8–10 % at saturation. This should be factored into capacity sizing if the schema is adopted.

5. **The A/B ratio widened again because A improved while B mostly didn't.** Q-conv clustered is now 467× in A's favour (run5: 17×, run6: 31×). The practical implication is unchanged: A is the only viable strategy at this tenant count.

6. **Remaining open questions**:
   - Is the ~20 % W2/W1 regression driven entirely by the BLOOM, by the PK widening, or both? A run with just BLOOM-but-no-PK-extension would isolate this (essentially run5 with BLOOM granularity tuned).
   - Does the Q-conv A win hold under higher conversation cardinality (e.g. 500k conv/tenant)? This run's 50k conversations leaves the per-tenant bloom filters comfortably small.
   - Can Strategy B's partition count be reduced from 16 to 4 while keeping write parallelism acceptable? The fan-out cost has dominated every B result since run3.
