import { config } from './config.js';
import { sql, tenantTable } from './db.js';
import { loadTenants } from './seed/tenants.js';
import { pickConversationIndex, tenantConversationId } from './workloads/helpers.js';
import type { Strategy } from './types.js';

type Pool = 'clustered' | 'scattered';

interface ExplainStats {
  files: number | null;
  fileRanges: number | null;
  buildPartsCost: string | null;
  scanCost: string | null;
  elapsedAwait: string | null;
  finishTime: string | null;
  outputRows: number | null;
}

const strategy = parseStrategy(process.env.STRATEGY ?? 'b');
const pools = parsePools(process.env.POOL ?? 'clustered,scattered');
const concurrency = parsePositiveInt(process.env.CONCURRENCY ?? '10', 'CONCURRENCY');
const samples = parsePositiveInt(process.env.EXPLAIN_SAMPLES ?? '5', 'EXPLAIN_SAMPLES');
const tenantDiversity = parsePositiveInt(process.env.TENANT_DIVERSITY ?? '10', 'TENANT_DIVERSITY');
const pressureWarmupMs = parsePositiveInt(process.env.PRESSURE_WARMUP_MS ?? '5000', 'PRESSURE_WARMUP_MS', true);

let stopPressure = false;

function parsePositiveInt(value: string, name: string, allowZero = false): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'non-negative' : 'positive'} integer, got ${value}`);
  }
  return parsed;
}

function parseStrategy(value: string): Strategy {
  if (value !== 'a' && value !== 'b') {
    throw new Error(`STRATEGY must be a or b, got ${value}`);
  }
  return value;
}

function parsePools(value: string): Pool[] {
  const parsed = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parsed.length === 0 || parsed.some((part) => part !== 'clustered' && part !== 'scattered')) {
    throw new Error(`POOL must be clustered, scattered, or clustered,scattered; got ${value}`);
  }
  return parsed as Pool[];
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`Refusing to inline non-UUID ${field} into SQL: ${value}`);
  }
}

function extractExplainText(rows: unknown[]): string {
  return rows
    .map((row) => Object.values(row as Record<string, unknown>).map(String).join('\n'))
    .join('\n');
}

function parseStats(text: string): ExplainStats {
  const partition = text.match(/"partition_count":\{"count":(\d+), "mem_ranges":\d+, "files":(\d+), "file_ranges":(\d+)\}/);
  const buildPartsCost = text.match(/build_parts_cost: ([^,\]]+)/);
  const scanCost = text.match(/scan_cost: ([^,\]]+)/);
  const elapsedAwait = text.match(/elapsed_await: ([^,\]]+)/);
  const finishTime = text.match(/finish_time: ([^,\]]+)/);
  const outputRows = text.match(/MergeScanExec:[\s\S]*?metrics=\[output_rows: (\d+)/);

  return {
    files: partition ? Number(partition[2]) : null,
    fileRanges: partition ? Number(partition[3]) : null,
    buildPartsCost: buildPartsCost?.[1] ?? null,
    scanCost: scanCost?.[1] ?? null,
    elapsedAwait: elapsedAwait?.[1] ?? null,
    finishTime: finishTime?.[1] ?? null,
    outputRows: outputRows ? Number(outputRows[1]) : null,
  };
}

function qConvQuery(strategy: Strategy, tenantId: string, conversationId: string, explain = ''): string {
  if (strategy === 'b') {
    return `${explain}
      SELECT "id", conversation_id, created_at, "type", "data"
      FROM conversation_items
      WHERE tenant_id = '${tenantId}'
        AND conversation_id = '${conversationId}'
      ORDER BY created_at ASC`;
  }
  return `${explain}
    SELECT "id", conversation_id, created_at, "type", "data"
    FROM ${tenantTable('conversation_items', tenantId)}
    WHERE conversation_id = '${conversationId}'
    ORDER BY created_at ASC`;
}

function pick<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function pickConversationId(tenantId: string, pool: Pool): string {
  const index = pickConversationIndex(pool, config.conversationsPerTenant);
  return tenantConversationId(tenantId, index);
}

async function pressureWorker(id: number, tenants: string[], pool: Pool): Promise<void> {
  let count = 0;
  while (!stopPressure) {
    const tenantId = pick(tenants);
    const conversationId = pickConversationId(tenantId, pool);
    try {
      await sql.unsafe(qConvQuery(strategy, tenantId, conversationId));
      count++;
    } catch (err) {
      console.error(`pressure worker ${id} error: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.error(`pressure worker ${id} completed ${count} queries`);
}

function printRow(values: (string | number | null)[]): void {
  console.log(values.map((value) => value === null ? '' : String(value)).join(','));
}

async function runPool(pool: Pool, tenants: string[]): Promise<void> {
  stopPressure = false;
  const pressureConcurrency = Math.max(0, concurrency - 1);
  const pressureWorkers = Array.from(
    { length: pressureConcurrency },
    (_, i) => pressureWorker(i, tenants, pool),
  );

  if (pressureWarmupMs > 0) {
    await Bun.sleep(pressureWarmupMs);
  }

  for (let sample = 0; sample < samples; sample++) {
    const tenantId = pick(tenants);
    const conversationId = pickConversationId(tenantId, pool);
    assertUuid(tenantId, 'tenant_id');
    assertUuid(conversationId, 'conversation_id');

    const label = `q-conv-${pool} strategy=${strategy} sample=${sample} concurrency=${concurrency}`;
    const start = Date.now();
    const text = extractExplainText(await sql.unsafe(qConvQuery(strategy, tenantId, conversationId, 'EXPLAIN ANALYZE VERBOSE')));
    const latencyMs = Date.now() - start;
    const stats = parseStats(text);

    console.error(`\n=== verbose plan: ${label} ===`);
    console.error(text);
    printRow([
      `q-conv-${pool}`,
      sample,
      strategy,
      concurrency,
      tenantId,
      conversationId,
      latencyMs,
      stats.outputRows,
      stats.files,
      stats.fileRanges,
      stats.buildPartsCost,
      stats.scanCost,
      stats.elapsedAwait,
      stats.finishTime,
    ]);
  }

  stopPressure = true;
  await Promise.all(pressureWorkers);
}

async function main(): Promise<void> {
  const tenants = (await loadTenants()).slice(0, tenantDiversity);
  if (tenants.length === 0) throw new Error('No tenants loaded');
  if (concurrency < 1) throw new Error('CONCURRENCY must be at least 1');

  console.error(`strategy=${strategy}`);
  console.error(`pools=${pools.join(',')}`);
  console.error(`concurrency=${concurrency} (pressure workers=${Math.max(0, concurrency - 1)}, explain workers=1)`);
  console.error(`tenant_diversity=${tenants.length}`);
  console.error(`samples=${samples}`);

  printRow([
    'workload',
    'sample',
    'strategy',
    'concurrency',
    'tenant_id',
    'conversation_id',
    'latency_ms',
    'output_rows',
    'files',
    'file_ranges',
    'build_parts_cost',
    'scan_cost',
    'elapsed_await',
    'finish_time',
  ]);

  for (const pool of pools) {
    await runPool(pool, tenants);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
