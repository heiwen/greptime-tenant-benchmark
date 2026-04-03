import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
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
    timestamp: new Date(timestampMs),
    timestamp_end: new Date(timestampEndMs),
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

export async function seedSpans(
  strategy: Strategy,
  tenants: string[],
  totalPerTenant: number,
): Promise<void> {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;
  const MS_PER_MONTH = 30 * MS_PER_DAY;

  // Time distribution ranges
  const historicalStart = now - 18 * MS_PER_MONTH;
  const historicalEnd   = now - 4 * MS_PER_MONTH;
  const recentStart     = now - 3 * MS_PER_MONTH;
  const recentEnd       = now - MS_PER_MONTH;
  const freshStart      = now - 7 * MS_PER_DAY;
  const freshEnd        = now;

  const historicalCount = Math.floor(totalPerTenant * 0.75);
  const recentCount     = Math.floor(totalPerTenant * 0.15);
  const freshCount      = totalPerTenant - historicalCount - recentCount;

  const batchSize = config.spanBatchSize;

  for (let t = 0; t < tenants.length; t++) {
    const tenantId = tenants[t];
    const tableName = strategy === 'a'
      ? tenantTable('spans', tenantId)
      : 'spans';

    console.log(`[spans] Tenant ${t + 1}/${tenants.length}: ${tenantId} → ${tableName}`);

    const segments = [
      { count: historicalCount, start: historicalStart, end: historicalEnd },
      { count: recentCount,     start: recentStart,     end: recentEnd },
      { count: freshCount,      start: freshStart,      end: freshEnd },
    ];

    let totalInserted = 0;

    for (const seg of segments) {
      let segInserted = 0;

      while (segInserted < seg.count) {
        const thisBatch = Math.min(batchSize, seg.count - segInserted);
        const rows: Record<string, unknown>[] = [];

        for (let i = 0; i < thisBatch; i++) {
          const tsMs = randomTimestampInRange(seg.start, seg.end);
          const row = generateSpanRow(strategy === 'b' ? tenantId : null, tsMs);
          rows.push(row);
        }

        await sql`INSERT INTO ${sql(tableName)} ${sql(rows)}`;

        segInserted += thisBatch;
        totalInserted += thisBatch;

        if (totalInserted % 10_000 === 0) {
          console.log(`  [spans] ${tenantId}: ${totalInserted}/${totalPerTenant} rows inserted`);
        }
      }
    }

    console.log(`  [spans] ${tenantId}: complete (${totalInserted} rows)`);
  }
}
