# ITEM_PK schema variant — benchmark summary for GreptimeDB team

## What we're modelling

We're configuring GreptimeDB as the primary store for a **multi-tenant Gen-AI observability product** and running this benchmark to **identify the optimal schema** for the workload — both the storage strategy (per-tenant tables vs. shared partitioned tables) and the PK / index layout within each. Two tables carry essentially all traffic and dominate the storage footprint, so the benchmark focuses exclusively on them:

- **Spans (S1)** — OpenTelemetry traces instrumented with the `gen_ai.*` semantic conventions. Each LLM request produces a small cluster of spans (root + a few children), with the bulk of the bytes in `gen_ai_input_messages` / `gen_ai_output_messages` string columns. Row sizes range from ~2 KB (single-turn Q&A) to ~430 KB (tool-call-heavy / max context); we seed with a realistic tier distribution.
- **Conversation items (S2)** — the per-item rows that make up user ↔ assistant conversations (user message, assistant message, tool result). Each row is small (~200 B – ~3 KB JSON payload). About 20 items per conversation on average, 50 k distinct conversations per tenant over 18 months.

The tension we're trying to resolve: Gen-AI workloads are **read-heavy on recent data** (UIs listing traces, fetching a conversation, paginating history) but need to retain **18 months of history** for replay/analysis, so the cold tail is large. Writes are steady rather than bursty, but every trace request writes 5 spans.

## Why the scenarios we run are the ones we care about

Every scenario below maps to a real product screen or subsystem:

| Workload | What it represents in the product |
|---|---|
| **W2** — batched span ingest (5 rows/batch, 1/10/50 concurrent writers) | OTel collector pushing spans from LLM request handlers |
| **W1** — sequential conversation-item insert (10–30 rows per conversation) | An active conversation where items stream in one at a time |
| **Q-time** — `tenant + timestamp range` scan, 1 h / 24 h / 7 d windows, LIMIT 50 | Trace list UI and dashboard queries; the 1 h window is by far the hot path |
| **Q-id** — cursor pagination (`timestamp < cursor` + tie-break) | "Load more" on the trace list, walking back through history |
| **Q-conv** — fetch full conversation history by `conversation_id` (equality) | Opening a conversation in the UI. Two sub-shapes: **clustered** (single session, items within ±48 h) and **scattered** (long-running conversation spread across 18 months) |
| **M1–M4** — 50 VU read burst with varying tenant diversity (1 / 5 % / 50 % of tenants) | Cache-pressure test: does throughput collapse when many tenants are active simultaneously? |
| **Mixed** — 70 % Q-time / 15 % Q-id / 10 % W2 / 5 % W1 at 10 / 50 / 100 VU, 15 min | Realistic production traffic shape |

Both storage strategies are run against every scenario:

- **Strategy A — Per-tenant tables** (`spans_<uuid>`, `conversation_items_<uuid>`). No `tenant_id` column, no partition clause. Natural data isolation.
- **Strategy B — Shared tables**, 16 range partitions keyed on the per-item cluster column (`trace_id` for spans, `conversation_id` for conversation items). Every query carries `WHERE tenant_id = ?`.

At 100 tenants Strategy A ends up with 200 table objects; Strategy B has 2. That ratio is the fundamental trade-off we're trying to measure.

## Cluster & scale

- **Image**: `greptime/greptimedb:v1.0.0` (stable, flat SST format default).
- **Cluster**: 3 datanodes × (4 vCPU / 16 GiB) + 2 frontends, HAProxy load-balancer, metasrv, postgres — all on one `m7i-flex.8xlarge` EC2 instance with gp3 EBS (16 k IOPS, 1 GiB/s throughput, 16TB disk). The single-instance setup is deliberate: it keeps network latency out of the numbers so we can attribute deltas to storage behaviour.
- **Scale**: 100 tenants × 500 k spans × 1 M conversation items × 50 k conversations per tenant. Stratified-timestamp seeding so SSTs don't all overlap in time; clustered-conversation batches are sorted by timestamp before write so one conversation's rows co-locate in the SST.
- **Historical depth**: 18 months, ~75 % of rows older than 4 months (cold SSTs), ~15 % in the last 3 months, ~10 % in the last 7 days (hot).

## Baseline result (before the PK experiment)

With the run5 schema (no PK on A, `PRIMARY KEY (tenant_id)` on B, BLOOM on the per-item cluster column in both), **Strategy A wins on every read workload** and the two strategies are effectively tied on writes:

| Workload | A QPS | B QPS | A / B |
|---|---|---|---|
| W2 span ingest, 50 VU | 1,559 | 1,528 | ≈ tied |
| W1 conv-item insert, 50 VU | 305 | 295 | ≈ tied |
| S1 Q-time 1 h | 144 | 9.1 | 16× |
| S1 Q-time 7 d | 148 | 1.1 | 134× |
| S1 Q-id (cursor) | 252 | 0.19 | **1,326×** |
| S2 Q-time 1 h | 546 | 424 | 1.3× |
| S2 Q-id | 186 | 4.4 | 42× |
| Q-conv clustered | 50.2 | 2.7 | 19× |
| Q-conv scattered | 20.2 | 2.0 | 10× |
| Mixed 10 VU | 130 | 1.4 | 94× |

The `ITEM_PK` experiment below was one attempt to close Strategy B's read gap: align the PK with the partition column and co-locate per-item rows.

## ITEM_PK configurations compared

The only schema difference between run5 and run6 is the `ITEM_PK` env flag. When enabled, it appends the per-item cluster column to each table's `PRIMARY KEY` and — because a column in the PK is already a TAG — drops its `SKIPPING INDEX WITH(type='BLOOM')` as redundant.

| | Run5 (`ITEM_PK=false`) | Run6 (`ITEM_PK=true`) |
|---|---|---|
| **A — spans** | No PK; `trace_id ... SKIPPING INDEX BLOOM` | `PRIMARY KEY (trace_id)`; BLOOM dropped |
| **A — conversation_items** | No PK; `conversation_id ... SKIPPING INDEX BLOOM` | `PRIMARY KEY (conversation_id)`; BLOOM dropped |
| **B — spans** | `PRIMARY KEY (tenant_id)`; `trace_id ... SKIPPING INDEX BLOOM`; `PARTITION ON (trace_id)` | `PRIMARY KEY (tenant_id, trace_id)`; BLOOM dropped; partition unchanged |
| **B — conversation_items** | `PRIMARY KEY (tenant_id)`; `conversation_id ... SKIPPING INDEX BLOOM`; `PARTITION ON (conversation_id)` | `PRIMARY KEY (tenant_id, conversation_id)`; BLOOM dropped; partition unchanged |

Everything else (cluster, seed, scenarios, VU counts, durations, data volume) is identical between the two runs.

## Result

Headline deltas, run6 vs run5 (QPS unless noted), same cluster, same data, same workload:

| Workload | Strategy A | Strategy B |
|---|---|---|
| W1 / W2 (writes) | flat to −10 % | flat to −8 % |
| S1 Q-time 1h / 24h | +5–9 % | +6–9 % |
| S1 Q-time 7d | −4 % | **−27 %** |
| S1 Q-id (cursor pagination) | **−23 %** (32 → 39 ms p50) | **−72 %** (38 s → 157 s p50) |
| S2 Q-time 1h / 24h / 7d | **−35 % to −51 %** | **−44 % to −50 %** |
| S2 Q-id | **−68 %** (45 → 126 ms p50) | **−89 %** (1.35 s → 18.8 s p50) |
| Q-conv clustered | **−88 %** (167 ms → 1,349 ms p50) | **−92 %** (2.9 s → 42 s p50) |
| Q-conv scattered | **−70 %** (390 ms → 1,346 ms p50) | **−89 %** (4.7 s → 38 s p50) |
| Mixed 10 / 50 / 100 VU | −5 % to −12 % | −47 % to −74 % |
| M1 (single tenant) | +53 % | +29 % |
| M2 / M3 / M4 (tenant diversity) | −13 % to −29 % | −20 % to −23 % |

The direction is the same on A and B — ITEM_PK=true regressed reads almost everywhere, with only S1 Q-time on short windows and single-tenant M1 improving. Q-conv (pure equality lookup on the column added to the PK) regressed 8–14×.

## Reference — schema

### Strategy A

```sql
-- One table per tenant. <suffix> = tenant UUID with dashes removed.

-- Spans
CREATE TABLE IF NOT EXISTS spans_<suffix> (
  "timestamp"            TIMESTAMP(9) NOT NULL,
  timestamp_end          TIMESTAMP(9),
  duration_nano          BIGINT UNSIGNED,
  -- ITEM_PK=false:  trace_id VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=10240)
  -- ITEM_PK=true:   trace_id VARCHAR(32) NOT NULL
  trace_id               VARCHAR(32) NOT NULL <see note>,
  span_id                VARCHAR(16) NOT NULL,
  parent_span_id         VARCHAR(16),
  span_name              VARCHAR(256),
  span_kind              VARCHAR(64),
  span_status_code       VARCHAR(64),
  span_status_message    VARCHAR(512),
  trace_state            VARCHAR(256),
  service_name           STRING,
  scope_name             VARCHAR(256),
  scope_version          VARCHAR(64),
  gen_ai_operation       VARCHAR(64),
  gen_ai_system          VARCHAR(64),
  gen_ai_request_model   VARCHAR(128),
  gen_ai_response_model  VARCHAR(128),
  gen_ai_input_tokens    BIGINT,
  gen_ai_output_tokens   BIGINT,
  gen_ai_total_tokens    BIGINT,
  gen_ai_finish_reasons  VARCHAR(128),
  gen_ai_input_messages  STRING,
  gen_ai_output_messages STRING,
  span_attributes        STRING,
  span_events            STRING,
  span_links             STRING,
  TIME INDEX ("timestamp")
  -- ITEM_PK=true only:  , PRIMARY KEY (trace_id)
)
WITH ('append_mode' = 'true');

-- Conversation items
CREATE TABLE IF NOT EXISTS conversation_items_<suffix> (
  "id"            VARCHAR(36) NOT NULL,
  -- ITEM_PK=false: conversation_id VARCHAR(36) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=10240)
  -- ITEM_PK=true:  conversation_id VARCHAR(36) NOT NULL
  conversation_id VARCHAR(36) NOT NULL <see note>,
  created_at      TIMESTAMP(3) NOT NULL,
  "type"          VARCHAR(64),
  "data"          STRING,
  TIME INDEX ("created_at")
  -- ITEM_PK=true only:  , PRIMARY KEY (conversation_id)
)
WITH ('append_mode' = 'true');
```

### Strategy B

```sql
-- Shared tables, 16 partitions on the per-item cluster column
-- (trace_id for spans, conversation_id for conversation_items).
-- Partition ranges: hex-digit first character, uniform over UUIDv4.

CREATE TABLE IF NOT EXISTS spans (
  tenant_id              VARCHAR(36) NOT NULL INVERTED INDEX,
  "timestamp"            TIMESTAMP(9) NOT NULL,
  timestamp_end          TIMESTAMP(9),
  duration_nano          BIGINT UNSIGNED,
  -- ITEM_PK=false / true: same options as Strategy A
  trace_id               VARCHAR(32) NOT NULL <see note>,
  span_id                VARCHAR(16) NOT NULL,
  parent_span_id         VARCHAR(16),
  span_name              VARCHAR(256),
  span_kind              VARCHAR(64),
  span_status_code       VARCHAR(64),
  span_status_message    VARCHAR(512),
  trace_state            VARCHAR(256),
  service_name           STRING,
  scope_name             VARCHAR(256),
  scope_version          VARCHAR(64),
  gen_ai_operation       VARCHAR(64),
  gen_ai_system          VARCHAR(64),
  gen_ai_request_model   VARCHAR(128),
  gen_ai_response_model  VARCHAR(128),
  gen_ai_input_tokens    BIGINT,
  gen_ai_output_tokens   BIGINT,
  gen_ai_total_tokens    BIGINT,
  gen_ai_finish_reasons  VARCHAR(128),
  gen_ai_input_messages  STRING,
  gen_ai_output_messages STRING,
  span_attributes        STRING,
  span_events            STRING,
  span_links             STRING,
  TIME INDEX ("timestamp"),
  -- ITEM_PK=false:  PRIMARY KEY (tenant_id)
  -- ITEM_PK=true:   PRIMARY KEY (tenant_id, trace_id)
  PRIMARY KEY (<see note>)
)
PARTITION ON COLUMNS (trace_id) (
    trace_id < '1',
    trace_id >= '1' AND trace_id < '2',
    ...  -- 16 hex ranges total: '0'..'1', '1'..'2', ..., 'e'..'f', >= 'f'
    trace_id >= 'f'
)
WITH ('append_mode' = 'true');

CREATE TABLE IF NOT EXISTS conversation_items (
  tenant_id       VARCHAR(36) NOT NULL INVERTED INDEX,
  "id"            VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL <see note>,
  created_at      TIMESTAMP(3) NOT NULL,
  "type"          VARCHAR(64),
  "data"          STRING,
  TIME INDEX ("created_at"),
  -- ITEM_PK=false:  PRIMARY KEY (tenant_id)
  -- ITEM_PK=true:   PRIMARY KEY (tenant_id, conversation_id)
  PRIMARY KEY (<see note>)
)
PARTITION ON COLUMNS (conversation_id) (
    conversation_id < '1',
    ...  -- 16 hex ranges as above
    conversation_id >= 'f'
)
WITH ('append_mode' = 'true');
```

## Reference — workload queries

All reads are issued against a random tenant per call; for Strategy A the table name is `spans_<suffix>` / `conversation_items_<suffix>` and the `tenant_id` filter is omitted.

### W2 — batched span ingest

5 rows per batch (1 root span + 4 children, same `trace_id`) via InfluxDB line protocol (`/api/v1/influxdb/write`). Row size drawn from: 10 % ~2 KB, 40 % ~5 KB, 35 % ~20 KB, 12 % ~90 KB, 3 % ~430 KB.

### W1 — sequential conversation-item insert

```sql
-- Repeated 10–30 times per outer call (one per item in the conversation).
-- created_at advances by 1 ms per item; same conversation_id for the whole batch.
INSERT INTO conversation_items (id, conversation_id, created_at, type, data, tenant_id)
VALUES (?, ?, ?, ?, ?, ?);
```

### Q-time — recent window

```sql
-- S1 (1 h / 24 h / 7 d windows)
SELECT trace_id, span_id, "timestamp", duration_nano,
       gen_ai_system, gen_ai_request_model,
       gen_ai_input_tokens, gen_ai_output_tokens
FROM spans
WHERE tenant_id = $1
  AND "timestamp" > $2
ORDER BY "timestamp" DESC
LIMIT 50;

-- S2 (1 h / 24 h / 7 d windows)
SELECT "id", conversation_id, created_at, "type"
FROM conversation_items
WHERE tenant_id = $1
  AND conversation_id = $2
  AND created_at > $3
ORDER BY created_at DESC
LIMIT 50;
```

### Q-id — cursor pagination

```sql
-- S1 first page
SELECT trace_id, span_id, "timestamp", duration_nano,
       gen_ai_system, gen_ai_request_model,
       gen_ai_input_tokens, gen_ai_output_tokens
FROM spans
WHERE tenant_id = $1 AND "timestamp" <= $now
ORDER BY "timestamp" DESC, span_id DESC
LIMIT 50;

-- S1 subsequent pages
SELECT ...
FROM spans
WHERE tenant_id = $1
  AND ("timestamp" < $cursor_ts
       OR ("timestamp" = $cursor_ts AND span_id < $cursor_id))
ORDER BY "timestamp" DESC, span_id DESC
LIMIT 50;

-- S2 first page
SELECT "id", conversation_id, created_at, "type"
FROM conversation_items
WHERE tenant_id = $1 AND conversation_id = $2
ORDER BY created_at DESC, "id" DESC
LIMIT 50;

-- S2 subsequent pages
SELECT ...
FROM conversation_items
WHERE tenant_id = $1
  AND conversation_id = $2
  AND (created_at < $cursor_ts
       OR (created_at = $cursor_ts AND "id" < $cursor_id))
ORDER BY created_at DESC, "id" DESC
LIMIT 50;
```

### Q-conv — full conversation history

```sql
SELECT "id", conversation_id, created_at, "type", "data"
FROM conversation_items
WHERE tenant_id = $1 AND conversation_id = $2
ORDER BY created_at ASC;
```

Two sub-shapes differ only in which conversation is picked:
- **Clustered** — conversations whose items are seeded within ±48 h of a single anchor time.
- **Scattered** — conversations whose items are spread randomly across the full 18 months.
