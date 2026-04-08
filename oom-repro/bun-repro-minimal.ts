/**
 * Minimal reproduction of Bun.SQL prepared-statement cache miss when
 * parameter nullability varies between executions.
 *
 * Expected: 1 named prepared statement re-used for all executions.
 * Actual:   a new named prepared statement per distinct null-pattern.
 *           For sql(rows) bulk inserts with random data this means
 *           1 new Parse per batch — unbounded server-side memory growth.
 *
 * Requires: PostgreSQL running locally.
 *   docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
 *   bun bun-repro-minimal.ts
 */

import { SQL } from 'bun';

const sql = new SQL('postgres://postgres:test@localhost:5432/postgres', {
  max: 1,
  idleTimeout: 30,
  connectionTimeout: 5,
  ssl: false,
});

await sql`DROP TABLE IF EXISTS repro`;
await sql`CREATE TABLE repro (id INT PRIMARY KEY, note TEXT)`;

// ── Test 1: single-row insert, `note` is randomly null ───────────────────
// Shows that even single-row inserts are affected: the cache creates a new
// prepared statement for each distinct null-pattern seen so far.

for (let i = 0; i < 20; i++) {
  const note = Math.random() > 0.5 ? 'hello' : null;
  await sql`INSERT INTO repro VALUES (${i}, ${note})`;
}

const s1 = await sql`
  SELECT name FROM pg_prepared_statements
  WHERE statement LIKE 'INSERT INTO repro%'
`;
console.log('Test 1 — single-row, random null');
console.log(`  prepared statements: ${s1.length} (expected 1)`);
// Prints 2 — stabilises at 2^(nullable cols), so bounded for single-row inserts.

await sql`TRUNCATE repro`;

// ── Test 2: sql(rows) 5-row batch with random nullable field ─────────────
// Each batch has a random combination of null/non-null across 5 rows.
// There are 2^5 = 32 possible null-patterns; with truly random data every
// batch in practice produces a new pattern → 1 new prepared statement per batch.

const countPerBatch: number[] = [];

for (let i = 0; i < 20; i++) {
  const rows = Array.from({ length: 5 }, (_, j) => ({
    id: i * 5 + j,
    note: Math.random() > 0.5 ? 'hello' : null,
  }));
  await sql`INSERT INTO repro ${sql(rows)}`;

  const snap = await sql`
    SELECT count(*)::int AS n FROM pg_prepared_statements
    WHERE statement LIKE 'INSERT INTO repro%'
  `;
  countPerBatch.push(Number(snap[0].n));
}

const s2 = await sql`
  SELECT name FROM pg_prepared_statements
  WHERE statement LIKE 'INSERT INTO repro%'
`;
console.log('\nTest 2 — sql(rows) 5-row batch, random nulls');
console.log(`  prepared statements after 20 batches: ${s2.length} (expected 1)`);
console.log(`  count after each batch: ${countPerBatch.join(', ')}`);
// Prints ~15–20 — grows roughly linearly with each batch.
// With 100-row batches (2^100 possible patterns) it is exactly 1 per batch.

await sql.end();
