export const config = {
  dbUrl: process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public',
  // Comma-separated list of datanode HTTP metrics endpoints.
  // Datanodes expose mito storage metrics (cache, memtable, open-files).
  // The frontend (:4000) only exposes catalog/routing metrics, NOT mito metrics.
  prometheusUrls: (process.env.GREPTIMEDB_PROMETHEUS_URLS ?? 'http://localhost:5000/metrics,http://localhost:5001/metrics,http://localhost:5002/metrics').split(',').map(u => u.trim()),
  tenantCount: parseInt(process.env.TENANT_COUNT ?? '100', 10),
  spansPerTenant: parseInt(process.env.SPANS_PER_TENANT ?? '500000', 10),
  itemsPerTenant: parseInt(process.env.ITEMS_PER_TENANT ?? '1000000', 10),
  conversationsPerTenant: parseInt(process.env.CONVERSATIONS_PER_TENANT ?? '50000', 10),
  resultsDir: process.env.RESULTS_DIR ?? './results',
  seedBatchSize: parseInt(process.env.SEED_BATCH_SIZE ?? '500', 10),
  spanBatchSize: parseInt(process.env.SPAN_BATCH_SIZE ?? '100', 10),
  // How many tenants to seed concurrently. Keep below the db pool size (100).
  // 50 is safe; lower if the cluster shows write pressure during seeding.
  seedConcurrency: parseInt(process.env.SEED_CONCURRENCY ?? '50', 10),
  // Scale data per tenant down proportionally when running large tenant counts.
  // e.g. SPARSE_MULTIPLIER=0.2 gives 100k spans/tenant at 10k tenants.
  sparseMultiplier: parseFloat(process.env.SPARSE_MULTIPLIER ?? '1.0'),
};
