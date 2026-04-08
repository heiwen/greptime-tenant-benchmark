/**
 * Measures GreptimeDB frontend jemalloc memory growth while inserting rows
 * via MySQL or PostgreSQL protocol.
 *
 *   bun oom-repro/measure-memory.ts mysql
 *   bun oom-repro/measure-memory.ts pg
 */

import { SQL } from 'bun';

const protocol = Bun.argv[2] ?? 'pg';
const TOTAL_ROWS = 10_000;
const BATCH     = 100;
const SAMPLE_EVERY = 1_000; // rows

const sql = protocol === 'mysql'
  ? new SQL('mysql://greptime@localhost:4002/public', { max: 10, idleTimeout: 20, connectionTimeout: 10, ssl: false })
  : new SQL('postgres://greptime@localhost:5433/public', { max: 10, idleTimeout: 20, connectionTimeout: 10, ssl: false });

async function jemalloc(): Promise<number> {
  const res = await fetch('http://localhost:4000/metrics');
  const text = await res.text();
  const m = text.match(/^sys_jemalloc_allocated (\d+)/m);
  return m ? Number(m[1]) : 0;
}

// ── schema ────────────────────────────────────────────────────────────────

if (protocol === 'mysql') {
  await sql.unsafe('DROP TABLE IF EXISTS spans');
  await sql.unsafe(`
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
    ) WITH ('append_mode' = 'true')
  `);
} else {
  await sql.unsafe('DROP TABLE IF EXISTS spans');
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS spans (
      tenant_id VARCHAR(36) NOT NULL INVERTED INDEX,
      "timestamp" TIMESTAMP(9) NOT NULL TIME INDEX,
      timestamp_end TIMESTAMP(9),
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
    ) WITH ('append_mode' = 'true')
  `);
}

// ── row generator (same as repro scripts) ────────────────────────────────

const VOCABULARY = ['the','be','to','of','and','a','in','that','have','it','for','not','on','with','he','as','you','do','at','this'];
function randomWord() { return VOCABULARY[Math.floor(Math.random() * VOCABULARY.length)]; }
function randomText(n: number) { const w=[]; let b=0; while(b<n){const x=randomWord();w.push(x);b+=x.length+1;} return w.join(' ').slice(0,n); }
function randomJson(n: number) { const o: Record<string,unknown>={};let s=2,k=0;const ks=['id','name','value','type','status','message','code','data'];while(s<n-20){const key=k<ks.length?ks[k]:`f${k}`;k++;const v=Math.floor(Math.random()*100000);o[key]=v;s+=key.length+2+String(v).length+3;}return JSON.stringify(o); }
function randomHex(n: number) { return Array.from({length:n},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join(''); }

const TIER_CONFIG = {
  tiny:   { share: 0.10, inputBytes:    400, outputBytes:   150 },
  small:  { share: 0.40, inputBytes:   3000, outputBytes:   500 },
  medium: { share: 0.35, inputBytes:  15000, outputBytes:  2000 },
  large:  { share: 0.12, inputBytes:  80000, outputBytes:  5000 },
  xlarge: { share: 0.03, inputBytes: 400000, outputBytes: 20000 },
} as const;
function pickTier() { let r=Math.random(),c=0;for(const[t,cfg]of Object.entries(TIER_CONFIG) as any[]){c+=cfg.share;if(r<c)return t;}return 'small'; }

const SYSTEMS = ['openai','anthropic','google'];
const MODELS: Record<string,string[]> = { openai:['gpt-4o','gpt-4o-mini'], anthropic:['claude-3-5-sonnet','claude-3-haiku'], google:['gemini-1.5-pro','gemini-1.5-flash'] };
const TENANTS = Array.from({length:100},()=>crypto.randomUUID());

function generateRow(): Record<string, unknown> {
  const tier = pickTier() as keyof typeof TIER_CONFIG;
  const cfg = TIER_CONFIG[tier];
  const sys = SYSTEMS[Math.floor(Math.random()*SYSTEMS.length)];
  const model = MODELS[sys][Math.floor(Math.random()*MODELS[sys].length)];
  const inp = Math.floor(cfg.inputBytes/4), out = Math.floor(cfg.outputBytes/4);
  const dur = Math.floor(100_000_000+Math.random()*29_900_000_000);
  const ts = Date.now();
  return {
    tenant_id: TENANTS[Math.floor(Math.random()*TENANTS.length)],
    timestamp: new Date(ts),
    timestamp_end: new Date(ts+Math.floor(dur/1_000_000)),
    duration_nano: dur,
    trace_id: randomHex(32),
    span_id: randomHex(16),
    parent_span_id: Math.random()>0.3 ? randomHex(16) : null,
    span_name: `${sys}.${model}.chat`,
    span_kind: 'CLIENT',
    span_status_code: Math.random()>0.05 ? 'OK' : 'ERROR',
    span_status_message: Math.random()>0.05 ? null : 'Request failed',
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
    gen_ai_total_tokens: inp+out,
    gen_ai_finish_reasons: 'stop',
    gen_ai_input_messages: JSON.stringify([{role:'user',content:randomText(Math.floor(cfg.inputBytes*0.7))}]),
    gen_ai_output_messages: JSON.stringify([{role:'assistant',content:randomText(cfg.outputBytes)}]),
    span_attributes: randomJson(200),
    span_events: '[]',
    span_links: '[]',
  };
}

// ── measure ───────────────────────────────────────────────────────────────

const baseline = await jemalloc();
console.log(`Protocol: ${protocol.toUpperCase()}`);
console.log(`Baseline: ${(baseline/1024/1024).toFixed(1)} MB`);
console.log(`rows\tallocated_MB\tdelta_MB\tMB_per_1k_rows`);

let total = 0;
let lastSample = baseline;

while (total < TOTAL_ROWS) {
  const rows = Array.from({length: BATCH}, () => generateRow());
  await sql`INSERT INTO spans ${sql(rows)}`;
  total += BATCH;

  if (total % SAMPLE_EVERY === 0) {
    const allocated = await jemalloc();
    const delta = allocated - baseline;
    const rate = delta / (total / 1000);
    console.log(`${total}\t${(allocated/1024/1024).toFixed(1)}\t${(delta/1024/1024).toFixed(1)}\t${(rate/1024/1024).toFixed(2)}`);
    lastSample = allocated;
  }
}

const final = await jemalloc();
console.log(`\nTotal growth: ${((final-baseline)/1024/1024).toFixed(1)} MB over ${TOTAL_ROWS} rows`);
console.log(`Rate: ${((final-baseline)/1024/1024 / (TOTAL_ROWS/1000)).toFixed(2)} MB / 1k rows`);

await sql.end();
