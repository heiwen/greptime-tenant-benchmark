import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSpansTable, dropTable, spanRow, uniqueSuffix, randomHex } from './helpers.ts';

const TABLE = `test_spans_${uniqueSuffix()}`;
const MARKER = randomHex(8);

// Fixed base: 2024-06-15 10:00:00 UTC
const BASE = new Date('2024-06-15T10:00:00.000Z');
const msAt = (offsetSec: number) => new Date(BASE.getTime() + offsetSec * 1_000);

beforeAll(async () => {
  await createSpansTable(TABLE);

  // 5 rows per hour for 4 hours (hours 10, 11, 12, 13 UTC)
  // = 20 rows total
  const rows: Record<string, unknown>[] = [];
  for (let hour = 0; hour < 4; hour++) {
    for (let i = 0; i < 5; i++) {
      rows.push(spanRow({
        service_name:        `dt-${MARKER}`,
        gen_ai_system:       ['openai', 'anthropic', 'google', 'cohere', 'mistral'][i],
        gen_ai_input_tokens: (hour + 1) * 10 + i,
        timestamp:           msAt(hour * 3600 + i * 60), // spread within each hour
      }));
    }
  }

  await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;
}, 20_000);

afterAll(async () => {
  await dropTable(TABLE);
});

describe('DATE_TRUNC', () => {
  test("DATE_TRUNC('hour') buckets rows into correct hourly bins", async () => {
    const rows = await sql`
      SELECT DATE_TRUNC('hour', ${sql('timestamp')}) AS hour_bucket, COUNT(*) AS c
      FROM ${sql(TABLE)}
      WHERE service_name = ${'dt-' + MARKER}
      GROUP BY hour_bucket
      ORDER BY hour_bucket
    `;

    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(Number(r.c)).toBe(5);
    }

    // First bucket should be 2024-06-15T10:00:00Z
    const firstBucket = new Date(rows[0].hour_bucket as string | Date);
    expect(firstBucket.getUTCHours()).toBe(10);
    expect(firstBucket.getUTCMinutes()).toBe(0);
    expect(firstBucket.getUTCSeconds()).toBe(0);
  });

  test("DATE_TRUNC('day') buckets all rows into one day bucket", async () => {
    const rows = await sql`
      SELECT DATE_TRUNC('day', ${sql('timestamp')}) AS day_bucket, COUNT(*) AS c
      FROM ${sql(TABLE)}
      WHERE service_name = ${'dt-' + MARKER}
      GROUP BY day_bucket
    `;

    expect(rows.length).toBe(1);
    expect(Number(rows[0].c)).toBe(20);

    const dayBucket = new Date(rows[0].day_bucket as string | Date);
    expect(dayBucket.getUTCHours()).toBe(0);
    expect(dayBucket.getUTCMinutes()).toBe(0);
  });

  test("DATE_TRUNC('minute') buckets each row into its own minute", async () => {
    // Each row is 60s apart within each hour, so each has a unique minute
    const rows = await sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('minute', ${sql('timestamp')})) AS buckets
      FROM ${sql(TABLE)}
      WHERE service_name = ${'dt-' + MARKER}
    `;
    expect(Number(rows[0].buckets)).toBe(20);
  });
});

describe('NOW() and INTERVAL arithmetic', () => {
  test("WHERE timestamp > NOW() - INTERVAL '1 hour' excludes old rows", async () => {
    // Rows in TABLE were inserted with timestamps from 2024-06-15 (in the past).
    // They should NOT appear in a query filtering for the last hour relative to now.
    const rows = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'dt-' + MARKER}
        AND ${sql('timestamp')} > NOW() - INTERVAL '1 hour'
    `;
    expect(Number(rows[0].c)).toBe(0);
  });

  test('NOW() returns a timestamp close to the current time', async () => {
    const before = Date.now();
    const rows = await sql`SELECT NOW() AS n FROM ${sql(TABLE)} WHERE service_name = ${'dt-' + MARKER} LIMIT 1`;
    const after = Date.now();

    const dbNow = new Date(rows[0].n as string | Date).getTime();
    // DB clock within 10s of test clock
    expect(dbNow).toBeGreaterThan(before - 10_000);
    expect(dbNow).toBeLessThan(after + 10_000);
  });

  test("INTERVAL '30 minutes' added to a timestamp", async () => {
    const row = spanRow({ service_name: `interval-${MARKER}`, timestamp: BASE });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT ${sql('timestamp')} + INTERVAL '30 minutes' AS shifted
      FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;

    const shifted = new Date(r.shifted as string | Date).getTime();
    const expected = BASE.getTime() + 30 * 60 * 1_000;
    expect(Math.abs(shifted - expected)).toBeLessThan(2_000);
  });
});

describe('EXTRACT', () => {
  test('EXTRACT(EPOCH FROM timestamp) returns Unix seconds', async () => {
    const t = new Date('2024-01-01T00:00:00.000Z');
    const expectedEpoch = t.getTime() / 1_000;

    const row = spanRow({ timestamp: t });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT EXTRACT(EPOCH FROM ${sql('timestamp')}) AS ep
      FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect(Number(r.ep)).toBeCloseTo(expectedEpoch, 0);
  });

  test('EXTRACT(hour FROM timestamp) returns the hour component', async () => {
    const row = spanRow({ timestamp: new Date('2024-06-15T14:30:00.000Z') });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT EXTRACT(hour FROM ${sql('timestamp')}) AS h
      FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect(Number(r.h)).toBe(14);
  });
});

describe('time histogram (DATE_TRUNC + GROUP BY + aggregates)', () => {
  test('canonical time histogram returns correct counts per hour', async () => {
    // The seeded dataset has 5 rows per hour for 4 hours
    const rows = await sql`
      SELECT
        DATE_TRUNC('hour', ${sql('timestamp')}) AS hour_bucket,
        COUNT(*) AS row_count,
        SUM(gen_ai_input_tokens) AS total_tokens
      FROM ${sql(TABLE)}
      WHERE service_name = ${'dt-' + MARKER}
      GROUP BY hour_bucket
      ORDER BY hour_bucket ASC
    `;

    expect(rows.length).toBe(4);

    for (let i = 0; i < 4; i++) {
      expect(Number(rows[i].row_count)).toBe(5);
      // tokens for hour i: (i+1)*10+0, (i+1)*10+1, ..., (i+1)*10+4 = 5*(i+1)*10 + 10 = 50*(i+1)+10
      const expectedTokens = 5 * (i + 1) * 10 + (0 + 1 + 2 + 3 + 4);
      expect(Number(rows[i].total_tokens)).toBe(expectedTokens);
    }
  });

  test('time histogram with WHERE on time range returns subset of buckets', async () => {
    // Only query hours 10 and 11
    const from = msAt(0);         // 10:00:00
    const to   = msAt(2 * 3600);  // 12:00:00

    const rows = await sql`
      SELECT DATE_TRUNC('hour', ${sql('timestamp')}) AS hour_bucket, COUNT(*) AS c
      FROM ${sql(TABLE)}
      WHERE service_name = ${'dt-' + MARKER}
        AND ${sql('timestamp')} >= ${from.toISOString()}
        AND ${sql('timestamp')} < ${to.toISOString()}
      GROUP BY hour_bucket
      ORDER BY hour_bucket
    `;

    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(Number(r.c)).toBe(5);
    }
  });
});
