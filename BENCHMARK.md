# GreptimeDB Storage Strategy Benchmark

## Objective

Determine whether **Strategy A** (one table per tenant, single partition) or **Strategy B**
(one shared table, `tenant_id` column, 16 partitions) performs better for two workloads:

- **Scenario S1 — Gen AI traces/spans** (OTel-modelled)
- **Scenario S2 — Conversation items** (`conversation_items`)

The primary axes are query latency for recent bounded fetches (~50 rows), write throughput,
and memory/cache behavior under concurrent multi-tenant load.

---

## Strategies under test

### Strategy A — Per-tenant tables

```sql
-- One table per tenant, no tenant column, no partition clause needed
CREATE TABLE spans_<tenant_id> ( ... );
CREATE TABLE conversations_<tenant_id> ( ... );
CREATE TABLE conversation_items_<tenant_id> ( ... );
```

- Natural data isolation; no `WHERE tenant_id = ?` filter in queries.
- Working set per query is proportional to that tenant's table size.
- At 100 tenants × 2 table types = 200 table objects with independent memtables,
  SST files, and compaction threads.

### Strategy B — Shared tables, 16 partitions

```sql
-- One table for all tenants, partitioned by first hex character of tenant_id (UUIDv4)
PARTITION ON COLUMNS (tenant_id) (
  tenant_id < '1',
  tenant_id >= '1' AND tenant_id < '2',
  tenant_id >= '2' AND tenant_id < '3',
  tenant_id >= '3' AND tenant_id < '4',
  tenant_id >= '4' AND tenant_id < '5',
  tenant_id >= '5' AND tenant_id < '6',
  tenant_id >= '6' AND tenant_id < '7',
  tenant_id >= '7' AND tenant_id < '8',
  tenant_id >= '8' AND tenant_id < '9',
  tenant_id >= '9' AND tenant_id < 'a',
  tenant_id >= 'a' AND tenant_id < 'b',
  tenant_id >= 'b' AND tenant_id < 'c',
  tenant_id >= 'c' AND tenant_id < 'd',
  tenant_id >= 'd' AND tenant_id < 'e',
  tenant_id >= 'e' AND tenant_id < 'f',
  tenant_id >= 'f'
)
```

All queries include `WHERE tenant_id = ?`. UUIDv4 first characters are uniformly
distributed across 0–f, so load is evenly spread across 16 partitions.

---

## Schema definitions

### S1 — Spans (official GreptimeDB `greptime_trace_v1` model)

```sql
-- Strategy B (shared table).
-- For Strategy A: remove tenant_id column; no PARTITION clause.
CREATE TABLE spans (
  -- Tenant (Strategy B only)
  tenant_id              VARCHAR(36)   NOT NULL  INVERTED INDEX,

  -- Timing (reserved word — must be quoted)
  "timestamp"            TIMESTAMP(9)  NOT NULL TIME INDEX,
  timestamp_end          TIMESTAMP(9),
  duration_nano          BIGINT UNSIGNED,

  -- Identifiers
  trace_id               VARCHAR(32)   NOT NULL  SKIPPING INDEX WITH (type='BLOOM', granularity=10240),
  span_id                VARCHAR(16)   NOT NULL,
  parent_span_id         VARCHAR(16),

  -- Span metadata
  span_name              VARCHAR(256)  INVERTED INDEX,
  span_kind              VARCHAR(64),
  span_status_code       VARCHAR(64),
  span_status_message    VARCHAR(512),
  trace_state            VARCHAR(256),

  -- Service / scope
  -- SKIPPING BLOOM matches official greptime_trace_v1 model; service_name is the series key
  service_name           STRING        SKIPPING INDEX WITH (granularity=10240, type='BLOOM'),
  scope_name             VARCHAR(256),
  scope_version          VARCHAR(64),

  -- Gen AI scalar attributes (typed columns — not JSON)
  gen_ai_operation       VARCHAR(64),
  gen_ai_system          VARCHAR(64),
  gen_ai_request_model   VARCHAR(128),
  gen_ai_response_model  VARCHAR(128),
  gen_ai_input_tokens    INT,
  gen_ai_output_tokens   INT,
  gen_ai_total_tokens    INT,
  gen_ai_finish_reasons  VARCHAR(128),

  -- Bulk payload columns (dominate row size)
  gen_ai_input_messages  STRING,   -- JSON, opt-in
  gen_ai_output_messages STRING,   -- JSON, opt-in

  -- Overflow / compound fields
  span_attributes        STRING,
  span_events            JSON,
  span_links             JSON,

  PRIMARY KEY (service_name)
)
PARTITION ON COLUMNS (tenant_id) (
  -- 16 ranges as listed in the Strategy B section above
)
WITH ('append_mode' = 'true');
```

### S2 — Conversation items

```sql
-- Strategy B (shared table).
-- For Strategy A: remove tenant_id column; no PARTITION clause.
CREATE TABLE conversation_items (
  tenant_id       VARCHAR(36)   NOT NULL  INVERTED INDEX,
  "id"            VARCHAR(36)   NOT NULL,   -- UUIDv4 (reserved word — must be quoted)
  -- SKIPPING BLOOM for high-cardinality UUID equality lookups (WHERE conversation_id = ?)
  conversation_id VARCHAR(36)   NOT NULL  SKIPPING INDEX WITH (type='BLOOM', granularity=10240),
  created_at      TIMESTAMP(3)  NOT NULL TIME INDEX,
  "type"          VARCHAR(64),              -- reserved word — must be quoted
  "data"          STRING,                   -- JSON, item payload (reserved word — must be quoted)
  -- No PRIMARY KEY tag: conversation_id has 50K distinct UUIDs per tenant (avg 20 rows/series).
  -- Purely time-ordered within each tenant partition; BLOOM index handles conversation lookups.
)
PARTITION ON COLUMNS (tenant_id) (
  -- 16 ranges as above
)
WITH ('append_mode' = 'true');
```

---

## Scale parameters

Run the benchmark at a single representative scale. Re-run at 1 000 tenants as a
follow-up to locate the crossover point for Strategy A's memory overhead.

| Parameter | Value | Notes |
|---|---|---|
| Tenants | 100 | UUIDv4, first chars uniformly spread 0–f |
| Conversation items per tenant | 1 000 000 | ~20 items × 50 000 conversations |
| Distinct conversation IDs per tenant | 50 000 | ~18 months of moderate usage |
| Spans per tenant | 500 000 | ~50 req/day × 10 spans/req × 18 months |
| Historical depth | 18 months | 90% of rows older than 7 days |
| Recent data (last 7 days) | 10% of rows | Lands in current memtable / L0 |

Tenant distribution: **uniform** (equal data volume per tenant).

---

## Data generation

### Seeding time distribution

Insert rows with timestamps distributed as follows so the SST compaction state
mirrors production:

```
Months 4–18 ago  →  75% of rows   (deep compacted, cold SSTs)
Months 1–3 ago   →  15% of rows   (partially compacted)
Last 7 days      →  10% of rows   (insert last, lands in memtable / L0)
```

Insert historical rows first in timestamp order, then insert recent rows. After
seeding, issue `FLUSH TABLE <name>` and wait for background compaction to settle
before starting benchmark runs.

### Span row size distribution

`gen_ai.input.messages` and `gen_ai.output.messages` dominate row size. Use
this distribution when generating span payloads:

| Tier | Share | Input messages | Output messages | Approx total row | Represents |
|---|---|---|---|---|---|
| Tiny | 10% | ~400 B | ~150 B | ~2 KB | Single-turn Q&A |
| Small | 40% | ~3 KB | ~500 B | ~5 KB | Short chat, 3–5 turns |
| Medium | 35% | ~15 KB | ~2 KB | ~20 KB | Multi-turn, 10–20 turns |
| Large | 12% | ~80 KB | ~5 KB | ~90 KB | Long context / RAG |
| XLarge | 3% | ~400 KB | ~20 KB | ~430 KB | Tool-call heavy / max context |

Each message follows the OTel gen_ai structure:

```json
[
  { "role": "system",    "content": [{ "type": "text", "text": "..." }] },
  { "role": "user",      "content": [{ "type": "text", "text": "..." }] },
  { "role": "assistant", "content": [{ "type": "text", "text": "..." }] }
]
```

Use randomly-generated plausible-length text (~4 bytes per token). Do not use
repeated or compressible strings — they produce unrealistically favorable
compression ratios.

Report seeded data volume (pre- and post-compression via
`information_schema.tables`) alongside row counts.

### Conversation item payloads

`conversation_items.data` stores a JSON object representing the item content.
Use a flat structure with a `content` string field scaled to realistic sizes:

| Type | Share | `data` size | Example |
|---|---|---|---|
| User message | 40% | ~200 B | `{"content": "..."}` |
| Assistant message | 40% | ~1 KB | `{"content": "..."}` |
| Tool result | 20% | ~3 KB | `{"content": "...", "tool_call_id": "..."}` |

---

## Write workloads

### W1 — Conversation item insert (S2)

```
INSERT conversation_items — N rows sequentially for a single conversation_id
N drawn from 10–30 uniform
```

Each item is inserted individually (no batch INSERT) with a 1 ms timestamp
offset per item to ensure unique TIME INDEX values within a conversation.

Measure end-to-end wall time per batch (sum of all sequential inserts for one
conversation).

Concurrency: 1, 10, 50 virtual writers, each writing to a different tenant.

### W2 — Span batch ingest (S1)

A single LLM request produces a small cluster of spans (root + child spans):

```
INSERT spans — 5 rows per batch (1 root span + 4 child spans)
Row size tier drawn from the distribution above.
```

Concurrency: 1, 10, 50 virtual writers, each writing to a different tenant.

Report throughput in rows/sec and MB/sec separately — the MB/sec metric reflects
the large-row tiers more faithfully than row count alone.

---

## Read workloads

All queries fetch at most 50 rows. Two query shapes cover all production access
patterns:

### Q-time — Recent window scan

```sql
-- S1 spans (metadata projection only)
SELECT trace_id, span_id, timestamp, duration_nano,
       "span_attributes.gen_ai.system",
       "span_attributes.gen_ai.request.model",
       "span_attributes.gen_ai.usage.input_tokens",
       "span_attributes.gen_ai.usage.output_tokens"
FROM spans
WHERE tenant_id = ?                              -- omit for Strategy A
  AND timestamp > NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC
LIMIT 50;

-- S2 conversation items
SELECT id, conversation_id, created_at, type, data
FROM conversation_items
WHERE tenant_id = ?                              -- omit for Strategy A
  AND conversation_id = $conversation_id
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 50;
```

Time window variants: last 1 hour, last 24 hours, last 7 days.
Mix: 60% / 30% / 10% — weighted toward the most recent window.

### Q-id — Cursor-based pagination

```sql
-- S1 spans
SELECT trace_id, span_id, timestamp, duration_nano,
       "span_attributes.gen_ai.system",
       "span_attributes.gen_ai.request.model",
       "span_attributes.gen_ai.usage.input_tokens",
       "span_attributes.gen_ai.usage.output_tokens"
FROM spans
WHERE tenant_id = ?                              -- omit for Strategy A
  AND (timestamp < $cursor_ts
       OR (timestamp = $cursor_ts AND span_id < $cursor_id))
ORDER BY timestamp DESC, span_id DESC
LIMIT 50;

-- S2 conversation items
SELECT id, conversation_id, created_at, type, data
FROM conversation_items
WHERE tenant_id = ?                              -- omit for Strategy A
  AND conversation_id = $conversation_id
  AND (created_at < $cursor_ts
       OR (created_at = $cursor_ts AND id < $cursor_id))
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

Cursor depth variants: page 1 (no cursor), page 5, page 20.
Mix: 70% / 20% / 10%.

### Q-full — Full row fetch including message payloads (S1 only)

Same filter as Q-time but selects all columns including the bulk payload columns.
Measures the cost of returning large string columns versus the metadata-only
projection.

```sql
SELECT *
FROM spans
WHERE tenant_id = ?                              -- omit for Strategy A
  AND timestamp > NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC
LIMIT 50;
```

Run Q-time and Q-full back-to-back on the same dataset. The delta quantifies
how much GreptimeDB's columnar layout benefits projection when message columns
are excluded.

---

## Memory pressure workloads

This is the core risk of Strategy A: concurrent queries from different tenants
load different SST files into cache, evicting each other's working sets.

Run all four scenarios for both strategies. The only variable is tenant diversity.
All other parameters — concurrency, query type, data volume — are identical.

| Scenario | VUs | Distinct tenants queried | Purpose |
|---|---|---|---|
| M1 | 50 | 1 | Baseline — no cache pressure |
| M2 | 50 | 5 | Mild pressure |
| M3 | 50 | 50 | Full pressure — each VU hits a different table (Strategy A critical case) |
| M4 | 50 | 50 | Same as M3 but Strategy B |

Query: Q-time with 24 h window (medium working set, representative of a dashboard).

M3 vs M4 directly isolates the memory overhead of Strategy A under realistic
multi-tenant concurrency.

**GreptimeDB Prometheus metrics to scrape every 5 seconds during M1–M4:**

```
greptime_mito_memtable_usage_bytes
greptime_mito_cache_bytes{type="index"}
greptime_mito_cache_bytes{type="data"}
greptime_mito_cache_hit_total
greptime_mito_cache_miss_total
greptime_mito_open_files_total
```

Cache hit rate drop between M1→M3 (Strategy A) vs M1→M4 (Strategy B) is the
key signal. If Strategy A's hit rate collapses at 50 tenants but Strategy B holds
steady, that sets the practical tenant-count ceiling for Strategy A.

---

## Mixed workload

Simulates realistic production traffic: predominantly reads of recent data with
a continuous stream of writes.

```
70%  Q-time  (last 1 h window, metadata projection)
15%  Q-id    (cursor pagination, page 1–5)
10%  W2      (span ingest, 5 spans/batch)
5%   W1      (conversation item insert, 10–30 items)
```

Tenant selection: uniform random across all 100 tenants.
Concurrency: 10, 50, 100 VUs.
Duration: 15 minutes (allows at least one compaction cycle to occur mid-run).

---

## Metrics to collect

### Per workload and strategy

| Metric | Unit | How |
|---|---|---|
| Latency P50 / P90 / P95 / P99 | ms | Client-side timing per operation |
| Throughput | queries/sec | Client-side |
| Write throughput | MB/sec | Client-side (rows × avg row size) |
| Error rate | % | Client-side |

### Server-side (scraped per run)

| Metric | Significance |
|---|---|
| `greptime_mito_memtable_usage_bytes` | Total memtable footprint — multiplied by table count in Strategy A |
| Cache hit/miss ratio | Drop under multi-tenant load signals cache thrashing |
| `greptime_mito_open_files_total` | File handle pressure — Strategy A has more SST files |
| CPU utilization | Background compaction cost |
| Disk read IOPS / bytes | Cold query cost |

### Storage efficiency (measured after seeding, before benchmark)

```sql
SELECT table_name,
       data_length,      -- compressed bytes on disk
       data_free         -- uncompressed estimate
FROM information_schema.tables
WHERE table_schema = 'public';
```

Report compressed size per tenant (Strategy A: sum across per-tenant tables;
Strategy B: total ÷ 100 as per-tenant share).

---

## Decision criteria

| Criterion | Favors A | Favors B |
|---|---|---|
| Q-time P99 (single tenant, cold) | ✓ smaller SST footprint | |
| Q-time P99 under 50-tenant concurrency | | ✓ shared SST blocks |
| Cache hit rate: M1 vs M3 | | ✓ stable under tenant diversity |
| Write throughput at 50 VUs | similar | similar |
| Storage size (compressed) | | ✓ more cross-row repetition |
| Table/object count at 1 000 tenants | | ✓ fixed at 3 tables |
| Q-full vs Q-time projection speedup | | ✓ columnar separation |

**Expected outcome**: Strategy A wins on single-tenant read latency for small,
warm tables. Strategy B holds up better as tenant concurrency increases and cache
pressure rises. The break-even point is likely between 20–100 concurrent tenants
depending on instance memory and configured block cache size.

If the cache hit rate in M3 (Strategy A, 50 tenants) stays above ~80%, Strategy A
is viable at this scale. If it drops below ~50%, the latency penalty will dominate.

---

## Implementation layout

```
benchmark/
  seed/
    tenants.ts          -- generate 100 tenant UUIDs with uniform first-char distribution
    spans.ts            -- generate span rows by tier distribution
    conversations.ts    -- generate conversation_items rows
    index.ts            -- orchestrate seeding: historical first, then recent
  workloads/
    q-time.ts           -- Q-time parameterized query
    q-id.ts             -- Q-id cursor query
    q-full.ts           -- Q-full (spans including message columns)
    w1.ts               -- conversation item insert
    w2.ts               -- span batch ingest
  runner/
    concurrency.ts      -- VU pool, tenant selector, workload mixer
    metrics.ts          -- latency histogram, throughput counter
    scrape.ts           -- Prometheus scrape loop for server-side metrics
    index.ts            -- run matrix: scenario × strategy × concurrency level
  schema/
    strategy-a.sql      -- per-tenant DDL: spans_<tenant>, conversation_items_<tenant>
    strategy-b.sql      -- shared table DDL: spans, conversation_items
  results/              -- CSV output per run
  BENCHMARK.md          -- this file
```

Connect to GreptimeDB via the PostgreSQL wire protocol using **Bun.sql** (Bun's
built-in PostgreSQL client). Pass timestamps as native `Date` objects — Bun.sql
serialises them correctly. Set `prepare: false` is not required with recent nightly
builds; standard extended query protocol works.

---

## Test environment

- **GreptimeDB cluster** (`docker-compose.yml`):
  - 3 × datanode — 2 vCPU / 8 GiB each, independent NVMe-backed volumes
  - 2 × frontend — 2 vCPU / 8 GiB each
  - HAProxy load balancer — round-robins client connections across both frontends
  - PostgreSQL 17 as metasrv metadata backend (`--backend=postgres-store`)
  - 16 partitions distributed across datanodes
- **Block cache**: leave at GreptimeDB default values — document the configured
  instance memory so results can be interpreted in context
- **Client machine**: separate host, same network / AZ, to avoid co-location effects
- **Isolation**: no other workloads on either machine during benchmark runs
- **Warm-up**: 60 seconds of mixed load before recording metrics

### Local smoke profile

For local iteration without the full dataset, override scale via env vars:

```bash
TENANT_COUNT=10 \
SPANS_PER_TENANT=5000 \
ITEMS_PER_TENANT=10000 \
CONVERSATIONS_PER_TENANT=500 \
bun run seed -- --strategy b
```

Pass `--no-warmup --skip-scrape` to the runner to skip the 60 s warm-up and
Prometheus scraping during local runs.
