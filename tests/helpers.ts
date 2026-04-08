import { SQL } from 'bun';

export const sql = new SQL(
  process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public',
  { max: 20, idleTimeout: 20, connectionTimeout: 10, ssl: false, prepare: false },
);

// ── Naming ────────────────────────────────────────────────────────────────────

export function uniqueSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function randomHex(len: number): string {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

/** Timestamp relative to 30 minutes ago, offset by seconds. */
export function ts(offsetSec: number = 0): Date {
  return new Date(Date.now() - 1_800_000 + offsetSec * 1_000);
}

// ── DDL ───────────────────────────────────────────────────────────────────────

/** Standard spans table, no indexes. PRIMARY KEY (span_id). */
export async function createSpansTable(name: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${name} (
      "timestamp"          TIMESTAMP(9) NOT NULL TIME INDEX,
      timestamp_end        TIMESTAMP(9),
      duration_nano        BIGINT UNSIGNED,
      trace_id             VARCHAR(32) NOT NULL,
      span_id              VARCHAR(16) NOT NULL,
      parent_span_id       VARCHAR(16),
      span_name            VARCHAR(256),
      span_kind            VARCHAR(64),
      span_status_code     VARCHAR(64),
      span_status_message  VARCHAR(512),
      service_name         STRING,
      gen_ai_system        VARCHAR(64),
      gen_ai_request_model VARCHAR(128),
      gen_ai_input_tokens  INT,
      gen_ai_output_tokens INT,
      gen_ai_total_tokens  INT,
      gen_ai_input_messages  STRING,
      gen_ai_output_messages STRING,
      span_attributes      STRING,
      PRIMARY KEY (span_id)
    ) WITH ('append_mode' = 'true')
  `);
}

/** Spans table with INVERTED INDEX on span_name and BLOOM SKIPPING INDEX on trace_id. */
export async function createIndexedSpansTable(name: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${name} (
      "timestamp"         TIMESTAMP(9) NOT NULL TIME INDEX,
      trace_id            VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=1024),
      span_id             VARCHAR(16) NOT NULL,
      span_name           VARCHAR(256) INVERTED INDEX,
      service_name        STRING,
      gen_ai_system       VARCHAR(64),
      gen_ai_input_tokens INT,
      PRIMARY KEY (span_id)
    ) WITH ('append_mode' = 'true')
  `);
}

/** Shared spans table for multi-tenant tests (Strategy B). */
export async function createSharedSpansTable(name: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${name} (
      tenant_id           VARCHAR(36) NOT NULL,
      "timestamp"         TIMESTAMP(9) NOT NULL TIME INDEX,
      trace_id            VARCHAR(32) NOT NULL,
      span_id             VARCHAR(16) NOT NULL,
      service_name        STRING,
      gen_ai_system       VARCHAR(64),
      gen_ai_input_tokens INT,
      PRIMARY KEY (tenant_id, span_id)
    ) WITH ('append_mode' = 'true')
  `);
}

/** Conversation items table. */
export async function createItemsTable(name: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${name} (
      "id"            VARCHAR(36) NOT NULL,
      conversation_id VARCHAR(36) NOT NULL,
      created_at      TIMESTAMP(3) NOT NULL TIME INDEX,
      "type"          VARCHAR(64),
      "data"          STRING,
      PRIMARY KEY (id)
    ) WITH ('append_mode' = 'true')
  `);
}

export async function dropTable(name: string): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS ${name}`);
}

// ── Row factories ─────────────────────────────────────────────────────────────

/** Full span row with all nullable fields set. Override any field via `overrides`. */
export function spanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp:             ts(),
    timestamp_end:         ts(1),
    duration_nano:         500_000_000,
    trace_id:              randomHex(32),
    span_id:               randomHex(16),
    parent_span_id:        randomHex(16),
    span_name:             'test.span',
    span_kind:             'CLIENT',
    span_status_code:      'OK',
    span_status_message:   null,
    service_name:          'test-service',
    gen_ai_system:         'openai',
    gen_ai_request_model:  'gpt-4o',
    gen_ai_input_tokens:   100,
    gen_ai_output_tokens:  50,
    gen_ai_total_tokens:   150,
    gen_ai_input_messages:  JSON.stringify([{ role: 'user', content: 'hello' }]),
    gen_ai_output_messages: JSON.stringify([{ role: 'assistant', content: 'hi' }]),
    span_attributes:       '{}',
    ...overrides,
  };
}

/** Minimal span row — only required fields. */
export function minimalSpanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp:            ts(),
    timestamp_end:        null,
    duration_nano:        null,
    trace_id:             randomHex(32),
    span_id:              randomHex(16),
    parent_span_id:       null,
    span_name:            null,
    span_kind:            null,
    span_status_code:     null,
    span_status_message:  null,
    service_name:         null,
    gen_ai_system:        null,
    gen_ai_request_model: null,
    gen_ai_input_tokens:  null,
    gen_ai_output_tokens: null,
    gen_ai_total_tokens:  null,
    gen_ai_input_messages:  null,
    gen_ai_output_messages: null,
    span_attributes:      null,
    ...overrides,
  };
}

export function itemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id:              crypto.randomUUID(),
    conversation_id: crypto.randomUUID(),
    created_at:      ts(),
    type:            'user',
    data:            JSON.stringify({ content: 'hello' }),
    ...overrides,
  };
}

/** Count rows in a table, optionally filtered by an extra WHERE clause snippet. */
export async function countRows(table: string, where = ''): Promise<number> {
  const clause = where ? `WHERE ${where}` : '';
  const rows = await sql.unsafe(`SELECT COUNT(*) AS c FROM ${table} ${clause}`);
  return Number((rows as Array<{ c: unknown }>)[0].c);
}
