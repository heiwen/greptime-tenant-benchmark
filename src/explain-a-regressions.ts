import { config } from './config.js';
import { sql, tenantTable } from './db.js';
import { loadTenants } from './seed/tenants.js';
import { tenantConversationId } from './workloads/helpers.js';

// Probes the three A workloads that regressed between run7 and run8 despite
// unchanged schema: Q-conv (clustered + scattered), Q-id S2, and M1-style
// Q-time S1 on a single tenant. Emits CSV on stdout and the full
// EXPLAIN ANALYZE VERBOSE plan text on stderr for each probe.

type Strategy = 'a' | 'b';
type Workload = 'q-conv-clustered' | 'q-conv-scattered' | 'q-id-s2' | 'm1-qtime-s1-24h';

interface ExplainStats {
  files: number | null;
  fileRanges: number | null;
  buildPartsCost: string | null;
  scanCost: string | null;
  elapsedAwait: string | null;
  finishTime: string | null;
  outputRows: number | null;
}

const samples = parsePositiveInt(process.env.EXPLAIN_SAMPLES ?? '5', 'EXPLAIN_SAMPLES');
const tenantIndex = parsePositiveInt(process.env.TENANT_INDEX ?? '0', 'TENANT_INDEX', true);

function parsePositiveInt(value: string, name: string, allowZero = false): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'non-negative' : 'positive'} integer, got ${value}`);
  }
  return parsed;
}

function conversationIndex(pool: 'clustered' | 'scattered', sample: number): number {
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

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`Refusing to inline non-UUID ${field} into SQL: ${value}`);
  }
}

async function runExplain(label: string, query: string): Promise<ExplainStats> {
  const text = extractExplainText(await sql.unsafe(query));
  console.error(`\n=== verbose plan: ${label} ===`);
  console.error(text);
  return parseStats(text);
}

function qConvQuery(strategy: Strategy, tenantId: string, conversationId: string, explain: string): string {
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

function qIdS2Query(strategy: Strategy, tenantId: string, conversationId: string, explain: string): string {
  if (strategy === 'b') {
    return `${explain}
      SELECT "id", conversation_id, created_at, "type"
      FROM conversation_items
      WHERE tenant_id = '${tenantId}'
        AND conversation_id = '${conversationId}'
      ORDER BY created_at DESC, "id" DESC
      LIMIT 50`;
  }
  return `${explain}
    SELECT "id", conversation_id, created_at, "type"
    FROM ${tenantTable('conversation_items', tenantId)}
    WHERE conversation_id = '${conversationId}'
    ORDER BY created_at DESC, "id" DESC
    LIMIT 50`;
}

function m1Query(strategy: Strategy, tenantId: string, cutoff: string, explain: string): string {
  if (strategy === 'b') {
    return `${explain}
      SELECT trace_id, span_id, "timestamp", duration_nano,
             gen_ai_system, gen_ai_request_model,
             gen_ai_input_tokens, gen_ai_output_tokens
      FROM spans
      WHERE tenant_id = '${tenantId}'
        AND "timestamp" > '${cutoff}'
      ORDER BY "timestamp" DESC
      LIMIT 50`;
  }
  return `${explain}
    SELECT trace_id, span_id, "timestamp", duration_nano,
           gen_ai_system, gen_ai_request_model,
           gen_ai_input_tokens, gen_ai_output_tokens
    FROM ${tenantTable('spans', tenantId)}
    WHERE "timestamp" > '${cutoff}'
    ORDER BY "timestamp" DESC
    LIMIT 50`;
}

function printRow(values: (string | number | null)[]): void {
  console.log(values.map((value) => value === null ? '' : String(value)).join(','));
}

async function main(): Promise<void> {
  const tenants = await loadTenants();
  const tenantId = tenants[tenantIndex];
  if (!tenantId) throw new Error(`TENANT_INDEX ${tenantIndex} out of range; tenants=${tenants.length}`);
  assertUuid(tenantId, 'tenant_id');

  console.error(`tenant_id=${tenantId}`);
  console.error(`samples=${samples}`);

  const explain = 'EXPLAIN ANALYZE VERBOSE';

  printRow([
    'workload',
    'sample',
    'strategy',
    'key',
    'output_rows',
    'files',
    'file_ranges',
    'build_parts_cost',
    'scan_cost',
    'elapsed_await',
    'finish_time',
  ]);

  async function runConvWorkload(workload: Workload, pool: 'clustered' | 'scattered', queryFn: typeof qConvQuery): Promise<void> {
    for (let i = 0; i < samples; i++) {
      const conversationId = tenantConversationId(tenantId, conversationIndex(pool, i));
      assertUuid(conversationId, 'conversation_id');
      for (const strategy of ['a', 'b'] as const) {
        const label = `${workload} strategy=${strategy} sample=${i}`;
        const stats = await runExplain(label, queryFn(strategy, tenantId, conversationId, explain));
        printRow([
          workload,
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
  }

  await runConvWorkload('q-conv-clustered', 'clustered', qConvQuery);
  await runConvWorkload('q-conv-scattered', 'scattered', qConvQuery);
  // Q-id S2 uses the same conversation_id equality path — reuse the scattered pool
  // (matches the run7 explain methodology).
  await runConvWorkload('q-id-s2', 'scattered', qIdS2Query);

  // M1: single tenant, S1 Q-time 24h. Anchor the cutoff to MAX(timestamp) for
  // this tenant so the probe hits real data even if the dataset was seeded long
  // before the explain run. Using wall-clock - 24h would silently match zero
  // rows on a stale seed.
  const maxRow = await sql.unsafe(`
    SELECT MAX("timestamp") AS max_ts
    FROM ${tenantTable('spans', tenantId)}
  `);
  const maxTs = (maxRow[0] as { max_ts: string | Date | null }).max_ts;
  if (maxTs === null) throw new Error(`tenant ${tenantId} has no spans`);
  const maxDate = maxTs instanceof Date ? maxTs : new Date(maxTs);
  const cutoff = new Date(maxDate.getTime() - 24 * 3600 * 1000).toISOString();
  console.error(`m1 cutoff=${cutoff} (max_ts=${maxDate.toISOString()})`);
  for (let i = 0; i < samples; i++) {
    for (const strategy of ['a', 'b'] as const) {
      const label = `m1-qtime-s1-24h strategy=${strategy} sample=${i}`;
      const stats = await runExplain(label, m1Query(strategy, tenantId, cutoff, explain));
      printRow([
        'm1-qtime-s1-24h',
        i,
        strategy,
        cutoff,
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
