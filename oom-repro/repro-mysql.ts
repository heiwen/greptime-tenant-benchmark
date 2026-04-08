import { SQL } from 'bun';

const sql = new SQL('mysql://greptime@localhost:4002/public', {
  max: 100,
  idleTimeout: 20,
  connectionTimeout: 10,
  ssl: false,
});

await sql`DROP TABLE IF EXISTS spans`;
await sql`
  CREATE TABLE IF NOT EXISTS spans (
    tenant_id VARCHAR(36) NOT NULL,
    \`timestamp\` TIMESTAMP(6) NOT NULL TIME INDEX,
    timestamp_end TIMESTAMP(6),
    duration_nano BIGINT UNSIGNED,
    trace_id VARCHAR(32) NOT NULL,
    span_id VARCHAR(16) NOT NULL,
    parent_span_id VARCHAR(16),
    span_name VARCHAR(256),
    span_kind VARCHAR(64),
    span_status_code VARCHAR(64),
    span_status_message VARCHAR(512),
    trace_state VARCHAR(256),
    service_name STRING,
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

// --- helpers (same as repro.ts) ---

const VOCABULARY = [
  'the','be','to','of','and','a','in','that','have','it','for','not','on','with',
  'he','as','you','do','at','this','but','his','by','from','they','we','say','her',
  'she','or','an','will','my','one','all','would','there','their','what','so','up',
  'out','if','about','who','get','which','go','me','when','make','can','like','time',
  'no','just','him','know','take','people','into','year','your','good','some','could',
  'them','see','other','than','then','now','look','only','come','its','over','think',
  'also','back','after','use','two','how','our','work','first','well','way','even',
  'new','want','because','any','these','give','day','most','us',
];

function randomWord() { return VOCABULARY[Math.floor(Math.random() * VOCABULARY.length)]; }
function randomText(targetBytes: number) {
  const words: string[] = [];
  let bytes = 0;
  while (bytes < targetBytes) { const w = randomWord(); words.push(w); bytes += w.length + 1; }
  return words.join(' ').slice(0, targetBytes);
}
function randomJson(targetBytes: number) {
  const obj: Record<string, unknown> = {};
  let sz = 2, ki = 0;
  const keys = ['id','name','value','type','status','message','code','data','timestamp','version','source','target','level','category'];
  while (sz < targetBytes - 20) {
    const key = ki < keys.length ? keys[ki] : `field_${ki}`; ki++;
    const val = Math.floor(Math.random() * 100000);
    obj[key] = val; sz += key.length + 2 + String(val).length + 3;
  }
  return JSON.stringify(obj);
}

const TIER_CONFIG = {
  tiny:   { share: 0.10, inputBytes:    400, outputBytes:   150 },
  small:  { share: 0.40, inputBytes:   3000, outputBytes:   500 },
  medium: { share: 0.35, inputBytes:  15000, outputBytes:  2000 },
  large:  { share: 0.12, inputBytes:  80000, outputBytes:  5000 },
  xlarge: { share: 0.03, inputBytes: 400000, outputBytes: 20000 },
} as const;

function pickTier() {
  let r = Math.random(), cum = 0;
  for (const [t, c] of Object.entries(TIER_CONFIG) as any[]) { cum += c.share; if (r < cum) return t; }
  return 'small';
}
function randomHex(n: number) {
  return Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

const SYSTEMS = ['openai','anthropic','google','cohere','mistral'];
const MODELS: Record<string,string[]> = {
  openai: ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo'],
  anthropic: ['claude-3-5-sonnet','claude-3-opus','claude-3-haiku'],
  google: ['gemini-1.5-pro','gemini-1.5-flash','gemini-pro'],
  cohere: ['command-r-plus','command-r'],
  mistral: ['mistral-large','mistral-medium','mistral-small'],
};
const FINISH = ['stop','length','tool_calls','content_filter'];

function generateRow(tenantId: string): Record<string, unknown> {
  const tier = pickTier() as keyof typeof TIER_CONFIG;
  const cfg = TIER_CONFIG[tier];
  const sys = SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)];
  const model = MODELS[sys][Math.floor(Math.random() * MODELS[sys].length)];
  const inp = Math.floor(cfg.inputBytes / 4), out = Math.floor(cfg.outputBytes / 4);
  const durNano = Math.floor(100_000_000 + Math.random() * 29_900_000_000);
  const tsMs = Date.now();
  return {
    tenant_id: tenantId,
    timestamp: new Date(tsMs),
    timestamp_end: new Date(tsMs + Math.floor(durNano / 1_000_000)),
    duration_nano: durNano,
    trace_id: randomHex(32),
    span_id: randomHex(16),
    parent_span_id: Math.random() > 0.3 ? randomHex(16) : null,
    span_name: `${sys}.${model}.chat`,
    span_kind: 'CLIENT',
    span_status_code: Math.random() > 0.05 ? 'OK' : 'ERROR',
    span_status_message: Math.random() > 0.05 ? null : 'Request failed',
    trace_state: null,
    service_name: `ai-service-${sys}`,
    scope_name: `@opentelemetry/instrumentation-${sys}`,
    scope_version: '1.0.0',
    gen_ai_operation: 'chat',
    gen_ai_system: sys,
    gen_ai_request_model: model,
    gen_ai_response_model: model,
    gen_ai_input_tokens: inp,
    gen_ai_output_tokens: out,
    gen_ai_total_tokens: inp + out,
    gen_ai_finish_reasons: FINISH[Math.floor(Math.random() * FINISH.length)],
    gen_ai_input_messages: JSON.stringify([{role:'system',content:randomText(Math.floor(cfg.inputBytes*0.3))},{role:'user',content:randomText(Math.floor(cfg.inputBytes*0.7))}]),
    gen_ai_output_messages: JSON.stringify([{role:'assistant',content:randomText(cfg.outputBytes)}]),
    span_attributes: randomJson(200),
    span_events: '[]',
    span_links: '[]',
  };
}

// --- insert loop ---

const TENANTS = Array.from({ length: 100 }, () => crypto.randomUUID());
const BATCH = 100;
let total = 0;

while (true) {
  const rows = Array.from({ length: BATCH }, () =>
    generateRow(TENANTS[Math.floor(Math.random() * TENANTS.length)])
  );

  await sql`INSERT INTO spans ${sql(rows)}`;
  total += BATCH;
  if (total % 1_000 === 0) console.log(`Inserted ${total} rows`);
}
