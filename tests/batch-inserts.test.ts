import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSpansTable, dropTable, spanRow, uniqueSuffix, countRows, randomHex, ts } from './helpers.ts';

const TABLE = `test_spans_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(TABLE);
});

afterAll(async () => {
  await dropTable(TABLE);
});

describe('batch insert patterns', () => {
  test('single row insert is retrievable', async () => {
    const row = spanRow();
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(rows.length).toBe(1);
  });

  test('10 rows — all retrieved', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 10 }, (_, i) =>
      spanRow({ service_name: `batch-10-${marker}`, timestamp: ts(-100 + i) }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'batch-10-' + marker}
    `;
    expect(Number(result[0].c)).toBe(10);
  });

  test('100 rows — all retrieved', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 100 }, (_, i) =>
      spanRow({ service_name: `batch-100-${marker}`, timestamp: ts(-200 + i) }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'batch-100-' + marker}
    `;
    expect(Number(result[0].c)).toBe(100);
  });

  test('500 rows — all retrieved', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 500 }, (_, i) =>
      spanRow({ service_name: `batch-500-${marker}`, timestamp: ts(-600 + i) }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'batch-500-' + marker}
    `;
    expect(Number(result[0].c)).toBe(500);
  }, 30_000);

  test('all rows have parent_span_id = NULL — no rows dropped', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 20 }, (_, i) =>
      spanRow({ service_name: `all-null-${marker}`, parent_span_id: null, timestamp: ts(-300 + i) }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'all-null-' + marker}
    `;
    expect(Number(result[0].c)).toBe(20);
  });

  test('all rows have parent_span_id set — no rows dropped', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 20 }, (_, i) =>
      spanRow({ service_name: `all-set-${marker}`, parent_span_id: randomHex(16), timestamp: ts(-400 + i) }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'all-set-' + marker}
    `;
    expect(Number(result[0].c)).toBe(20);
  });

  test('alternating NULL/non-NULL parent_span_id — known Bun.SQL bug pattern', async () => {
    // This is the exact pattern that caused the prepared-statement cache OOM.
    // With prepare:false it should work correctly.
    const marker = randomHex(8);
    const rows = Array.from({ length: 50 }, (_, i) =>
      spanRow({
        service_name:  `alt-null-${marker}`,
        parent_span_id: i % 2 === 0 ? null : randomHex(16),
        timestamp:      ts(-500 + i),
      }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'alt-null-' + marker}
    `;
    expect(Number(result[0].c)).toBe(50);
  });

  test('alternating NULL/non-NULL — null and non-null counts are correct', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 40 }, (_, i) =>
      spanRow({
        service_name:   `alt-counts-${marker}`,
        parent_span_id: i % 2 === 0 ? null : 'deadbeef00000001',
        timestamp:       ts(-700 + i),
      }),
    );

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const nullCount = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'alt-counts-' + marker}
        AND parent_span_id IS NULL
    `;
    const nonNullCount = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'alt-counts-' + marker}
        AND parent_span_id IS NOT NULL
    `;

    expect(Number(nullCount[0].c)).toBe(20);
    expect(Number(nonNullCount[0].c)).toBe(20);
  });

  test('rows with varied multi-column null patterns within a batch', async () => {
    // Some rows have span_status_message set, some have service_name set,
    // some have both, some have neither. All should be stored correctly.
    const marker = randomHex(8);
    const spanId1 = randomHex(16);
    const spanId2 = randomHex(16);
    const spanId3 = randomHex(16);
    const spanId4 = randomHex(16);

    const rows = [
      spanRow({ span_id: spanId1, service_name: `varied-${marker}`, span_status_message: null,     gen_ai_system: null,      timestamp: ts(-800) }),
      spanRow({ span_id: spanId2, service_name: `varied-${marker}`, span_status_message: 'error',  gen_ai_system: null,      timestamp: ts(-801) }),
      spanRow({ span_id: spanId3, service_name: `varied-${marker}`, span_status_message: null,     gen_ai_system: 'openai',  timestamp: ts(-802) }),
      spanRow({ span_id: spanId4, service_name: `varied-${marker}`, span_status_message: 'retry',  gen_ai_system: 'anthropic', timestamp: ts(-803) }),
    ];

    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const results = await sql`
      SELECT span_id, span_status_message, gen_ai_system
      FROM ${sql(TABLE)}
      WHERE service_name = ${'varied-' + marker}
      ORDER BY "timestamp" DESC
    `;

    expect(results.length).toBe(4);
    const byId = Object.fromEntries(results.map((r: Record<string, unknown>) => [r.span_id, r]));
    expect(byId[spanId1].span_status_message).toBeNull();
    expect(byId[spanId1].gen_ai_system).toBeNull();
    expect(byId[spanId2].span_status_message).toBe('error');
    expect(byId[spanId2].gen_ai_system).toBeNull();
    expect(byId[spanId3].span_status_message).toBeNull();
    expect(byId[spanId3].gen_ai_system).toBe('openai');
    expect(byId[spanId4].span_status_message).toBe('retry');
    expect(byId[spanId4].gen_ai_system).toBe('anthropic');
  });
});
