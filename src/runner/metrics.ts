import type { RunResult, Strategy, Scenario } from '../types.js';

export class MetricsCollector {
  private latencies: number[] = [];
  private totalBytes: number = 0;
  private errorCount: number = 0;

  record(latencyMs: number, bytes?: number): void {
    this.latencies.push(latencyMs);
    if (bytes !== undefined) {
      this.totalBytes += bytes;
    }
  }

  recordError(): void {
    this.errorCount++;
  }

  summary(
    workload: string,
    strategy: Strategy,
    scenario: Scenario,
    concurrency: number,
    durationSecs: number,
  ): RunResult {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const count = sorted.length;

    function percentile(p: number): number {
      if (count === 0) return 0;
      const idx = Math.ceil((p / 100) * count) - 1;
      return sorted[Math.max(0, Math.min(idx, count - 1))];
    }

    return {
      workload,
      strategy,
      scenario,
      concurrency,
      durationSecs,
      count,
      errors: this.errorCount,
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
      throughputQps: durationSecs > 0 ? count / durationSecs : 0,
      throughputMbps: durationSecs > 0 ? this.totalBytes / (durationSecs * 1e6) : 0,
    };
  }
}

export async function writeCsv(results: RunResult[], path: string): Promise<void> {
  if (results.length === 0) return;

  const headers = Object.keys(results[0]) as (keyof RunResult)[];
  const lines: string[] = [headers.join(',')];

  for (const row of results) {
    const values = headers.map((h) => {
      const v = row[h];
      // Quote strings that might contain commas
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      return String(v);
    });
    lines.push(values.join(','));
  }

  await Bun.write(path, lines.join('\n') + '\n');
}
