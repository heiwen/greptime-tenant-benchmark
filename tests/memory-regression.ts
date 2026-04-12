/**
 * Memory regression script — run standalone with:
 *   bun run tests/memory-regression.ts
 *
 * Not part of `bun test`. Each scenario runs for a fixed number of iterations,
 * measures heap before and after, and fails (exit 1) if growth exceeds 50 MB.
 */

import { SQL } from 'bun';

const GREPTIMEDB_URL = process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public';
const IS_MYSQL = GREPTIMEDB_URL.startsWith('mysql://');
const colTimestamp = IS_MYSQL ? '`timestamp`' : '"timestamp"';

const sql = new SQL(GREPTIMEDB_URL, {
  max: 20, idleTimeout: 20, connectionTimeout: 10, ssl: false,
  ...(IS_MYSQL ? {} : { prepare: false }),
});

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1_048_576;
}

function randomHex(len: number): string {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

async function createTable(name: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${name} (
      ${colTimestamp} TIMESTAMP(9) NOT NULL TIME INDEX,
      span_id        VARCHAR(16) NOT NULL,
      parent_span_id VARCHAR(16),
      service_name   STRING,
      gen_ai_system  VARCHAR(64),
      PRIMARY KEY (span_id)
    ) WITH ('append_mode' = 'true')
  `);
}

async function dropTable(name: string): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS ${name}`);
}

const THRESHOLD_MB = 50;
const results: { name: string; before: number; after: number; delta: number; pass: boolean }[] = [];

function record(name: string, before: number, after: number): void {
  const delta = after - before;
  const pass = delta < THRESHOLD_MB;
  results.push({ name, before, after, delta, pass });
  const tag = pass ? 'PASS' : 'FAIL';
  const sign = delta >= 0 ? '+' : '';
  console.log(`  [${tag}] before=${before.toFixed(1)} MB  after=${after.toFixed(1)} MB  delta=${sign}${delta.toFixed(1)} MB`);
}

// ── Scenario 1: Variable-nullability batches ──────────────────────────────────
// The original OOM: Bun.SQL keyed prepared-statement cache on per-parameter
// nullability, so alternating NULL/non-NULL produced a new cached statement per
// iteration. With prepare:false this must stay flat over 10k iterations.

async function scenario1(): Promise<void> {
  console.log('\nScenario 1: variable-nullability batches (10k iterations × 10 rows)');
  const table = `mem_s1_${randomHex(10)}`;
  await createTable(table);

  // Warmup — prime any one-time allocations
  for (let i = 0; i < 50; i++) {
    const rows = Array.from({ length: 10 }, (_, j) => ({
      timestamp:     new Date(Date.now() - (i * 10 + j) * 1_000).toISOString(),
      span_id:       randomHex(16),
      parent_span_id: j % 2 === 0 ? null : randomHex(16),
      service_name:  'warmup',
      gen_ai_system: null,
    }));
    await sql`INSERT INTO ${sql(table)} ${sql(rows)}`;
  }

  if (typeof Bun.gc === 'function') Bun.gc(true);
  const before = heapMB();

  for (let i = 0; i < 10_000; i++) {
    const base = Date.now() - 999_999_000 + i * 10_000;
    const rows = Array.from({ length: 10 }, (_, j) => ({
      timestamp:     new Date(base + j * 1_000).toISOString(),
      span_id:       randomHex(16),
      parent_span_id: j % 2 === 0 ? null : randomHex(16),
      service_name:  `s1-${i}`,
      gen_ai_system: i % 3 === 0 ? null : 'openai',
    }));
    await sql`INSERT INTO ${sql(table)} ${sql(rows)}`;
  }

  if (typeof Bun.gc === 'function') Bun.gc(true);
  record('variable-nullability batches', before, heapMB());
  await dropTable(table);
}

// ── Scenario 2: Error-path connection leak ────────────────────────────────────
// Connections must be returned to the pool after errors, not leaked.

async function scenario2(): Promise<void> {
  console.log('\nScenario 2: error-path connection leak (1000 bad queries)');
  const table = `mem_s2_${randomHex(10)}`;
  await createTable(table);

  for (let i = 0; i < 10; i++) {
    await sql`SELECT COUNT(*) AS c FROM ${sql(table)}`;
  }

  if (typeof Bun.gc === 'function') Bun.gc(true);
  const before = heapMB();

  for (let i = 0; i < 1_000; i++) {
    try {
      await sql.unsafe(`SELECT * FROM nonexistent_mem_table_${i}`);
    } catch {
      // expected
    }
  }

  // Verify pool is still functional
  const check = await sql`SELECT COUNT(*) AS c FROM ${sql(table)}`;
  if (!check[0]) throw new Error('Pool broken after error-path scenario');

  if (typeof Bun.gc === 'function') Bun.gc(true);
  record('error-path connection leak', before, heapMB());
  await dropTable(table);
}

// ── Scenario 3: Large result set GC ──────────────────────────────────────────
// Result arrays must be GC'd between iterations; heap must not grow linearly.

async function scenario3(): Promise<void> {
  console.log('\nScenario 3: large result set GC (500 iterations × SELECT * of 1000 rows)');
  const table = `mem_s3_${randomHex(10)}`;
  await createTable(table);

  // Seed 1000 rows in 10 batches
  for (let batch = 0; batch < 10; batch++) {
    const base = Date.now() - 999_000_000 + batch * 100_000;
    const rows = Array.from({ length: 100 }, (_, j) => ({
      timestamp:     new Date(base + j * 1_000).toISOString(),
      span_id:       randomHex(16),
      parent_span_id: null,
      service_name:  'gc-test',
      gen_ai_system: 'openai',
    }));
    await sql`INSERT INTO ${sql(table)} ${sql(rows)}`;
  }

  for (let i = 0; i < 10; i++) {
    await sql`SELECT * FROM ${sql(table)}`;
  }

  if (typeof Bun.gc === 'function') Bun.gc(true);
  const before = heapMB();

  for (let i = 0; i < 500; i++) {
    // Result is intentionally not held — tests that it can be collected
    await sql`SELECT * FROM ${sql(table)}`;
  }

  if (typeof Bun.gc === 'function') Bun.gc(true);
  record('large result set GC', before, heapMB());
  await dropTable(table);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Memory regression  (threshold: ${THRESHOLD_MB} MB per scenario)`);

  try {
    await scenario1();
    await scenario2();
    await scenario3();
  } finally {
    sql.close();
  }

  console.log('\n── Summary ──────────────────────────────────────────────────────');
  let allPass = true;
  for (const r of results) {
    const sign = r.delta >= 0 ? '+' : '';
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}: ${sign}${r.delta.toFixed(1)} MB`);
    if (!r.pass) allPass = false;
  }
  console.log('─────────────────────────────────────────────────────────────────');

  if (!allPass) {
    console.error('\nFAIL: one or more scenarios exceeded the memory growth threshold.');
    process.exit(1);
  }
  console.log('\nAll scenarios within threshold.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
