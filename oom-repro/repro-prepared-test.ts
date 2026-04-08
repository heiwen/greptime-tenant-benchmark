/**
 * Determines whether Bun.SQL's re-prepare behavior is specific to the
 * sql(rows) fragment helper or affects all prepared statement types.
 *
 * Run with a TCP proxy intercepting the wire:
 *   bun oom-repro/proxy-mysql.js &  # or proxy-pg.js for PostgreSQL
 *   bun oom-repro/repro-prepared-test.ts [mysql|pg]
 *
 * Observe the proxy output for PREPARE counts per test.
 */

import { SQL } from 'bun';

const protocol = Bun.argv[2] ?? 'mysql';
const ITERATIONS = 20;

let sql: InstanceType<typeof SQL>;

if (protocol === 'mysql') {
  // Connect through the proxy (port 4003 → proxy → 4002)
  sql = new SQL('mysql://greptime@localhost:4003/public', {
    max: 5,          // small pool; single connection preferred but 1 causes issues on some servers
    idleTimeout: 60,
    connectionTimeout: 10,
    ssl: false,
  });
} else {
  // Connect through the proxy (port 5435 → proxy → 5433)
  sql = new SQL('postgres://greptime@localhost:5435/public', {
    max: 5,
    idleTimeout: 60,
    connectionTimeout: 10,
    ssl: false,
  });
}

// ---------- setup ----------

await sql.unsafe('DROP TABLE IF EXISTS prep_test');

if (protocol === 'mysql') {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS prep_test (
      row_id   INT NOT NULL,
      row_name VARCHAR(64),
      row_val  DOUBLE,
      \`ts\`   TIMESTAMP(6) NOT NULL TIME INDEX,
      PRIMARY KEY (row_id)
    ) WITH ('append_mode' = 'true')
  `);
} else {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS prep_test (
      row_id   INT NOT NULL,
      row_name VARCHAR(64),
      row_val  DOUBLE PRECISION,
      ts       TIMESTAMP(9) NOT NULL TIME INDEX,
      PRIMARY KEY (row_id)
    ) WITH ('append_mode' = 'true')
  `);
}

console.log('Table ready.');

// ---------- helpers ----------

function makeRows(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    row_id: offset + i,
    row_name: `row-${offset + i}`,
    row_val: Math.random() * 100,
    ts: new Date(),
  }));
}

// ---------- Test A: sql(rows) fragment — known to re-prepare ----------

console.log(`\n=== Test A: sql(rows) fragment — ${ITERATIONS} iterations ===`);
console.log('Expect: 1 PREPARE per iteration (re-prepares every time) [KNOWN BUG]');
for (let i = 0; i < ITERATIONS; i++) {
  const rows = makeRows(5, i * 1000 + 0);
  await sql`INSERT INTO prep_test ${sql(rows)}`;
}
console.log('Test A done. Check proxy PREPARE count above.');
await Bun.sleep(500); // let proxy flush output

// ---------- Test B: regular parameterized single-row insert ----------

console.log(`\n=== Test B: regular parameterized single-row insert — ${ITERATIONS} iterations ===`);
console.log('Expect: 1 PREPARE total (reused across iterations) if Bun caches correctly');
for (let i = 0; i < ITERATIONS; i++) {
  const row_id = 100_000 + i;
  const row_name = `row-${row_id}`;
  const row_val = Math.random() * 100;
  const ts = new Date();
  await sql`INSERT INTO prep_test (row_id, row_name, row_val, ts) VALUES (${row_id}, ${row_name}, ${row_val}, ${ts})`;
}
console.log('Test B done. Check proxy PREPARE count above.');
await Bun.sleep(500);

// ---------- Test C: simple SELECT (read-only, no insert complexity) ----------

console.log(`\n=== Test C: simple SELECT with parameter — ${ITERATIONS} iterations ===`);
console.log('Expect: 1 PREPARE total (reused) if Bun caches correctly');
for (let i = 0; i < ITERATIONS; i++) {
  const x = `hello-${i}`;
  if (protocol === 'mysql') {
    await sql`SELECT ${x} AS val`;
  } else {
    await sql`SELECT ${x}::text AS val`;
  }
}
console.log('Test C done. Check proxy PREPARE count above.');
await Bun.sleep(500);

// ---------- summary ----------

console.log('\n=== Done. Summary ===');
console.log('Review proxy output above for PREPARE counts:');
console.log('  Test A (sql(rows)):      PREPARE count =', ITERATIONS, 'means re-prepare every time (bug)');
console.log('  Test B (single-row):     PREPARE count = 1 means caching works; > 1 means universal bug');
console.log('  Test C (SELECT):         PREPARE count = 1 means caching works; > 1 means universal bug');

await sql.end();
