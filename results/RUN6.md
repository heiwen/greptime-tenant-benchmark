# Run6 Benchmark Analysis

**Date**: 2026-04-26
**Cluster**: 3 datanodes × (4 vCPU / 16 GiB) + 2 frontends, HAProxy LB (per [README.md](../README.md))
**Image**: `greptime/greptimedb:v1.0.0` (stable)
**Scale**: 100 tenants, 500k spans/tenant, 1M conversation items/tenant, 50k conversations/tenant
**Variant**: `ITEM_PK=true` — per-item cluster column is appended to each table's PRIMARY KEY (`trace_id` for spans, `conversation_id` for conversation_items), and its `SKIPPING INDEX WITH(type='BLOOM')` is removed (see [ddl.ts:10-26](../src/schema/ddl.ts#L10-L26)).

Schema difference vs run5:
- Strategy A S1: `PRIMARY KEY (trace_id)`; was no PK.
- Strategy A S2: `PRIMARY KEY (conversation_id)`; was no PK.
- Strategy B S1: `PRIMARY KEY (tenant_id, trace_id)`; was `PRIMARY KEY (tenant_id)`. PK now aligned with partition column.
- Strategy B S2: `PRIMARY KEY (tenant_id, conversation_id)`; was `PRIMARY KEY (tenant_id)`. PK now aligned with partition column.
- BLOOM skipping index on `trace_id` / `conversation_id` is gone on every table (redundant once the column is in the PK).

Same tenant count, same per-tenant volume, same seed distribution (stratified timestamps with sorted clustered-conversation batches) as run5. Single session, zero errors on write and memory-pressure scenarios; small error counts on S2 time-range reads are unchanged in character from run5. All workloads ran at 10 VU / 120 s unless otherwise stated.

---

## Summary

**ITEM_PK=true regressed read performance across nearly every scenario, including the two workloads it was explicitly supposed to help.** The hypothesis was that co-locating rows for one trace/conversation in the PK would speed per-item fetches (Q-conv, Q-id) at the cost of higher series cardinality on time-range scans. In practice Q-conv and Q-id *both* got dramatically slower for both strategies — clustered Q-conv A went 167 ms → 1,349 ms p50 (8×), S2 Q-id A went 45 ms → 126 ms (2.8×), S1 Q-id A went 32 ms → 39 ms with QPS collapsing from 252 to 195, S1 Q-id B went 38 s → 157 s p50 (4× regression from an already-broken state). Writes took a small 1–10 % hit. **Recommendation: do not enable `ITEM_PK` on either strategy.** Run5's schema (tenant_id-only PK on B, no PK on A, BLOOM on the cluster column) is the current best configuration.

---

## Write Performance

### W2 — Span batch ingest (S1, 5 spans/batch)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | vs run5 |
|---|---|---|---|---|---|---|---|
| 1 | 7 ms | 18 ms | 130 | 6 ms | 17 ms | 132 | A −8 %, B −8 % QPS |
| 10 | 7 ms | 62 ms | 1,047 | 8 ms | 41 ms | 1,139 | ≈ tied with run5 |
| 50 | 30 ms | 83 ms | 1,556 | 31 ms | 90 ms | 1,504 | A ≈, B −2 % |

Span ingest is essentially unchanged. The ITEM_PK column adds 32 bytes of tag to every row and one more PK comparison during memtable sort, but that cost is invisible at this batch size. Adding `trace_id` to B's PK aligns it with the partition column — the per-tenant partition fan-out pattern is unchanged because each batch of 5 spans already shares one `trace_id` and therefore lands in a single partition (as noted in [RUN5.md](RUN5.md#w2--span-batch-ingest-s1-5-spansbatch)).

### W1 — Conversation item insert (S2, sequential per conversation)

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | vs run5 |
|---|---|---|---|---|---|---|---|
| 1 | 44 ms | 92 ms | 22 | 42 ms | 82 ms | 24 | A −10 %, B ≈ |
| 10 | 58 ms | 116 ms | 170 | 61 ms | 143 ms | 159 | A −5 %, B −7 % |
| 50 | 163 ms | 293 ms | 302 | 170 ms | 318 ms | 289 | A ≈, B −2 % |

Minor 5–7 % regression at 10 VU, everywhere else effectively tied. Same explanation: small PK width increase, nothing expensive.

---

## Query Performance

### S1 — Spans

#### Time-range queries (Q-time, 10 VU)

| Window | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio | vs run5 |
|---|---|---|---|---|---|---|---|---|
| 1 h | 62 ms | 182 ms | 157 | 980 ms | 2,015 ms | 9.6 | **16×** | A +9 % QPS, B +6 % QPS |
| 24 h | 63 ms | 189 ms | 153 | 988 ms | 1,942 ms | 9.7 | **16×** | A +5 %, B +9 % |
| 7 d | 61 ms | 204 ms | 143 | 11,739 ms | 17,730 ms | 0.82 | **174×** | A −4 %, **B −27 %** |

A is essentially flat vs run5. B improves marginally on 1 h / 24 h (partition-PK alignment helps compaction produce tidier per-partition SSTs) but **regresses sharply on 7 d** — 8.3 s → 11.7 s p50, 1.12 → 0.82 QPS. The 7 d window crosses the boundary where per-partition scans start pulling many SST files; with `trace_id` in the PK, each of those SSTs now contains many more distinct series keys to merge, and the query has no `trace_id` filter to prune them. This is the price of the extra PK column showing up on the query path that can't use it.

#### Cursor pagination (Q-id, S1, 10 VU)

| A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | vs run5 |
|---|---|---|---|---|---|---|
| 39 ms | 151 ms | 195 | 156,549 ms | 180,941 ms | 0.055 | **A −23 % QPS, B −72 % QPS** |

**Strategy A regressed meaningfully**: p50 32 → 39 ms, QPS 252 → 195. **Strategy B is worse than run4**: 134 s → run5's 38 s → now 157 s p50. Only 10 queries completed in the 181-second window. The regression is caused by the same mechanism Q-time 7d exposes, amplified by the cursor pagination pattern: the cursor walks back through 18 months of history with no time floor, and the extra PK column means each SST hit along the way carries more series metadata and more merge work per timestamp band. For B it is compounded by 16-way fan-out and the `span_id` tie-breaker not being in the PK — every partition still re-sorts candidates.

### S2 — Conversation items

#### Time-range queries (Q-time, S2, 10 VU)

| Window | A p50 | A p99 | A QPS | A err | B p50 | B p99 | B QPS | B err | vs run5 |
|---|---|---|---|---|---|---|---|---|---|
| 1 h | 30 ms | 80 ms | 306 | 13 | 40 ms | 86 ms | 236 | 8 | A −44 %, B −44 % QPS |
| 24 h | 35 ms | 89 ms | 268 | 10 | 40 ms | 85 ms | 237 | 11 | A −51 %, B −44 % |
| 7 d | 44 ms | 137 ms | 192 | 4 | 79 ms | 243 ms | 111 | 0 | A −35 %, B −50 % |

Both strategies roughly halved their S2 Q-time throughput. S2 has 50k conversations/tenant, so putting `conversation_id` in the PK creates 50k distinct series per tenant where run5 had one. Q-time filters `created_at` and `tenant_id` but not `conversation_id`, so every scan must merge 50k series per tenant. Flat SST format handles millions of series cheaply for storage, but the per-query merge cost at read time is still linear in series touched within the scan window.

Error counts remain at the same order of magnitude as run4/run5 (~0.05 % rate on 1 h / 24 h windows); behaviour unchanged.

#### Cursor pagination (Q-id, S2, 10 VU)

| A p50 | A p99 | A QPS | A err | B p50 | B p99 | B QPS | vs run5 |
|---|---|---|---|---|---|---|---|
| 126 ms | 624 ms | 60 | 0 | 18,785 ms | 54,391 ms | 0.49 | **A −68 % QPS, B −89 % QPS** |

A: 45 ms → 126 ms p50, 186 → 60 QPS (3× regression). B: 1.35 s → 18.8 s p50, 4.4 → 0.49 QPS (14× regression). Same mechanism as S1 Q-id — the cursor predicate has no `conversation_id` filter, so the higher series cardinality from the PK expansion shows up on every page fetch. B additionally pays the same partition fan-out penalty noted in run5, now compounded.

### Conversation history (Q-conv, S2, 10 VU)

| Workload | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | A/B ratio | vs run5 |
|---|---|---|---|---|---|---|---|---|
| Clustered | 1,349 ms | 4,931 ms | 6.2 | 41,971 ms | 76,829 ms | 0.20 | **30×** | **A −88 %, B −92 % QPS** |
| Scattered | 1,346 ms | 4,886 ms | 6.1 | 38,201 ms | 85,454 ms | 0.22 | **28×** | **A −70 %, B −89 %** |

**This is the most counter-intuitive result of the run.** Q-conv filters on `conversation_id = ?` — exactly the column we added to the PK, supposedly to speed this query up. Instead:

- A clustered: 167 ms → 1,349 ms p50 (8× slower).
- A scattered: 390 ms → 1,346 ms p50 (3.5× slower).
- B clustered: 2,916 ms → 41,971 ms p50 (14× slower).
- B scattered: 4,674 ms → 38,201 ms p50 (8× slower).

The likely explanation: run5 used `SKIPPING INDEX WITH(type='BLOOM', granularity=10240)` on the cluster column. A BLOOM skipping index at 10k-row granularity was actually effective for equality lookup across SST files — it let the scanner skip entire 10k-row blocks in each SST that didn't contain the target conversation. With ITEM_PK=true we dropped the BLOOM (as redundant with PK membership), but the per-SST pruning we now rely on — series-key range pruning inside each SST — is either less effective or absent in the flat SST format for equality lookup on the *second* PK column (after `tenant_id` on B, or the leading PK on A). The net result is that each Q-conv call now opens more SST files and reads more data per file than run5 did.

Clustered (tight time window) collapses to roughly the same latency as scattered (wide time window) for A — 1,349 vs 1,346 ms — suggesting time-bound pruning is no longer doing useful work and the scan is dominated by conversation-id lookup across all SSTs.

---

## Memory Pressure (M1–M3)

50 VUs, 5 minutes, S1 Q-time (24h window).

| Scenario | Tenants | A p50 | A QPS | B p50 | B QPS | vs run5 |
|---|---|---|---|---|---|---|
| M1 | 1 | 359 ms | 136 | 1,670 ms | 29.0 | A +53 %, B +29 % QPS |
| M2 | 5 % (5) | 164 ms | 267 | 1,541 ms | 31.3 | **A −29 %, B −20 % QPS** |
| M3 | 50 % (50) | 42 ms | 766 | 1,565 ms | 31.1 | **A −13 %, B −23 %** |
| M4 (B only) | 50 % (50) | — | — | 1,541 ms | 31.4 | B −22 % |

Mixed picture. M1 (single tenant, same query repeated) actually improved for both strategies — higher series cardinality didn't penalise the narrowest working set. M2/M3/M4 regressed 13–29 % because broader tenant diversity amplifies the series-merge cost that ITEM_PK introduced. The M1→M3 shape (diversity improves QPS for A, stays flat for B) is still intact.

---

## Mixed Workload

70 % Q-time (1 h S1), 15 % Q-id (S1), 10 % W2, 5 % W1. 15-minute runs.

| VUs | A p50 | A p99 | A QPS | B p50 | B p99 | B QPS | B err | vs run5 |
|---|---|---|---|---|---|---|---|---|
| 10 | 73 ms | 314 ms | 115 | 105 ms | 215,397 ms | 0.35 | 2 | A −12 %, B −74 % QPS |
| 50 | 90 ms | 1,528 ms | 296 | 529 ms | 1,025,984 ms | 0.32 | 0 | A −5 %, B −52 % |
| 100 | 140 ms | 3,000 ms | 357 | 2,179 ms | 1,166,864 ms | 0.38 | 0 | A −7 %, B −47 % |

Strategy A degraded 5–12 % across concurrency levels — roughly the Q-id regression (−23 % QPS standalone) diluted by the 85 % of mixed traffic that isn't Q-id. Strategy B remains non-functional under mixed load: Q-id at 157 s p50 (vs 38 s in run5) stalls entire VU pools for minutes.

---

## Comparison with Run5

| Workload | Run5 A/B | Run6 A/B | Direction |
|---|---|---|---|
| S1 Q-time 1h | 15.9× | 16.3× | Same |
| S1 Q-time 7d | 134× | 174× | B regressed further |
| S1 Q-id | 1,326× | 3,528× | Both worse, B more |
| S2 Q-time 1h | 1.3× | 1.3× | Same ratio, both halved absolute |
| S2 Q-id | 29.9× | 149× | Both worse, B much more |
| Q-conv clustered | 17.5× | 31× | Both much worse |
| Q-conv scattered | 12.0× | 28× | Both much worse |
| Mixed 10 VU | 94× | 329× | B collapsed further |

Every ratio either held or widened in A's favour, but mostly because B degraded more than A. In absolute terms A regressed almost everywhere too.

---

## Conclusions

1. **ITEM_PK=true is a net loss and should not be used in production.** The hypothesis (PK co-location of trace/conversation rows speeds per-item fetches at the cost of higher series cardinality on Q-time) was falsified on both axes — Q-time got slower *and* Q-conv / Q-id got much slower. The BLOOM skipping index on the cluster column, which we dropped in this configuration, was doing real pruning work that the flat-SST PK scan is not replicating for equality lookups on non-leading PK columns.

2. **Run5's schema is the current best.** Strategy A with no PK and a BLOOM on `trace_id` / `conversation_id`; Strategy B with `PRIMARY KEY (tenant_id)` and the same BLOOM on the cluster column. Any future schema experiment should keep the BLOOM as the baseline for cluster-column equality lookup and measure against it.

3. **B's partition-PK alignment is not worth the series cardinality cost.** Adding `trace_id` / `conversation_id` to B's PK aligned PK with partition column — theoretically healthier for compaction — but the higher series cardinality on the read path outweighed any write-side benefit. Writes did not visibly improve (they were already fine in run5 after the seeding fix).

4. **Q-conv regression is the most informative result.** Q-conv is pure equality lookup on the PK column we added. The fact that it got 8–14× slower suggests flat SSTs don't offer strong per-file pruning for equality on non-leading PK columns — series-key range pruning inside an SST file appears to work well only when the leading PK column is constrained. For A (where `conversation_id` is the only PK column) this should not apply, yet Q-conv A still regressed 8×; this is worth a targeted EXPLAIN ANALYZE comparison between run5 and run6 A S2 before closing the investigation.

5. **Next steps if the ITEM_PK direction is pursued further**:
   - Run `EXPLAIN ANALYZE` on one Q-conv-clustered query under each schema to compare SST-files-scanned and bytes-read.
   - Try a schema with both the PK extension and the BLOOM retained (currently [ddl.ts:22-26](../src/schema/ddl.ts#L22-L26) drops the BLOOM when `itemPk` is on); if BLOOM retention restores Q-conv performance, the regression is BLOOM-pruning-specific.
   - Try a schema where only the cluster column is in the PK without `tenant_id` on B (or the reverse: just `tenant_id`) to isolate whether PK expansion *per se* or partition-alignment is the driver of the Q-time-7d regression.
   - None of these are necessary if the goal is just to pick a schema — run5's is already the winner.
