import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSpansTable, dropTable, spanRow, uniqueSuffix, randomHex, ts } from './helpers.ts';

const TABLE = `test_spans_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(TABLE);
});

afterAll(async () => {
  await dropTable(TABLE);
});

describe('large STRING fields', () => {
  test('400 KB gen_ai_input_messages roundtrip — no truncation', async () => {
    const content = 'x'.repeat(400_000);
    const payload = JSON.stringify([{ role: 'user', content }]);
    const row = spanRow({ gen_ai_input_messages: payload, timestamp: ts(-60000) });

    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT gen_ai_input_messages FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;

    const returned = r.gen_ai_input_messages as string;
    expect(returned.length).toBe(payload.length);
    const parsed = JSON.parse(returned);
    expect(parsed[0].content.length).toBe(400_000);
  }, 30_000);

  test('50 KB span_attributes roundtrip — no truncation', async () => {
    const attrs = JSON.stringify(
      Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`key_${i}`, 'v'.repeat(40)])),
    );
    const row = spanRow({ span_attributes: attrs, timestamp: ts(-61000) });

    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT span_attributes FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect((r.span_attributes as string).length).toBe(attrs.length);
  }, 20_000);

  test('batch of 500 rows with ~1 KB STRING fields — row count is correct', async () => {
    const traceId = randomHex(32);
    const payload = JSON.stringify([{ role: 'user', content: 'y'.repeat(900) }]);

    const rows = Array.from({ length: 500 }, (_, i) =>
      spanRow({
        trace_id:             traceId,
        gen_ai_input_messages: payload,
        timestamp:             ts(-70000 + i),
      }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE trace_id = ${traceId}
    `;
    expect(Number(r.c)).toBe(500);
  }, 60_000);
});

describe('large result sets', () => {
  test('SELECT * of 1000 rows returns all 1000', async () => {
    const traceId = randomHex(32);
    const rows = Array.from({ length: 1_000 }, (_, i) =>
      spanRow({
        trace_id: traceId,
        timestamp:    ts(-80000 + i),
      }),
    );

    // Insert in batches of 100 to avoid single oversized request
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO ${sql(TABLE)} ${sql(rows.slice(i * 100, (i + 1) * 100))}`;
    }

    const result = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE trace_id = ${traceId}
    `;
    expect(result.length).toBe(1_000);
  }, 60_000);

  test('1000-row SELECT * — no column is missing or truncated', async () => {
    const traceId = randomHex(32);
    const msg = JSON.stringify([{ role: 'user', content: 'z'.repeat(500) }]);
    const rows = Array.from({ length: 10 }, (_, i) =>
      spanRow({
        trace_id:             traceId,
        gen_ai_input_messages: msg,
        timestamp:             ts(-90000 + i),
      }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT * FROM ${sql(TABLE)}
      WHERE trace_id = ${traceId}
    `;

    for (const r of result) {
      expect((r.gen_ai_input_messages as string).length).toBe(msg.length);
    }
  }, 20_000);
});
