import { afterEach, describe, expect, test } from 'bun:test';
import { checkScrapeUrls, parsePrometheusText } from '../src/runner/scrape.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Prometheus metric parsing', () => {
  test('parses legacy greptime_mito metrics', () => {
    const metrics = parsePrometheusText(`
# HELP greptime_mito_memtable_usage_bytes Current memtable usage
greptime_mito_memtable_usage_bytes 123
greptime_mito_cache_bytes{type="index"} 11
greptime_mito_cache_bytes{type="data"} 22
greptime_mito_cache_hit_total{type="index"} 33
greptime_mito_cache_miss_total{type="index"} 44
greptime_mito_open_files_total 55
`);

    expect(metrics).toEqual({
      'greptime_mito_memtable_usage_bytes': 123,
      'greptime_mito_cache_bytes{type="index"}': 11,
      'greptime_mito_cache_bytes{type="data"}': 22,
      'greptime_mito_cache_hit_total': 33,
      'greptime_mito_cache_miss_total': 44,
      'greptime_mito_open_files_total': 55,
    });
  });

  test('parses renamed storage metrics into the existing output keys', () => {
    const metrics = parsePrometheusText(`
greptime_app_version{app="greptime-datanode",short_version="f3dbf34",version="1.0.0"} 1
greptime_storage_memtable_usage_bytes 100
greptime_storage_cache_bytes{kind="index"} 10
greptime_storage_cache_bytes{kind="data"} 20
greptime_storage_cache_requests_total{result="hit"} 30
greptime_storage_cache_requests_total{result="miss"} 40
greptime_storage_open_files 50
`);

    expect(metrics).toEqual({
      'greptime_mito_memtable_usage_bytes': 100,
      'greptime_mito_cache_bytes{type="index"}': 10,
      'greptime_mito_cache_bytes{type="data"}': 20,
      'greptime_mito_cache_hit_total': 30,
      'greptime_mito_cache_miss_total': 40,
      'greptime_mito_open_files_total': 50,
    });
  });

  test('parses cache metrics when index/data are encoded in the metric name', () => {
    const metrics = parsePrometheusText(`
greptime_storage_index_cache_bytes 12
greptime_storage_data_cache_bytes 34
greptime_storage_open_file_count 56
`);

    expect(metrics).toEqual({
      'greptime_mito_cache_bytes{type="index"}': 12,
      'greptime_mito_cache_bytes{type="data"}': 34,
      'greptime_mito_open_files_total': 56,
    });
  });
});

describe('Prometheus pre-flight check', () => {
  test('accepts endpoints with renamed storage metrics', async () => {
    globalThis.fetch = async () =>
      new Response(`
greptime_app_version{app="greptime-datanode",short_version="f3dbf34",version="1.0.0"} 1
greptime_storage_memtable_usage_bytes 100
greptime_storage_cache_requests_total{result="hit"} 30
greptime_storage_cache_requests_total{result="miss"} 40
greptime_storage_open_files 50
`, { status: 200 });

    const summary = await checkScrapeUrls(['http://localhost:15000/metrics']);
    expect(summary).toContain('http://localhost:15000/metrics');
  });

  test('rejects endpoints that expose only non-storage metrics', async () => {
    globalThis.fetch = async () =>
      new Response(
        'greptime_app_version{app="greptime-datanode",short_version="f3dbf34",version="1.0.0"} 1\n',
        { status: 200 },
      );

    await expect(checkScrapeUrls(['http://localhost:15000/metrics'])).rejects.toThrow(
      'Prometheus scraping will not work',
    );
  });
});
