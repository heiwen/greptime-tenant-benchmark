export const config = {
  dbUrl: process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public',
  prometheusUrl: process.env.GREPTIMEDB_PROMETHEUS_URL ?? 'http://localhost:4000/metrics',
  tenantCount: parseInt(process.env.TENANT_COUNT ?? '100', 10),
  spansPerTenant: parseInt(process.env.SPANS_PER_TENANT ?? '500000', 10),
  itemsPerTenant: parseInt(process.env.ITEMS_PER_TENANT ?? '1000000', 10),
  conversationsPerTenant: parseInt(process.env.CONVERSATIONS_PER_TENANT ?? '50000', 10),
  resultsDir: process.env.RESULTS_DIR ?? './results',
  seedBatchSize: parseInt(process.env.SEED_BATCH_SIZE ?? '500', 10),
  spanBatchSize: parseInt(process.env.SPAN_BATCH_SIZE ?? '100', 10),
};
