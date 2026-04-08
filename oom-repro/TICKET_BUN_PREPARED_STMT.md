# Bug: `Bun.SQL` bulk-insert rows with nullable columns causes database to crash

**Repository:** oven-sh/bun  
**Bun version:** 1.3.11 (macOS arm64)  
**Platform:** macOS 25.2.0 arm64  
**Affects:** PostgreSQL and MySQL protocols  
**Severity:** Critical — causes unbounded server-side memory growth and database crash

---

## Summary

Using `Bun.SQL` to bulk-insert rows that contain nullable columns causes the database to crash with an out-of-memory error. The application shows no errors and appears to be working normally the entire time — inserts succeed and rows are written — but the database server silently accumulates gigabytes of memory until it crashes.

We reproduced a complete OOM crash after inserting ~20,000 rows across 200 batches into a table with 6 nullable columns.

---

## Reproduction

```ts
// repro.ts — requires PostgreSQL
// docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
// bun repro.ts

import { SQL } from 'bun';
const sql = new SQL('postgres://postgres:test@localhost:5432/postgres', {
  max: 1, ssl: false,
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
console.log('  prepared statements:', s1.length, '(expected 1)');
// → 2  (stabilises at 2^(nullable cols) — bounded but still wrong)

await sql`TRUNCATE repro`;

// ── Test 2: sql(rows) 2-row batch, which row is null alternates ──────────
for (let i = 0; i < 20; i++) {
  const rows = i % 2 === 0
    ? [{ id: i*2,   note: 'hello' }, { id: i*2+1, note: null  }]
    : [{ id: i*2,   note: null    }, { id: i*2+1, note: 'hi'  }];
  await sql`INSERT INTO repro ${sql(rows)}`;
}
const s2 = await sql`
  SELECT name FROM pg_prepared_statements
  WHERE statement LIKE 'INSERT INTO repro%'
`;
console.log('\nTest 2 — sql(rows) 2-row batch, null position alternates');
console.log('  prepared statements:', s2.length, '(expected 1)');
// → 4  (grows with each batch — unbounded in production)

await sql.end();
```

**Output:**

```
Test 1 — single-row, alternating null
  prepared statements: 2 (expected 1)

Test 2 — sql(rows) 2-row batch, null position alternates
  prepared statements: 4 (expected 1)
```

---

## Observed crash

We hit this with an OpenTelemetry spans table (28 columns, 6+ nullable) inserting 100-row batches via `sql(rows)`. The insert loop runs without any client-side errors — rows are written successfully — but the database server (GreptimeDB) steadily grows in memory and eventually crashes with OOM.

Wire capture explains why: despite the SQL being identical on every batch, Bun sends a brand-new `COM_STMT_PREPARE` for every single batch:

```
COM_STMT_PREPARE #1   INSERT INTO spans (tenant_id, ...) VALUES(?, ?, ...)
COM_STMT_PREPARE #2   INSERT INTO spans (tenant_id, ...) VALUES(?, ?, ...)   ← identical SQL
COM_STMT_PREPARE #3   INSERT INTO spans (tenant_id, ...) VALUES(?, ?, ...)
...
COM_STMT_PREPARE #181 INSERT INTO spans (...)
```

181 batches → 181 distinct named prepared statements → ~4 GB retained server memory → crash.

---

## Expected behaviour

A single `Parse` / `COM_STMT_PREPARE` is sent when the INSERT SQL is first executed. All subsequent batches reuse the cached statement ID and only send `Bind` / `COM_STMT_EXECUTE` with the actual parameter values.

---

## Root cause

`Bun.SQL` includes the null/non-null type of each parameter in the prepared statement cache key. Bun constructs the statement name by appending a type-suffix to the SQL string:

```
"INSERT INTO repro VALUES ($1, $2).int4.text"   ← note = string
"INSERT INTO repro VALUES ($1, $2).int4.null"   ← note = null
```

These hash to different cache keys, so Bun sends a new `Parse` / `COM_STMT_PREPARE` for each distinct null-pattern. The SQL text is **identical** in both cases; only the runtime value differs.

For `sql(rows)` with a 100-row batch and K nullable columns, there are up to 2^(100×K) distinct null-pattern combinations. With any realistic data distribution the probability of two consecutive batches sharing the same pattern is essentially zero — **every batch re-prepares**.

The correct fix is to key the cache **only on the SQL text**. The null/non-null distinction belongs in the `Bind` / `COM_STMT_EXECUTE` message, not in `Parse` / `COM_STMT_PREPARE`.

---

## Workaround

Use the `mysql2` / `pg` npm packages instead of `Bun.SQL`. Both key their prepared statement cache on SQL text only and do not re-prepare when nullability changes.

---

## Notes

- Affects both the PostgreSQL and MySQL protocol paths in Bun.SQL.
- Verified on Bun 1.3.11, macOS arm64.
- Single-row inserts are also affected but stabilise at 2^(nullable cols) cached statements (usually just 2–4), so the impact is bounded and unlikely to cause a crash.
- `sql(rows)` is the critical path: batch size × nullable columns makes unbounded growth essentially guaranteed in any real insert workload.
