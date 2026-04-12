export const config = {
  dbUrl: process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public',
  httpUrl: process.env.GREPTIMEDB_HTTP_URL ?? 'http://localhost:4000',
  // Comma-separated list of datanode HTTP metrics endpoints.
  // Datanodes expose mito storage metrics (cache, memtable, open-files).
  // The frontend (:4000) only exposes catalog/routing metrics, NOT mito metrics.
  prometheusUrls: (process.env.GREPTIMEDB_PROMETHEUS_URLS ?? 'http://localhost:15000/metrics,http://localhost:15001/metrics,http://localhost:15002/metrics').split(',').map(u => u.trim()),
  tenantCount: parseInt(process.env.TENANT_COUNT ?? '100', 10),
  spansPerTenant: parseInt(process.env.SPANS_PER_TENANT ?? '500000', 10),
  itemsPerTenant: parseInt(process.env.ITEMS_PER_TENANT ?? '1000000', 10),
  conversationsPerTenant: parseInt(process.env.CONVERSATIONS_PER_TENANT ?? '50000', 10),
  resultsDir: process.env.RESULTS_DIR ?? './results',
  seedBatchSize: parseInt(process.env.SEED_BATCH_SIZE ?? '500', 10),
  spanBatchSize: parseInt(process.env.SPAN_BATCH_SIZE ?? '100', 10),
  // How many tenants to seed in parallel per worker process.
  // Row generation is CPU-bound and dominates over async HTTP (localhost round trip is negligible).
  // Use --workers to scale throughput; SEED_CONCURRENCY=1 is sufficient.
  // Raise --workers until GreptimeDB returns 1003 (write-path overload), then back off by 2.
  seedConcurrency: parseInt(process.env.SEED_CONCURRENCY ?? '1', 10),
  // Scale data per tenant down proportionally when running large tenant counts.
  // e.g. SPARSE_MULTIPLIER=0.2 gives 100k spans/tenant at 10k tenants.
  sparseMultiplier: parseFloat(process.env.SPARSE_MULTIPLIER ?? '1.0'),
  // Fraction of per-tenant rows to seed as historical (>4 months old).
  // Recent (15%) and fresh (10%) shares are fixed; reducing this below 0.75
  // shrinks total seeded rows proportionally without touching the hot data.
  // e.g. HISTORICAL_SHARE=0.65 seeds 90% of the target rows per tenant.
  historicalShare: parseFloat(process.env.HISTORICAL_SHARE ?? '0.65'),
  // Add conversation_id to the PRIMARY KEY of conversation_items tables.
  // Physically co-locates items per conversation in SST files, making q-conv-scattered fast
  // at the cost of higher series cardinality (50k series/tenant vs 1).
  // Run with CONV_PK=false (default) and CONV_PK=true to compare.
  convPk: (process.env.CONV_PK ?? 'false') === 'true',
};
