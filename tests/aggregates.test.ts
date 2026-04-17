import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createSpansTable, dropTable, spanRow, uniqueSuffix, randomHex, ts, makePool } from './helpers.ts';

// Own pool: MIN/MAX on integer columns triggers ERR_POSTGRES_UNSUPPORTED_NUMERIC_FORMAT.
// Isolated to avoid corrupting the shared pool used by parallel test files.
const sql = makePool({ max: 5, idleTimeout: 30, connectionTimeout: 15 });

const TABLE = `test_spans_${uniqueSuffix()}`;

// Seed data shared across aggregate tests
const TRACE_ID = randomHex(32);

beforeAll(async () => {
  await createSpansTable(TABLE);

  // Insert a predictable dataset:
  //   20 rows for openai   — gen_ai_input_tokens 100..119
  //   15 rows for anthropic — gen_ai_input_tokens 200..214
  //    5 rows for google    — gen_ai_input_tokens null (to test NULL handling)
  //   parent_span_id: first 10 openai rows are null, rest are set
  const rows = [
    ...Array.from({ length: 20 }, (_, i) =>
      spanRow({
        trace_id:            TRACE_ID,
        gen_ai_system:       'openai',
        gen_ai_input_tokens: 100 + i,
        parent_span_id:      i < 10 ? null : randomHex(16),
        timestamp:           ts(-5000 + i),
      }),
    ),
    ...Array.from({ length: 15 }, (_, i) =>
      spanRow({
        trace_id:            TRACE_ID,
        gen_ai_system:       'anthropic',
        gen_ai_input_tokens: 200 + i,
        parent_span_id:      randomHex(16),
        timestamp:           ts(-4000 + i),
      }),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      spanRow({
        trace_id:            TRACE_ID,
        gen_ai_system:       'google',
        gen_ai_input_tokens: null,
        parent_span_id:      null,
        timestamp:           ts(-3000 + i),
      }),
    ),
  ];

  await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;
}, 30_000);

afterAll(async () => {
  await dropTable(TABLE);
});

describe('COUNT', () => {
  test('COUNT(*) counts all rows including NULLs', async () => {
    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    expect(Number(r.c)).toBe(40);
  });

  test('COUNT(column) excludes NULL values', async () => {
    // gen_ai_input_tokens is null for the 5 google rows
    const [r] = await sql`
      SELECT COUNT(gen_ai_input_tokens) AS c FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    expect(Number(r.c)).toBe(35);
  });

  test('COUNT(*) on empty result set returns 0', async () => {
    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE trace_id = ${randomHex(32)}
    `;
    expect(Number(r.c)).toBe(0);
  });
});

describe('MIN / MAX', () => {
  test('MIN on timestamp returns the oldest row', async () => {
    const [r] = await sql`
      SELECT MIN(${sql('timestamp')}) AS mn FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    expect(r.mn).toBeDefined();
    // oldest row was inserted at ts(-5000)
    const minTime = new Date(r.mn as string | Date).getTime();
    const expectedMin = ts(-5000).getTime();
    expect(Math.abs(minTime - expectedMin)).toBeLessThan(5_000);
  });

  test('MAX on timestamp returns the newest row', async () => {
    const [r] = await sql`
      SELECT MAX(${sql('timestamp')}) AS mx FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    // newest row was inserted at ts(-3004) — approx 30min - 3000s ago
    const maxTime = new Date(r.mx as string | Date).getTime();
    const expectedMax = ts(-3000).getTime();
    expect(Math.abs(maxTime - expectedMax)).toBeLessThan(5_000);
  });

  test('MIN on integer column', async () => {
    const [r] = await sql`
      SELECT MIN(gen_ai_input_tokens) AS mn FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    // NULL rows are excluded; min is 100
    expect(Number(r.mn)).toBe(100);
  });

  test('MAX on integer column', async () => {
    const [r] = await sql`
      SELECT MAX(gen_ai_input_tokens) AS mx FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    // max is 214
    expect(Number(r.mx)).toBe(214);
  });

  test('MIN on all-NULL column returns NULL', async () => {
    // google rows have null tokens; query only google
    const [r] = await sql`
      SELECT MIN(gen_ai_input_tokens) AS mn FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
        AND gen_ai_system = 'google'
    `;
    expect(r.mn).toBeNull();
  });
});

describe('SUM / AVG', () => {
  test('SUM of openai token counts', async () => {
    // 100+101+...+119 = sum of 20 values starting at 100 = 20*100 + (0+1+...+19) = 2000 + 190 = 2190
    const [r] = await sql`
      SELECT SUM(gen_ai_input_tokens) AS s FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
        AND gen_ai_system = 'openai'
    `;
    expect(Number(r.s)).toBe(2190);
  });

  test('AVG of openai token counts', async () => {
    // average of 100..119 = 109.5
    const [r] = await sql`
      SELECT AVG(gen_ai_input_tokens) AS a FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
        AND gen_ai_system = 'openai'
    `;
    expect(Number(r.a)).toBeCloseTo(109.5, 1);
  });

  test('SUM ignores NULLs', async () => {
    const [r] = await sql`
      SELECT SUM(gen_ai_input_tokens) AS s FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    // openai: 2190, anthropic: 200+...+214 = 15*200+(0+...+14)=3000+105=3105, google: null (ignored)
    expect(Number(r.s)).toBe(2190 + 3105);
  });
});

describe('GROUP BY', () => {
  test('GROUP BY gen_ai_system returns one row per system', async () => {
    const rows = await sql`
      SELECT gen_ai_system, COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
      GROUP BY gen_ai_system
      ORDER BY gen_ai_system
    `;

    const map = Object.fromEntries(rows.map((r: Record<string, unknown>) => [r.gen_ai_system, Number(r.c)]));
    expect(map['openai']).toBe(20);
    expect(map['anthropic']).toBe(15);
    expect(map['google']).toBe(5);
  });

  test('GROUP BY with SUM produces correct per-group totals', async () => {
    const rows = await sql`
      SELECT gen_ai_system, SUM(gen_ai_input_tokens) AS s FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
      GROUP BY gen_ai_system
      ORDER BY gen_ai_system
    `;

    const map = Object.fromEntries(rows.map((r: Record<string, unknown>) => [r.gen_ai_system, r.s]));
    expect(Number(map['openai'])).toBe(2190);
    expect(Number(map['anthropic'])).toBe(3105);
    // google has all NULLs — SUM should be NULL or 0
    expect(map['google'] === null || Number(map['google']) === 0).toBe(true);
  });
});

describe('DISTINCT', () => {
  test('DISTINCT on gen_ai_system returns deduplicated values', async () => {
    const rows = await sql`
      SELECT DISTINCT gen_ai_system FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
      ORDER BY gen_ai_system
    `;
    const systems = rows.map((r: Record<string, unknown>) => r.gen_ai_system);
    expect(systems).toEqual(['anthropic', 'google', 'openai']);
  });

  test('DISTINCT on column with NULLs — NULL appears at most once', async () => {
    // parent_span_id: 15 null rows (10 openai + 5 google), rest are distinct hex values
    const rows = await sql`
      SELECT DISTINCT parent_span_id FROM ${sql(TABLE)}
      WHERE trace_id = ${TRACE_ID}
    `;
    const nullRows = rows.filter((r: Record<string, unknown>) => r.parent_span_id === null);
    expect(nullRows.length).toBeLessThanOrEqual(1);
  });
});
