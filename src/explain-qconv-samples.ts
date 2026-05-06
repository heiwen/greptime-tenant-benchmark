import { config } from './config.js';
import { sql, tenantTable } from './db.js';
import { loadTenants } from './seed/tenants.js';
import { tenantConversationId } from './workloads/helpers.js';

type Strategy = 'a' | 'b';
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

const pool = parsePool(process.env.CONV_POOL ?? 'scattered');
const samples = parsePositiveInt(process.env.EXPLAIN_SAMPLES ?? '5', 'EXPLAIN_SAMPLES');
const tenantIndex = parsePositiveInt(process.env.TENANT_INDEX ?? '0', 'TENANT_INDEX', true);

function parsePool(value: string): Pool {
  if (value === 'clustered' || value === 'scattered') return value;
  throw new Error(`CONV_POOL must be "clustered" or "scattered", got ${value}`);
}

function parsePositiveInt(value: string, name: string, allowZero = false): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'non-negative' : 'positive'} integer, got ${value}`);
  }
  return parsed;
}

function conversationIndex(sample: number): number {
  const total = config.conversationsPerTenant;
  const half = Math.floor(total / 2);
  if (pool === 'clustered') return sample % half;
  return half + (sample % (total - half));
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

async function explainQConv(strategy: Strategy, tenantId: string, conversationId: string): Promise<ExplainStats> {
  const uuidRe = /^[0-9a-f-]{36}$/i;
  if (!uuidRe.test(tenantId) || !uuidRe.test(conversationId)) {
    throw new Error('Refusing to inline non-UUID values into SQL');
  }

  const query = strategy === 'b'
    ? `EXPLAIN ANALYZE
       SELECT "id", conversation_id, created_at, "type", "data"
       FROM conversation_items
       WHERE tenant_id = '${tenantId}'
         AND conversation_id = '${conversationId}'
       ORDER BY created_at ASC`
    : `EXPLAIN ANALYZE
       SELECT "id", conversation_id, created_at, "type", "data"
       FROM ${tenantTable('conversation_items', tenantId)}
       WHERE conversation_id = '${conversationId}'
       ORDER BY created_at ASC`;

  return parseStats(extractExplainText(await sql.unsafe(query)));
}

function printRow(values: (string | number | null)[]): void {
  console.log(values.map((value) => value === null ? '' : String(value)).join(','));
}

async function main(): Promise<void> {
  const tenants = await loadTenants();
  const tenantId = tenants[tenantIndex];
  if (!tenantId) throw new Error(`TENANT_INDEX ${tenantIndex} out of range; tenants=${tenants.length}`);

  console.error(`tenant_id=${tenantId}`);
  console.error(`pool=${pool} samples=${samples}`);

  printRow([
    'sample',
    'strategy',
    'conversation_id',
    'output_rows',
    'files',
    'file_ranges',
    'build_parts_cost',
    'scan_cost',
    'elapsed_await',
    'finish_time',
  ]);

  for (let i = 0; i < samples; i++) {
    const conversationId = tenantConversationId(tenantId, conversationIndex(i));
    for (const strategy of ['a', 'b'] as const) {
      const stats = await explainQConv(strategy, tenantId, conversationId);
      printRow([
        i,
        strategy,
        conversationId,
        stats.outputRows,
        stats.files,
        stats.fileRanges,
        stats.buildPartsCost,
        stats.scanCost,
        stats.elapsedAwait,
        stats.finishTime,
      ]);
    }
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
