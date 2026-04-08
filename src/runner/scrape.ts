export interface PrometheusSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

// Scalar metrics: sum across all datanodes.
const SCALAR_METRICS = [
  'greptime_mito_memtable_usage_bytes',
  'greptime_mito_open_files_total',
];

// Label-filtered metrics: track each label variant as a separate key.
// Format: [metricName, labelKey, labelValue, outputKey]
type LabeledMetric = [string, string, string, string];
const LABELED_METRICS: LabeledMetric[] = [
  ['greptime_mito_cache_bytes', 'type', 'index', 'greptime_mito_cache_bytes{type="index"}'],
  ['greptime_mito_cache_bytes', 'type', 'data',  'greptime_mito_cache_bytes{type="data"}'],
  ['greptime_mito_cache_hit_total',  'type', '', 'greptime_mito_cache_hit_total'],
  ['greptime_mito_cache_miss_total', 'type', '', 'greptime_mito_cache_miss_total'],
];

function parsePrometheusText(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  const lines = text.split('\n');

  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;

    // Scalar metrics: match by prefix, sum all label variants
    for (const metricName of SCALAR_METRICS) {
      if (line.startsWith(metricName + ' ') || line.startsWith(metricName + '{')) {
        const spaceIdx = line.lastIndexOf(' ');
        const value = parseFloat(line.slice(spaceIdx + 1));
        if (!isNaN(value)) {
          result[metricName] = (result[metricName] ?? 0) + value;
        }
      }
    }

    // Labeled metrics: extract specific label values
    for (const [metricName, labelKey, labelValue, outputKey] of LABELED_METRICS) {
      if (!line.startsWith(metricName)) continue;

      // If no specific label value required, sum all variants
      if (labelValue === '') {
        if (line.startsWith(metricName + ' ') || line.startsWith(metricName + '{')) {
          const spaceIdx = line.lastIndexOf(' ');
          const value = parseFloat(line.slice(spaceIdx + 1));
          if (!isNaN(value)) {
            result[outputKey] = (result[outputKey] ?? 0) + value;
          }
        }
        continue;
      }

      // Match specific label: metricName{...labelKey="labelValue"...}
      const labelPattern = `${labelKey}="${labelValue}"`;
      if (line.includes(labelPattern)) {
        const spaceIdx = line.lastIndexOf(' ');
        const value = parseFloat(line.slice(spaceIdx + 1));
        if (!isNaN(value)) {
          result[outputKey] = (result[outputKey] ?? 0) + value;
        }
      }
    }
  }

  return result;
}

function mergeMetrics(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const merged = { ...a };
  for (const [key, val] of Object.entries(b)) {
    merged[key] = (merged[key] ?? 0) + val;
  }
  return merged;
}

export function startScraping(
  prometheusUrls: string[],
  intervalMs: number,
): { stop: () => void; getSnapshots: () => PrometheusSnapshot[] } {
  const snapshots: PrometheusSnapshot[] = [];
  let running = true;
  let consecutiveFailures = 0;

  async function scrapeOne(url: string): Promise<Record<string, number>> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${url}: ${msg}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${url}: HTTP ${response.status}${body ? ` — ${body.slice(0, 120)}` : ''}`);
    }
    const text = await response.text();
    const metrics = parsePrometheusText(text);
    if (Object.keys(metrics).length === 0) {
      // Help the user diagnose wrong metric names: show the first metric line found
      const firstMetric = text.split('\n').find((l) => !l.startsWith('#') && l.trim() !== '');
      if (firstMetric) {
        console.warn(`Prometheus scrape ${url}: response has metrics but none matched expected names. First line: "${firstMetric.slice(0, 120)}"`);
      } else {
        console.warn(`Prometheus scrape ${url}: response body is empty`);
      }
    }
    return metrics;
  }

  async function scrapeLoop(): Promise<void> {
    while (running) {
      const start = Date.now();

      try {
        const results = await Promise.allSettled(prometheusUrls.map(scrapeOne));
        const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        const values = results
          .filter((r): r is PromiseFulfilledResult<Record<string, number>> => r.status === 'fulfilled')
          .map((r) => r.value);

        for (const e of errors) {
          console.warn(`Prometheus scrape failed: ${e.reason instanceof Error ? e.reason.message : e.reason}`);
        }

        if (values.length > 0) {
          const merged = values.reduce(mergeMetrics, {});
          if (Object.keys(merged).length > 0) {
            consecutiveFailures = 0;
            snapshots.push({ timestamp: Date.now(), metrics: merged });
          } else {
            consecutiveFailures++;
            if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
              console.warn(`Prometheus scrape: no recognized metrics from any URL (failure #${consecutiveFailures}). Check GREPTIMEDB_PROMETHEUS_URLS.`);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Prometheus scrape loop error: ${msg}`);
      }

      const elapsed = Date.now() - start;
      const sleepMs = Math.max(0, intervalMs - elapsed);
      if (sleepMs > 0 && running) {
        await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      }
    }
  }

  scrapeLoop();

  return {
    stop: () => { running = false; },
    getSnapshots: () => snapshots,
  };
}

// Pre-flight check: verify at least one URL returns recognized metrics.
// Returns a summary string on success, throws on total failure.
export async function checkScrapeUrls(urls: string[]): Promise<string> {
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${body ? ` — ${body.slice(0, 80)}` : ''}`);
      }
      const text = await response.text();
      const metrics = parsePrometheusText(text);
      const count = Object.keys(metrics).length;
      if (count === 0) {
        const firstMetric = text.split('\n').find((l) => !l.startsWith('#') && l.trim() !== '');
        throw new Error(
          `no recognized metrics found. First metric line: "${firstMetric?.slice(0, 120) ?? '(empty response)'}"`,
        );
      }
      return { url, count };
    }),
  );

  const successes = results.filter((r): r is PromiseFulfilledResult<{ url: string; count: number }> => r.status === 'fulfilled');
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  for (const f of failures) {
    console.warn(`  Prometheus pre-flight FAIL: ${f.reason instanceof Error ? f.reason.message : f.reason}`);
  }

  if (successes.length === 0) {
    throw new Error(
      `Prometheus scraping will not work — all ${urls.length} URL(s) failed. ` +
      `Set GREPTIMEDB_PROMETHEUS_URLS to the datanode /metrics endpoints. ` +
      `Run with --skip-scrape to suppress this check.`,
    );
  }

  const summary = successes.map((s) => `${s.value.url} (${s.value.count} metrics)`).join(', ');
  return summary;
}

export async function writeScrapeResults(
  snapshots: PrometheusSnapshot[],
  path: string,
): Promise<void> {
  await Bun.write(path, JSON.stringify(snapshots, null, 2));
}
