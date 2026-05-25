export interface PrometheusSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function tokenizeMetricName(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const matches = raw.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g);
  for (const match of matches) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return labels;
}

function parsePrometheusSamples(text: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const sampleMatch = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+[^\s]+)?$/);
    if (!sampleMatch) continue;

    const value = Number.parseFloat(sampleMatch[3]);
    if (!Number.isFinite(value)) continue;

    samples.push({
      name: sampleMatch[1],
      labels: sampleMatch[2] ? parseLabels(sampleMatch[2]) : {},
      value,
    });
  }

  return samples;
}

function hasLabelValue(labels: Record<string, string>, expected: string): boolean {
  return Object.values(labels).some((value) => value.toLowerCase() === expected);
}

function hasAnyLabelValue(labels: Record<string, string>, expected: string[]): boolean {
  return expected.some((value) => hasLabelValue(labels, value));
}

const CACHE_TYPE_LABEL_KEYS = ['type', 'kind', 'cache_type', 'name'];
const CACHE_TYPE_NAME_TOKENS = [
  'index',
  'data',
  'page',
  'vector',
  'sst',
  'meta',
  'selector',
  'result',
  'bloom',
  'fulltext',
  'inverted',
  'puffin',
];

function extractCacheType(name: string, labels: Record<string, string>): string | null {
  for (const key of CACHE_TYPE_LABEL_KEYS) {
    const value = labels[key];
    if (value) return value.toLowerCase();
  }
  const tokens = tokenizeMetricName(name);
  const matched = CACHE_TYPE_NAME_TOKENS.filter((t) => tokens.has(t));
  if (matched.length === 0) return null;
  return matched.join('_');
}

export function parsePrometheusText(text: string): Record<string, number> {
  const result: Record<string, number> = {};

  for (const sample of parsePrometheusSamples(text)) {
    const lowerName = sample.name.toLowerCase();
    const tokens = tokenizeMetricName(lowerName);

    const add = (outputKey: string): void => {
      result[outputKey] = (result[outputKey] ?? 0) + sample.value;
    };

    const isLegacyMetric = (name: string): boolean => lowerName === name;

    if (
      isLegacyMetric('greptime_mito_memtable_usage_bytes') ||
      (tokens.has('memtable') && tokens.has('bytes'))
    ) {
      add('greptime_mito_memtable_usage_bytes');
    }

    if (
      isLegacyMetric('greptime_mito_open_files_total') ||
      (tokens.has('open') && (tokens.has('file') || tokens.has('files')))
    ) {
      add('greptime_mito_open_files_total');
    }

    const isCacheBytesMetric =
      isLegacyMetric('greptime_mito_cache_bytes') ||
      (tokens.has('cache') && tokens.has('bytes'));

    if (isCacheBytesMetric) {
      const cacheType = extractCacheType(lowerName, sample.labels) ?? 'unknown';
      add(`greptime_mito_cache_bytes{type="${cacheType}"}`);
    }

    const isCacheHitMetric =
      isLegacyMetric('greptime_mito_cache_hit_total') ||
      (tokens.has('cache') && tokens.has('hit')) ||
      (tokens.has('cache') && hasAnyLabelValue(sample.labels, ['hit', 'hits']));

    if (isCacheHitMetric) {
      add('greptime_mito_cache_hit_total');
      const cacheType = extractCacheType(lowerName, sample.labels);
      if (cacheType) add(`greptime_mito_cache_hit_total{type="${cacheType}"}`);
    }

    const isCacheMissMetric =
      isLegacyMetric('greptime_mito_cache_miss_total') ||
      (tokens.has('cache') && tokens.has('miss')) ||
      (tokens.has('cache') && hasAnyLabelValue(sample.labels, ['miss', 'misses']));

    if (isCacheMissMetric) {
      add('greptime_mito_cache_miss_total');
      const cacheType = extractCacheType(lowerName, sample.labels);
      if (cacheType) add(`greptime_mito_cache_miss_total{type="${cacheType}"}`);
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
