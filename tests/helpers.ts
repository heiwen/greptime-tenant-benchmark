import { SQL } from 'bun';

export const GREPTIMEDB_URL = process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public';
const IS_MYSQL  = GREPTIMEDB_URL.startsWith('mysql://');
export const IS_SQLITE = GREPTIMEDB_URL.startsWith('sqlite://');

// SQLite: use a per-worker-process file so ALL pools in the same worker share one
// database. Each bun test worker is a separate process (distinct pid), so workers
// stay isolated from each other while pools within one worker all see the same tables.
const EFFECTIVE_URL = IS_SQLITE
  ? `sqlite:///tmp/bun-test-sqlite-${process.pid}.db`
  : GREPTIMEDB_URL;

/**
 * Create a Bun.SQL pool with the correct base options for the active adapter.
 * `prepare: false` is a Postgres-only workaround for the Bun.SQL prepared-statement
 * cache OOM bug — the MySQL adapter rejects the option at connection time.
 */
export function makePool(opts: { max: number; idleTimeout: number; connectionTimeout: number }): SQL {
  if (IS_SQLITE) return new SQL(EFFECTIVE_URL, { max: opts.max });
  return new SQL(EFFECTIVE_URL, {
    ...opts,
    ssl: false,
    ...(IS_MYSQL ? {} : { prepare: false }),
  });
}

/**
 * Rewrite GreptimeDB-specific DDL into SQLite-compatible DDL.
 * Called automatically by createSpansTable et al. when IS_SQLITE is true.
 */
export function sqliteAdapt(ddl: string): string {
  return ddl
    // TIMESTAMP(n) NOT NULL TIME INDEX  →  DATETIME NOT NULL
    .replace(/TIMESTAMP\(\d+\)\s+NOT NULL\s+TIME INDEX/g, 'DATETIME NOT NULL')
    // TIMESTAMP(n) elsewhere
    .replace(/TIMESTAMP\(\d+\)/g, 'DATETIME')
    // GreptimeDB-specific column type extensions
    .replace(/\bBIGINT UNSIGNED\b/g, 'INTEGER')
    .replace(/\bSTRING\b/g, 'TEXT')
    // GreptimeDB index annotations (column-level)
    .replace(/\s+INVERTED INDEX\b/g, '')
    .replace(/\s+SKIPPING INDEX\s+WITH\s*\([^)]*\)/g, '')
    // Table-level options
    .replace(/\)\s*WITH\s*\(\s*'append_mode'\s*=\s*'true'\s*\)/g, ')')
    .trimEnd();
}

// NOTE: Bun test shares module state across parallel workers, so this pool is
// used concurrently by all 12 test files. Size it to handle that load.
export const sql = makePool({ max: 20, idleTimeout: 30, connectionTimeout: 15 });

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

/**
 * Quote a column name for the active SQL dialect.
 * MySQL requires backtick-quoting for reserved words (e.g. `timestamp`, `id`).
 * PostgreSQL and SQLite use double-quotes.
 * Use this only in `sql.unsafe()` DDL strings; in tagged template literals use
 * `${sql('column')}` instead, which Bun.SQL quotes automatically per dialect.
 */
function col(name: string): string {
  return IS_MYSQL ? `\`${name}\`` : `"${name}"`;
}

/**
 * Retry wrapper for DDL operations that may briefly fail during parallel test
 * startup due to transient connection disruptions from concurrent test files.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 200): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/** Standard spans table, no indexes. PRIMARY KEY (span_id). */
export async function createSpansTable(name: string): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ${name} (
      ${col('timestamp')}    TIMESTAMP(9) NOT NULL TIME INDEX,
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
  `;
  await withRetry(() => sql.unsafe(IS_SQLITE ? sqliteAdapt(ddl) : ddl));
}

/** Spans table with INVERTED INDEX on span_name and BLOOM SKIPPING INDEX on trace_id. */
export async function createIndexedSpansTable(name: string): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ${name} (
      ${col('timestamp')}    TIMESTAMP(9) NOT NULL TIME INDEX,
      trace_id            VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=1024),
      span_id             VARCHAR(16) NOT NULL,
      span_name           VARCHAR(256) INVERTED INDEX,
      service_name        STRING,
      gen_ai_system       VARCHAR(64),
      gen_ai_input_tokens INT,
      PRIMARY KEY (span_id)
    ) WITH ('append_mode' = 'true')
  `;
  await withRetry(() => sql.unsafe(IS_SQLITE ? sqliteAdapt(ddl) : ddl));
}

/** Shared spans table for multi-tenant tests (Strategy B). */
export async function createSharedSpansTable(name: string): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ${name} (
      tenant_id           VARCHAR(36) NOT NULL,
      ${col('timestamp')}  TIMESTAMP(9) NOT NULL TIME INDEX,
      trace_id            VARCHAR(32) NOT NULL,
      span_id             VARCHAR(16) NOT NULL,
      service_name        STRING,
      gen_ai_system       VARCHAR(64),
      gen_ai_input_tokens INT,
      PRIMARY KEY (tenant_id, span_id)
    ) WITH ('append_mode' = 'true')
  `;
  await withRetry(() => sql.unsafe(IS_SQLITE ? sqliteAdapt(ddl) : ddl));
}

/** Conversation items table. */
export async function createItemsTable(name: string): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ${name} (
      ${col('id')}        VARCHAR(36) NOT NULL,
      conversation_id     VARCHAR(36) NOT NULL,
      created_at          TIMESTAMP(3) NOT NULL TIME INDEX,
      ${col('type')}      VARCHAR(64),
      ${col('data')}      STRING,
      PRIMARY KEY (id)
    ) WITH ('append_mode' = 'true')
  `;
  await withRetry(() => sql.unsafe(IS_SQLITE ? sqliteAdapt(ddl) : ddl));
}

export async function dropTable(name: string): Promise<void> {
  await withRetry(() => sql.unsafe(`DROP TABLE IF EXISTS ${name}`));
}

// ── Row factories ─────────────────────────────────────────────────────────────

/**
 * Bun.SQL serialises Date objects via .toString() (locale string) rather than
 * .toISOString(), which GreptimeDB cannot parse. Convert every Date in a row to
 * an ISO 8601 string before passing it to sql(rows).
 */
function normaliseDates(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** Full span row with all nullable fields set. Override any field via `overrides`. */
export function spanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return normaliseDates({
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
  });
}

/** Minimal span row — only required fields. */
export function minimalSpanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return normaliseDates({
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
  });
}

export function itemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return normaliseDates({
    id:              crypto.randomUUID(),
    conversation_id: crypto.randomUUID(),
    created_at:      ts(),
    type:            'user',
    data:            JSON.stringify({ content: 'hello' }),
    ...overrides,
  });
}

/** Count rows in a table, optionally filtered by an extra WHERE clause snippet. */
export async function countRows(table: string, where = ''): Promise<number> {
  const clause = where ? `WHERE ${where}` : '';
  const rows = await sql.unsafe(`SELECT COUNT(*) AS c FROM ${table} ${clause}`);
  return Number((rows as Array<{ c: unknown }>)[0].c);
}
