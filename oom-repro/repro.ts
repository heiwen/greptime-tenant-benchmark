import { SQL } from 'bun';

const sql = new SQL('postgres://greptime@localhost:4003/public', {
  max: 100,
  idleTimeout: 20,
  connectionTimeout: 10,
  ssl: false,
});

await sql`DROP TABLE IF EXISTS spans`;
await sql`
  CREATE TABLE IF NOT EXISTS spans (
    tenant_id VARCHAR(36) NOT NULL INVERTED INDEX,
    "timestamp" TIMESTAMP(9) NOT NULL TIME INDEX,
    timestamp_end TIMESTAMP(9),
    duration_nano BIGINT UNSIGNED,
    trace_id VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=10240),
    span_id VARCHAR(16) NOT NULL,
    parent_span_id VARCHAR(16),
    span_name VARCHAR(256) INVERTED INDEX,
    span_kind VARCHAR(64),
    span_status_code VARCHAR(64),
    span_status_message VARCHAR(512),
    trace_state VARCHAR(256),
    service_name STRING SKIPPING INDEX WITH(granularity=10240, type='BLOOM'),
    scope_name VARCHAR(256),
    scope_version VARCHAR(64),
    gen_ai_operation VARCHAR(64),
    gen_ai_system VARCHAR(64),
    gen_ai_request_model VARCHAR(128),
    gen_ai_response_model VARCHAR(128),
    gen_ai_input_tokens INT,
    gen_ai_output_tokens INT,
    gen_ai_total_tokens INT,
    gen_ai_finish_reasons VARCHAR(128),
    gen_ai_input_messages STRING,
    gen_ai_output_messages STRING,
    span_attributes STRING,
    span_events STRING,
    span_links STRING,
    PRIMARY KEY (service_name)
  )
  PARTITION ON COLUMNS (tenant_id) (
    tenant_id < '1',
    tenant_id >= '1' AND tenant_id < '2',
    tenant_id >= '2' AND tenant_id < '3',
    tenant_id >= '3' AND tenant_id < '4',
    tenant_id >= '4' AND tenant_id < '5',
    tenant_id >= '5' AND tenant_id < '6',
    tenant_id >= '6' AND tenant_id < '7',
    tenant_id >= '7' AND tenant_id < '8',
    tenant_id >= '8' AND tenant_id < '9',
    tenant_id >= '9' AND tenant_id < 'a',
    tenant_id >= 'a' AND tenant_id < 'b',
    tenant_id >= 'b' AND tenant_id < 'c',
    tenant_id >= 'c' AND tenant_id < 'd',
    tenant_id >= 'd' AND tenant_id < 'e',
    tenant_id >= 'e' AND tenant_id < 'f',
    tenant_id >= 'f'
  )
  WITH ('append_mode' = 'true')
`;

console.log('Table created. Inserting rows...');

// --- text helpers (mirrors src/seed/text.ts) ---

const VOCABULARY = [
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it',
  'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this',
  'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or',
  'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know',
  'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could',
  'them', 'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come',
  'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how',
  'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
  'any', 'these', 'give', 'day', 'most', 'us',
];

function randomWord(): string {
  return VOCABULARY[Math.floor(Math.random() * VOCABULARY.length)];
}

function randomText(targetBytes: number): string {
  const words: string[] = [];
  let currentBytes = 0;
  while (currentBytes < targetBytes) {
    const word = randomWord();
    words.push(word);
    currentBytes += word.length + 1;
  }
  return words.join(' ').slice(0, targetBytes);
}

function randomJson(targetBytes: number): string {
  const obj: Record<string, unknown> = {};
  let currentSize = 2;
  let keyIndex = 0;
  const keys = ['id', 'name', 'value', 'type', 'status', 'message', 'code', 'data',
    'timestamp', 'version', 'source', 'target', 'level', 'category'];
  while (currentSize < targetBytes - 20) {
    const key = keyIndex < keys.length ? keys[keyIndex] : `field_${keyIndex}`;
    keyIndex++;
    const value = Math.floor(Math.random() * 100000);
    const valueStr = String(value);
    obj[key] = value;
    currentSize += key.length + 2 + valueStr.length + 3;
  }
  return JSON.stringify(obj);
}

// --- tier distribution (mirrors src/seed/spans.ts) ---

const TIER_CONFIG = {
  tiny:   { share: 0.10, inputBytes:    400, outputBytes:   150, totalRowBytes:    2_000 },
  small:  { share: 0.40, inputBytes:   3000, outputBytes:   500, totalRowBytes:    5_000 },
  medium: { share: 0.35, inputBytes:  15000, outputBytes:  2000, totalRowBytes:   20_000 },
  large:  { share: 0.12, inputBytes:  80000, outputBytes:  5000, totalRowBytes:   90_000 },
  xlarge: { share: 0.03, inputBytes: 400000, outputBytes: 20000, totalRowBytes:  430_000 },
} as const;
type Tier = keyof typeof TIER_CONFIG;

function pickTier(): Tier {
  const r = Math.random();
  let cumulative = 0;
  for (const [tier, cfg] of Object.entries(TIER_CONFIG) as [Tier, typeof TIER_CONFIG[Tier]][]) {
    cumulative += cfg.share;
    if (r < cumulative) return tier;
  }
  return 'small';
}

function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * 16)];
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

function generateSpanRow(tenantId: string): Record<string, unknown> {
  const tier = pickTier();
  const tierCfg = TIER_CONFIG[tier];
  const system = GEN_AI_SYSTEMS[Math.floor(Math.random() * GEN_AI_SYSTEMS.length)];
  const models = GEN_AI_MODELS[system];
  const model = models[Math.floor(Math.random() * models.length)];
  const inputTokens = Math.floor(tierCfg.inputBytes / 4);
  const outputTokens = Math.floor(tierCfg.outputBytes / 4);
  const durationNano = Math.floor(100_000_000 + Math.random() * 29_900_000_000);
  const tsMs = Date.now();
  return {
    tenant_id: tenantId,
    timestamp: new Date(tsMs),
    timestamp_end: new Date(tsMs + Math.floor(durationNano / 1_000_000)),
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
    gen_ai_input_messages: JSON.stringify([
      { role: 'system', content: randomText(Math.floor(tierCfg.inputBytes * 0.3)) },
      { role: 'user', content: randomText(Math.floor(tierCfg.inputBytes * 0.7)) },
    ]),
    gen_ai_output_messages: JSON.stringify([
      { role: 'assistant', content: randomText(tierCfg.outputBytes) },
    ]),
    span_attributes: randomJson(200),
    span_events: '[]',
    span_links: '[]',
  };
}

// --- insert loop ---

const TENANTS = Array.from({ length: 100 }, () => crypto.randomUUID());
let total = 0;
const BATCH = 100;

while (true) {
  const rows = Array.from({ length: BATCH }, () =>
    generateSpanRow(TENANTS[Math.floor(Math.random() * TENANTS.length)])
  );

  await sql`INSERT INTO spans ${sql(rows)}`;
  total += BATCH;

  if (total % 1_000 === 0) {
    console.log(`Inserted ${total} rows`);
  }
}
