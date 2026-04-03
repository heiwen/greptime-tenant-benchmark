export interface PrometheusSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

const TRACKED_METRICS = [
  'greptime_mito_memtable_usage_bytes',
  'greptime_mito_cache_hit_total',
  'greptime_mito_cache_miss_total',
  'greptime_mito_open_files_total',
];

function parsePrometheusText(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  const lines = text.split('\n');

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') continue;

    for (const metricName of TRACKED_METRICS) {
      // Match lines starting with the metric name (possibly with labels)
      if (line.startsWith(metricName)) {
        // Parse: metric_name{labels} value [timestamp]
        // or: metric_name value [timestamp]
        const spaceIdx = line.lastIndexOf(' ');
        const valueStr = line.slice(spaceIdx + 1);
        const value = parseFloat(valueStr);

        if (!isNaN(value)) {
          // Sum up all label variants for the same base metric name
          result[metricName] = (result[metricName] ?? 0) + value;
        }
      }
    }
  }

  return result;
}

export function startScraping(
  prometheusUrl: string,
  intervalMs: number,
): { stop: () => void; getSnapshots: () => PrometheusSnapshot[] } {
  const snapshots: PrometheusSnapshot[] = [];
  let running = true;

  async function scrapeLoop(): Promise<void> {
    while (running) {
      const start = Date.now();

      try {
        const response = await fetch(prometheusUrl, {
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const text = await response.text();
          const metrics = parsePrometheusText(text);
          snapshots.push({ timestamp: Date.now(), metrics });
        } else {
          console.warn(`Prometheus scrape returned HTTP ${response.status}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Prometheus scrape failed (${prometheusUrl}): ${msg}`);
      }

      // Sleep until next interval
      const elapsed = Date.now() - start;
      const sleepMs = Math.max(0, intervalMs - elapsed);
      if (sleepMs > 0 && running) {
        await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      }
    }
  }

  // Start in background (don't await)
  scrapeLoop();

  return {
    stop: () => { running = false; },
    getSnapshots: () => snapshots,
  };
}

export async function writeScrapeResults(
  snapshots: PrometheusSnapshot[],
  path: string,
): Promise<void> {
  await Bun.write(path, JSON.stringify(snapshots, null, 2));
}
