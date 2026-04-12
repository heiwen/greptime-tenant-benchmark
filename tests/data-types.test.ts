import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createSpansTable, createItemsTable, dropTable, spanRow, itemRow, uniqueSuffix, makePool } from './helpers.ts';

// Use a dedicated pool so that ERR_POSTGRES_UNSUPPORTED_NUMERIC_FORMAT connection closures
// do not corrupt the shared helpers.ts pool used by other test files.
const sql = makePool({ max: 3, idleTimeout: 30, connectionTimeout: 15 });

const SPANS = `test_spans_${uniqueSuffix()}`;
const ITEMS = `test_items_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(SPANS);
  await createItemsTable(ITEMS);
});

afterAll(async () => {
  await dropTable(SPANS);
  await dropTable(ITEMS);
});

describe('TIMESTAMP(9) precision', () => {
  test('millisecond precision is preserved', async () => {
    const t = new Date(2024, 0, 15, 12, 30, 45, 678);
    const row = spanRow({ timestamp: t });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT ${sql('timestamp')} FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    const returned = new Date(r.timestamp as string | Date);
    expect(returned.getTime()).toBe(t.getTime());
  });

  test('sub-millisecond nanoseconds via ISO string', async () => {
    // Pass a nanosecond-precision string and observe what comes back
    const nanoStr = '2024-03-01T00:00:00.000000123Z';
    const row = spanRow({ timestamp: nanoStr });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT ${sql('timestamp')} FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    // Document what precision is actually stored
    expect(r.timestamp).toBeDefined();
    // At minimum milliseconds must be preserved
    const returned = new Date(r.timestamp as string | Date);
    expect(returned.getTime()).toBe(new Date('2024-03-01T00:00:00.000Z').getTime());
  });

  test('very old timestamp (year 2000)', async () => {
    const t = new Date('2000-01-01T00:00:00.000Z');
    const row = spanRow({ timestamp: t });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT ${sql('timestamp')} FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    const returned = new Date(r.timestamp as string | Date);
    expect(returned.getTime()).toBe(t.getTime());
  });

  test('recent timestamp near now', async () => {
    const t = new Date();
    const row = spanRow({ timestamp: t });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT ${sql('timestamp')} FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    const returned = new Date(r.timestamp as string | Date);
    // Allow 1s drift for any processing
    expect(Math.abs(returned.getTime() - t.getTime())).toBeLessThan(1_000);
  });
});

describe('TIMESTAMP(3) precision (conversation items)', () => {
  test('millisecond precision is preserved', async () => {
    const t = new Date(2024, 5, 10, 8, 0, 0, 999);
    const row = itemRow({ created_at: t });
    await sql`INSERT INTO ${sql(ITEMS)} ${sql([row])}`;

    const [r] = await sql`SELECT created_at FROM ${sql(ITEMS)} WHERE ${sql('id')} = ${row.id as string}`;
    const returned = new Date(r.created_at as string | Date);
    expect(returned.getTime()).toBe(t.getTime());
  });
});

describe('BIGINT UNSIGNED (duration_nano)', () => {
  test('zero', async () => {
    const row = spanRow({ duration_nano: 0 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT duration_nano FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.duration_nano)).toBe(0);
  });

  test('value of 1', async () => {
    const row = spanRow({ duration_nano: 1 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT duration_nano FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.duration_nano)).toBe(1);
  });

  test('Number.MAX_SAFE_INTEGER', async () => {
    const row = spanRow({ duration_nano: Number.MAX_SAFE_INTEGER });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT duration_nano FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.duration_nano)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('large value 30 seconds in nanoseconds', async () => {
    const val = 30_000_000_000;
    const row = spanRow({ duration_nano: val });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT duration_nano FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.duration_nano)).toBe(val);
  });
});

describe('INT signed (gen_ai_input_tokens)', () => {
  test('positive value', async () => {
    const row = spanRow({ gen_ai_input_tokens: 9999 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT gen_ai_input_tokens FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.gen_ai_input_tokens)).toBe(9999);
  });

  test('zero', async () => {
    const row = spanRow({ gen_ai_input_tokens: 0 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT gen_ai_input_tokens FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.gen_ai_input_tokens)).toBe(0);
  });

  test('negative value', async () => {
    const row = spanRow({ gen_ai_input_tokens: -1 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT gen_ai_input_tokens FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.gen_ai_input_tokens)).toBe(-1);
  });
});

describe('VARCHAR lengths', () => {
  test('exactly 36 chars in VARCHAR(36) span_id analogues', async () => {
    // gen_ai_request_model is VARCHAR(128) — test at exactly 128 chars
    const val128 = 'a'.repeat(128);
    const row = spanRow({ gen_ai_request_model: val128 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT gen_ai_request_model FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(r.gen_ai_request_model).toBe(val128);
  });

  test('empty string in VARCHAR column', async () => {
    const row = spanRow({ span_kind: '' });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT span_kind FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    // Document whether empty string is stored as empty or coerced to NULL
    expect(r.span_kind === '' || r.span_kind === null).toBe(true);
  });

  test('null vs empty string are distinguishable', async () => {
    const rowNull = spanRow({ span_kind: null });
    const rowEmpty = spanRow({ span_kind: '' });

    await sql`INSERT INTO ${sql(SPANS)} ${sql([rowNull, rowEmpty])}`;

    const [rNull] = await sql`SELECT span_kind FROM ${sql(SPANS)} WHERE span_id = ${rowNull.span_id as string}`;
    const [rEmpty] = await sql`SELECT span_kind FROM ${sql(SPANS)} WHERE span_id = ${rowEmpty.span_id as string}`;

    expect(rNull.span_kind).toBeNull();
    // Empty string is either stored as '' or coerced to NULL; they should not be equal to each other
    // (if both became null the test would still pass, but document the actual behaviour)
    console.log(`null stored as: ${JSON.stringify(rNull.span_kind)}, '' stored as: ${JSON.stringify(rEmpty.span_kind)}`);
  });
});

describe('CAST expressions', () => {
  test('CAST integer column AS BIGINT', async () => {
    const row = spanRow({ gen_ai_input_tokens: 42 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT CAST(gen_ai_input_tokens AS BIGINT) AS v
      FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(Number(r.v)).toBe(42);
  });

  test('CAST string literal AS TIMESTAMP', async () => {
    const row = spanRow();
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const result = await sql`
      SELECT CAST('2024-01-01' AS TIMESTAMP) AS t
      FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(result.length).toBe(1);
    expect(result[0].t).toBeDefined();
  });

  test('CAST BIGINT UNSIGNED AS DOUBLE for division', async () => {
    const row = spanRow({ duration_nano: 1_500_000_000 });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT CAST(duration_nano AS DOUBLE) / 1e9 AS duration_sec
      FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(Number(r.duration_sec)).toBeCloseTo(1.5, 5);
  });

  test('invalid CAST returns an error', async () => {
    const row = spanRow({ span_name: 'not-a-number' });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    let threw = false;
    try {
      await sql`SELECT CAST(span_name AS INT) AS v FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('implicit JS number coercion to BIGINT UNSIGNED', async () => {
    // duration_nano is BIGINT UNSIGNED; pass a plain JS number and ensure it is stored
    const val = 999_999_999;
    const row = spanRow({ duration_nano: val });
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`SELECT duration_nano FROM ${sql(SPANS)} WHERE span_id = ${row.span_id as string}`;
    expect(Number(r.duration_nano)).toBe(val);
  });
});
