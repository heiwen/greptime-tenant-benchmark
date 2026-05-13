import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { config } from '../config.js';
import { sql } from '../db.js';
import type { Strategy } from '../types.js';

export const benchExplainEvery = parseNonNegativeInt(
  process.env.BENCH_EXPLAIN_EVERY ?? process.env.QCONV_EXPLAIN_EVERY ?? '0',
  'BENCH_EXPLAIN_EVERY',
);

const explainLog = process.env.BENCH_EXPLAIN_LOG
  ?? process.env.QCONV_EXPLAIN_LOG
  ?? `${config.resultsDir}/bench-explain.log`;
const explainCsv = process.env.BENCH_EXPLAIN_CSV
  ?? process.env.QCONV_EXPLAIN_CSV
  ?? explainLog.replace(/\.log$/, '.csv');

let explainOutputReady: Promise<void> | null = null;

export function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

export function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function shouldExplain(seq: number): boolean {
  return benchExplainEvery > 0 && seq % benchExplainEvery === 0;
}

function extractExplainText(rows: unknown[]): string {
  return rows
    .map((row) => Object.values(row as Record<string, unknown>).map(String).join('\n'))
    .join('\n');
}

function metric(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[1] ?? '';
}

function ensureExplainOutput(): Promise<void> {
  if (!explainOutputReady) {
    explainOutputReady = (async () => {
      await mkdir(dirname(explainLog), { recursive: true });
      await mkdir(dirname(explainCsv), { recursive: true });
      await appendFile(explainCsv, [
        'seq',
        'workload',
        'strategy',
        'tenant_id',
        'key',
        'latency_ms',
        'output_rows',
        'files',
        'file_ranges',
        'build_parts_cost',
        'scan_cost',
        'elapsed_await',
        'finish_time',
      ].join(',') + '\n');
    })();
  }
  return explainOutputReady;
}

export async function runExplainInBench(options: {
  seq: number;
  workload: string;
  strategy: Strategy;
  tenantId: string;
  key: string;
  query: string;
}): Promise<void> {
  await ensureExplainOutput();

  const started = Date.now();
  const text = extractExplainText(await sql.unsafe(`EXPLAIN ANALYZE VERBOSE\n${options.query}`));
  const latencyMs = Date.now() - started;
  const partition = text.match(/"partition_count":\{"count":(\d+), "mem_ranges":\d+, "files":(\d+), "file_ranges":(\d+)\}/);

  await appendFile(
    explainLog,
    `\n=== ${options.workload} strategy=${options.strategy} seq=${options.seq} latency_ms=${latencyMs} tenant_id=${options.tenantId} key=${options.key} ===\n${text}\n`,
  );
  await appendFile(explainCsv, [
    options.seq,
    options.workload,
    options.strategy,
    options.tenantId,
    options.key,
    latencyMs,
    metric(text, /MergeScanExec:[\s\S]*?metrics=\[output_rows: (\d+)/),
    partition?.[2] ?? '',
    partition?.[3] ?? '',
    metric(text, /build_parts_cost: ([^,\]]+)/),
    metric(text, /scan_cost: ([^,\]]+)/),
    metric(text, /elapsed_await: ([^,\]]+)/),
    metric(text, /finish_time: ([^,\]]+)/),
  ].join(',') + '\n');
}
