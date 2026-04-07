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

  async function scrapeOne(url: string): Promise<Record<string, number>> {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      console.warn(`Prometheus scrape ${url} returned HTTP ${response.status}`);
      return {};
    }
    return parsePrometheusText(await response.text());
  }

  async function scrapeLoop(): Promise<void> {
    while (running) {
      const start = Date.now();

      try {
        const results = await Promise.all(prometheusUrls.map(scrapeOne));
        const merged = results.reduce(mergeMetrics, {});
        snapshots.push({ timestamp: Date.now(), metrics: merged });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Prometheus scrape failed: ${msg}`);
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

export async function writeScrapeResults(
  snapshots: PrometheusSnapshot[],
  path: string,
): Promise<void> {
  await Bun.write(path, JSON.stringify(snapshots, null, 2));
}
