import { MetricsCollector } from './metrics.js';
import type { WorkloadFn, Strategy } from '../types.js';

export async function runWorkload(options: {
  workloadFn: WorkloadFn;
  tenants: string[];
  strategy: Strategy;
  concurrency: number;
  durationSecs: number;
}): Promise<MetricsCollector> {
  const { workloadFn, tenants, strategy, concurrency, durationSecs } = options;
  const metrics = new MetricsCollector();
  const endTime = Date.now() + durationSecs * 1000;

  async function worker(): Promise<void> {
    while (Date.now() < endTime) {
      const tenantId = tenants[Math.floor(Math.random() * tenants.length)];
      const start = Date.now();

      try {
        const result = await workloadFn({ tenantId, strategy });
        const latency = Date.now() - start;
        metrics.record(latency, result.bytes);
      } catch (err) {
        metrics.recordError();
        // Log errors but keep running
        console.error(`Worker error for tenant ${tenantId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Spawn concurrency workers and wait for all to finish
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return metrics;
}
