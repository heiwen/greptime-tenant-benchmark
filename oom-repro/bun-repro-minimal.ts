/**
 * Minimal reproduction of Bun.SQL prepared-statement cache miss when
 * parameter nullability changes between executions.
 *
 * Expected: 1 named prepared statement re-used for all executions.
 * Actual:   a new named prepared statement per distinct null-pattern.
 *           For sql(rows) bulk inserts this means a new Parse per batch.
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

// ── Test 1: single-row insert, `note` alternates null / non-null ─────────

for (let i = 0; i < 20; i++) {
  const note = i % 2 === 0 ? 'hello' : null;
  await sql`INSERT INTO repro VALUES (${i}, ${note})`;
}

const s1 = await sql`
  SELECT name FROM pg_prepared_statements
  WHERE statement LIKE 'INSERT INTO repro%'
`;
console.log('Test 1 — single-row, alternating null');
console.log(`  prepared statements: ${s1.length} (expected 1)`);
// Prints 2 — one cached per null-pattern; stabilises at 2^(nullable cols)

await sql`TRUNCATE repro`;

// ── Test 2: sql(rows) 2-row batch, which row is null alternates ──────────

for (let i = 0; i < 20; i++) {
  const rows = i % 2 === 0
    ? [{ id: i * 2,     note: 'hello' }, { id: i * 2 + 1, note: null  }]
    : [{ id: i * 2,     note: null    }, { id: i * 2 + 1, note: 'hi'  }];
  await sql`INSERT INTO repro ${sql(rows)}`;
}

const s2 = await sql`
  SELECT name FROM pg_prepared_statements
  WHERE statement LIKE 'INSERT INTO repro%'
`;
console.log('\nTest 2 — sql(rows) 2-row batch, null position alternates');
console.log(`  prepared statements: ${s2.length} (expected 1)`);
// Prints 4 — for real 100-row batches with multiple nullable columns,
// the number equals the number of batches (cache never hits).

await sql.end();
