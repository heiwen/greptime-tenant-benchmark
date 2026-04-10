import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import { formatDuration } from './progress.js';
import { randomText, randomJson } from './text.js';
import type { Strategy, SpanTier } from '../types.js';

export const TIER_CONFIG: Record<SpanTier, {
  share: number;
  inputBytes: number;
  outputBytes: number;
  totalRowBytes: number;
}> = {
  tiny:   { share: 0.10, inputBytes:    400, outputBytes:   150, totalRowBytes:    2_000 },
  small:  { share: 0.40, inputBytes:   3000, outputBytes:   500, totalRowBytes:    5_000 },
  medium: { share: 0.35, inputBytes:  15000, outputBytes:  2000, totalRowBytes:   20_000 },
  large:  { share: 0.12, inputBytes:  80000, outputBytes:  5000, totalRowBytes:   90_000 },
  xlarge: { share: 0.03, inputBytes: 400000, outputBytes: 20000, totalRowBytes:  430_000 },
};

const TIER_NAMES = Object.keys(TIER_CONFIG) as SpanTier[];

export function pickTier(): SpanTier {
  const r = Math.random();
  let cumulative = 0;
  for (const tier of TIER_NAMES) {
    cumulative += TIER_CONFIG[tier].share;
    if (r < cumulative) return tier;
  }
  return 'small';
}

function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

const GEN_AI_SYSTEMS = ['openai', 'anthropic', 'google', 'cohere', 'mistral'];
const GEN_AI_MODELS: Record<string, string[]> = {
  openai:    ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: ['claude-3-5-sonnet', 'claude-3-opus', 'claude-3-haiku'],
  google:    ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'],
  cohere:    ['command-r-plus', 'command-r'],
  mistral:   ['mistral-large', 'mistral-medium', 'mistral-small'],
};
const FINISH_REASONS = ['stop', 'length', 'tool_calls', 'content_filter'];

export function generateSpanRow(tenantId: string | null, timestampMs: number): Record<string, unknown> {
  const tier = pickTier();
  const tierCfg = TIER_CONFIG[tier];

  const system = GEN_AI_SYSTEMS[Math.floor(Math.random() * GEN_AI_SYSTEMS.length)];
  const models = GEN_AI_MODELS[system];
  const model = models[Math.floor(Math.random() * models.length)];

  const inputTokens = Math.floor(tierCfg.inputBytes / 4); // rough token estimate
  const outputTokens = Math.floor(tierCfg.outputBytes / 4);
  const durationNano = Math.floor(100_000_000 + Math.random() * 29_900_000_000); // 100ms–30s as plain number

  const inputMessages = JSON.stringify([
    { role: 'system', content: randomText(Math.floor(tierCfg.inputBytes * 0.3)) },
    { role: 'user', content: randomText(Math.floor(tierCfg.inputBytes * 0.7)) },
  ]);

  const outputMessages = JSON.stringify([
    { role: 'assistant', content: randomText(tierCfg.outputBytes) },
  ]);

  const timestampEndMs = timestampMs + Math.floor(durationNano / 1_000_000);

  const row: Record<string, unknown> = {
    timestamp: new Date(timestampMs).toISOString(),
    timestamp_end: new Date(timestampEndMs).toISOString(),
    duration_nano: durationNano,
    trace_id: randomHex(32),
    span_id: randomHex(16),
    parent_span_id: Math.random() > 0.3 ? randomHex(16) : null,
    span_name: `${system}.${model}.chat`,
    span_kind: 'CLIENT',
    span_status_code: Math.random() > 0.05 ? 'OK' : 'ERROR',
    span_status_message: Math.random() > 0.05 ? null : 'Request failed',
    trace_state: null,
    service_name: `ai-service-${system}`,
    scope_name: `@opentelemetry/instrumentation-${system}`,
    scope_version: '1.0.0',
    gen_ai_operation: 'chat',
    gen_ai_system: system,
    gen_ai_request_model: model,
    gen_ai_response_model: model,
    gen_ai_input_tokens: inputTokens,
    gen_ai_output_tokens: outputTokens,
    gen_ai_total_tokens: inputTokens + outputTokens,
    gen_ai_finish_reasons: FINISH_REASONS[Math.floor(Math.random() * FINISH_REASONS.length)],
    gen_ai_input_messages: inputMessages,
    gen_ai_output_messages: outputMessages,
    span_attributes: randomJson(200),
    span_events: '[]',
    span_links: '[]',
  };

  if (tenantId !== null) {
    row.tenant_id = tenantId;
  }

  return row;
}

function randomTimestampInRange(startMs: number, endMs: number): number {
  return startMs + Math.random() * (endMs - startMs);
}

async function retryInsert(fn: () => Promise<void>, retries = 10, delayMs = 15_000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  [retry] Connection error, waiting ${delayMs / 1000}s for frontend to restart... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function countSpans(strategy: Strategy, tableName: string, tenantId: string): Promise<number> {
  const result = strategy === 'b'
    ? await sql`SELECT COUNT(*) as c FROM spans WHERE tenant_id = ${tenantId}`
    : await sql`SELECT COUNT(*) as c FROM ${sql(tableName)}`;
  return Number(result[0].c);
}

async function seedSpansForTenant(
  strategy: Strategy,
  tenantId: string,
  totalPerTenant: number,
  timeRanges: { historicalStart: number; historicalEnd: number; recentStart: number; recentEnd: number; freshStart: number; freshEnd: number },
  onBatch?: (n: number) => void,
): Promise<void> {
  const tableName = strategy === 'a' ? tenantTable('spans', tenantId) : 'spans';
  const batchSize = config.spanBatchSize;

  const existing = await countSpans(strategy, tableName, tenantId);
  if (existing >= totalPerTenant) {
    return;
  }

  const toInsert = totalPerTenant - existing;
  const { historicalStart, historicalEnd, recentStart, recentEnd, freshStart, freshEnd } = timeRanges;

  const segments = [
    { count: Math.floor(toInsert * 0.75), start: historicalStart, end: historicalEnd },
    { count: Math.floor(toInsert * 0.15), start: recentStart,     end: recentEnd },
    { count: toInsert - Math.floor(toInsert * 0.75) - Math.floor(toInsert * 0.15), start: freshStart, end: freshEnd },
  ];

  let totalInserted = existing;

  for (const seg of segments) {
    let segInserted = 0;
    while (segInserted < seg.count) {
      const thisBatch = Math.min(batchSize, seg.count - segInserted);
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < thisBatch; i++) {
        rows.push(generateSpanRow(strategy === 'b' ? tenantId : null, randomTimestampInRange(seg.start, seg.end)));
        if (i % 10 === 9) await Bun.sleep(0); // yield so concurrent tasks can interleave
      }
      await retryInsert(() => sql`INSERT INTO ${sql(tableName)} ${sql(rows)}`);
      segInserted += thisBatch;
      totalInserted += thisBatch;
      onBatch?.(thisBatch);
    }
  }
}

export async function seedSpans(
  strategy: Strategy,
  tenants: string[],
  totalPerTenant: number,
  concurrency = config.seedConcurrency,
): Promise<void> {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;
  const MS_PER_MONTH = 30 * MS_PER_DAY;

  const timeRanges = {
    historicalStart: now - 18 * MS_PER_MONTH,
    historicalEnd:   now - 4  * MS_PER_MONTH,
    recentStart:     now - 3  * MS_PER_MONTH,
    recentEnd:       now - 1  * MS_PER_MONTH,
    freshStart:      now - 7  * MS_PER_DAY,
    freshEnd:        now,
  };

  let completed = 0;
  let next = 0;
  let inFlight = 0;
  let totalRows = 0;
  const startMs = Date.now();
  const totalRows_target = tenants.length * totalPerTenant;

  console.log(`[spans] Seeding ${tenants.length} tenants (${concurrency} concurrent)...`);

  const heartbeat = setInterval(() => {
    const elapsed = (Date.now() - startMs) / 1000;
    const rps = elapsed > 0 ? totalRows / elapsed : 0;
    const eta = rps > 0 ? (totalRows_target - totalRows) / rps : 0;
    const etaStr = eta > 0 ? ` | eta: ${formatDuration(eta * 1000)}` : '';
    console.log(
      `[spans] ${completed}/${tenants.length} done, ${inFlight} in-flight | ${totalRows.toLocaleString()} rows | ${rps.toFixed(0)} rows/s | elapsed: ${formatDuration(elapsed * 1000)}${etaStr}`,
    );
  }, 30_000);

  await new Promise<void>((resolve, reject) => {
    function drain() {
      while (inFlight < concurrency && next < tenants.length) {
        const t = next++;
        const tenantId = tenants[t];
        inFlight++;

        seedSpansForTenant(strategy, tenantId, totalPerTenant, timeRanges, (n) => { totalRows += n; })
          .then(() => { completed++; })
          .catch(reject)
          .finally(() => {
            inFlight--;
            if (next === tenants.length && inFlight === 0) {
              resolve();
            } else {
              drain();
            }
          });
      }
    }
    drain();
    if (tenants.length === 0) resolve();
  });

  clearInterval(heartbeat);
  const elapsed = (Date.now() - startMs) / 1000;
  const rps = elapsed > 0 ? totalRows / elapsed : 0;
  console.log(`[spans] Complete: ${completed}/${tenants.length} tenants | ${totalRows.toLocaleString()} rows | avg ${rps.toFixed(0)} rows/s | elapsed: ${formatDuration(elapsed * 1000)}`);
}
