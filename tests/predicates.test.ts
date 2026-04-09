import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSpansTable, createIndexedSpansTable, dropTable, spanRow, uniqueSuffix, randomHex, ts } from './helpers.ts';

const TABLE   = `test_spans_${uniqueSuffix()}`;
const INDEXED = `test_spans_idx_${uniqueSuffix()}`;
const MARKER  = randomHex(8);

beforeAll(async () => {
  await createSpansTable(TABLE);
  await createIndexedSpansTable(INDEXED);

  // Seed TABLE with known data
  const rows = [
    spanRow({ service_name: `pred-${MARKER}`, gen_ai_system: 'openai',    parent_span_id: null,           span_name: 'openai.gpt-4o.chat',       gen_ai_input_tokens: 100, timestamp: ts(-6000) }),
    spanRow({ service_name: `pred-${MARKER}`, gen_ai_system: 'anthropic', parent_span_id: null,           span_name: 'anthropic.claude.chat',    gen_ai_input_tokens: 200, timestamp: ts(-5999) }),
    spanRow({ service_name: `pred-${MARKER}`, gen_ai_system: 'google',    parent_span_id: randomHex(16), span_name: 'google.gemini.search',     gen_ai_input_tokens: 300, timestamp: ts(-5998) }),
    spanRow({ service_name: `pred-${MARKER}`, gen_ai_system: 'cohere',    parent_span_id: randomHex(16), span_name: 'cohere.command.generate',  gen_ai_input_tokens: null, timestamp: ts(-5997) }),
    spanRow({ service_name: `pred-${MARKER}`, gen_ai_system: 'mistral',   parent_span_id: randomHex(16), span_name: 'mistral.large.complete',   gen_ai_input_tokens: null, timestamp: ts(-5996) }),
  ];
  await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;
}, 20_000);

afterAll(async () => {
  await dropTable(TABLE);
  await dropTable(INDEXED);
});

describe('IS NULL / IS NOT NULL', () => {
  test('IS NULL returns only rows where field is null', async () => {
    const rows = await sql`
      SELECT gen_ai_system FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND parent_span_id IS NULL
      ORDER BY "timestamp"
    `;
    const systems = rows.map((r: Record<string, unknown>) => r.gen_ai_system);
    expect(systems).toEqual(['openai', 'anthropic']);
  });

  test('IS NOT NULL returns only rows where field is set', async () => {
    const rows = await sql`
      SELECT gen_ai_system FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND parent_span_id IS NOT NULL
      ORDER BY "timestamp"
    `;
    const systems = rows.map((r: Record<string, unknown>) => r.gen_ai_system);
    expect(systems).toEqual(['google', 'cohere', 'mistral']);
  });

  test('IS NULL on integer column with null values', async () => {
    const rows = await sql`
      SELECT gen_ai_system FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND gen_ai_input_tokens IS NULL
      ORDER BY "timestamp"
    `;
    const systems = rows.map((r: Record<string, unknown>) => r.gen_ai_system);
    expect(systems).toEqual(['cohere', 'mistral']);
  });
});

describe('IN / NOT IN', () => {
  test('IN matches all listed values', async () => {
    const rows = await sql`
      SELECT gen_ai_system FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND gen_ai_system IN ('openai', 'anthropic')
      ORDER BY "timestamp"
    `;
    expect(rows.length).toBe(2);
    const systems = rows.map((r: Record<string, unknown>) => r.gen_ai_system);
    expect(systems).toContain('openai');
    expect(systems).toContain('anthropic');
  });

  test('NOT IN excludes listed values', async () => {
    const rows = await sql`
      SELECT gen_ai_system FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND gen_ai_system NOT IN ('openai', 'anthropic')
      ORDER BY "timestamp"
    `;
    const systems = rows.map((r: Record<string, unknown>) => r.gen_ai_system);
    expect(systems).not.toContain('openai');
    expect(systems).not.toContain('anthropic');
    expect(systems.length).toBe(3);
  });

  test('IN with a single value', async () => {
    const rows = await sql`
      SELECT gen_ai_system FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND gen_ai_system IN ('google')
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].gen_ai_system).toBe('google');
  });
});

describe('BETWEEN', () => {
  test('BETWEEN on timestamp is inclusive on both ends', async () => {
    const marker2 = randomHex(8);
    const t1 = ts(-7000);
    const t2 = ts(-7000 + 2000); // 2 seconds later
    const rows = [
      spanRow({ service_name: `btw-${marker2}`, timestamp: new Date(t1.getTime() - 1) }), // just before
      spanRow({ service_name: `btw-${marker2}`, timestamp: t1 }),                          // at t1 — included
      spanRow({ service_name: `btw-${marker2}`, timestamp: ts(-7000 + 1000) }),             // between — included
      spanRow({ service_name: `btw-${marker2}`, timestamp: t2 }),                          // at t2 — included
      spanRow({ service_name: `btw-${marker2}`, timestamp: new Date(t2.getTime() + 1) }), // just after
    ];
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'btw-' + marker2}
        AND "timestamp" BETWEEN ${t1.toISOString()} AND ${t2.toISOString()}
    `;
    expect(Number(result[0].c)).toBe(3);
  });

  test('BETWEEN on integer column', async () => {
    const rows = await sql`
      SELECT gen_ai_system FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND gen_ai_input_tokens BETWEEN 100 AND 200
      ORDER BY "timestamp"
    `;
    const systems = rows.map((r: Record<string, unknown>) => r.gen_ai_system);
    expect(systems).toContain('openai');
    expect(systems).toContain('anthropic');
    expect(systems).not.toContain('google'); // 300 is outside range
  });
});

describe('LIKE', () => {
  test("LIKE 'prefix%' — prefix match", async () => {
    const rows = await sql`
      SELECT span_name FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND span_name LIKE 'openai%'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].span_name).toBe('openai.gpt-4o.chat');
  });

  test("LIKE '%suffix' — suffix match", async () => {
    const rows = await sql`
      SELECT span_name FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND span_name LIKE '%chat'
    `;
    expect(rows.length).toBe(2);
    const names = rows.map((r: Record<string, unknown>) => r.span_name);
    expect(names).toContain('openai.gpt-4o.chat');
    expect(names).toContain('anthropic.claude.chat');
  });

  test("LIKE '%middle%' — substring match", async () => {
    const rows = await sql`
      SELECT span_name FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND span_name LIKE '%gpt%'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].span_name).toBe('openai.gpt-4o.chat');
  });

  test('LIKE with no matches returns empty result', async () => {
    const rows = await sql`
      SELECT span_name FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
        AND span_name LIKE 'zzz%'
    `;
    expect(rows.length).toBe(0);
  });
});

describe('CASE expression', () => {
  test('CASE WHEN in SELECT computes correct labels', async () => {
    const rows = await sql`
      SELECT
        gen_ai_system,
        CASE
          WHEN gen_ai_input_tokens IS NULL   THEN 'unknown'
          WHEN gen_ai_input_tokens < 150     THEN 'small'
          WHEN gen_ai_input_tokens < 250     THEN 'medium'
          ELSE                                    'large'
        END AS size_label
      FROM ${sql(TABLE)}
      WHERE service_name = ${'pred-' + MARKER}
      ORDER BY "timestamp"
    `;

    const map = Object.fromEntries(rows.map((r: Record<string, unknown>) => [r.gen_ai_system, r.size_label]));
    expect(map['openai']).toBe('small');
    expect(map['anthropic']).toBe('medium');
    expect(map['google']).toBe('large');
    expect(map['cohere']).toBe('unknown');
    expect(map['mistral']).toBe('unknown');
  });
});

describe('string functions', () => {
  test('LENGTH() returns character count', async () => {
    const row = spanRow({ span_name: 'hello' });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT LENGTH(span_name) AS len FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(Number(r.len)).toBe(5);
  });

  test('LOWER() normalises to lowercase', async () => {
    const row = spanRow({ gen_ai_system: 'OpenAI' });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT LOWER(gen_ai_system) AS s FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(r.s).toBe('openai');
  });

  test('CONCAT() joins strings', async () => {
    const row = spanRow({ service_name: 'svc', span_kind: 'CLIENT' });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [r] = await sql`
      SELECT CONCAT(service_name, '-', span_kind) AS combined FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(r.combined).toBe('svc-CLIENT');
  });

  test('LENGTH() in WHERE clause filters by string length', async () => {
    const marker3 = randomHex(8);
    const short = spanRow({ service_name: `len-${marker3}`, span_name: 'abc',      timestamp: ts(-8000) });
    const long  = spanRow({ service_name: `len-${marker3}`, span_name: 'abcdefgh', timestamp: ts(-7999) });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([short, long])}`;

    const rows = await sql`
      SELECT span_name FROM ${sql(TABLE)}
      WHERE service_name = ${'len-' + marker3}
        AND LENGTH(span_name) > 5
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].span_name).toBe('abcdefgh');
  });
});

describe('index edge cases', () => {
  test('INVERTED INDEX: equality on span_name with special characters', async () => {
    const names = ['svc/endpoint/v1', 'svc.model.chat', 'svc:operation:read'];
    const rows = names.map(n =>
      spanRow({ span_name: n, timestamp: ts(-9000 + names.indexOf(n)) }),
    );
    // Use plain insert to avoid table prefix collision with the indexed table DDL
    await sql`INSERT INTO ${sql(INDEXED)} ${sql(rows.map(r => ({
      timestamp:          r.timestamp,
      trace_id:           r.trace_id,
      span_id:            r.span_id,
      span_name:          r.span_name,
      service_name:       r.service_name,
      gen_ai_system:      r.gen_ai_system,
      gen_ai_input_tokens: r.gen_ai_input_tokens,
    })))}`;

    for (const name of names) {
      const result = await sql`
        SELECT span_id FROM ${sql(INDEXED)}
        WHERE span_name = ${name}
      `;
      expect(result.length).toBe(1);
    }
  });

  test('BLOOM SKIPPING INDEX: trace_id point lookup returns correct row', async () => {
    const traceId = randomHex(32);
    const row = spanRow({ timestamp: ts(-10000) });
    const indexedRow = {
      timestamp:          row.timestamp,
      trace_id:           traceId,
      span_id:            row.span_id,
      span_name:          row.span_name,
      service_name:       row.service_name,
      gen_ai_system:      row.gen_ai_system,
      gen_ai_input_tokens: row.gen_ai_input_tokens,
    };
    await sql`INSERT INTO ${sql(INDEXED)} ${sql([indexedRow])}`;

    const result = await sql`
      SELECT span_id FROM ${sql(INDEXED)}
      WHERE trace_id = ${traceId}
    `;
    expect(result.length).toBe(1);
    expect(result[0].span_id).toBe(row.span_id);
  });

  test('BLOOM SKIPPING INDEX: non-existent trace_id returns empty result', async () => {
    const ghost = randomHex(32);
    const result = await sql`
      SELECT span_id FROM ${sql(INDEXED)}
      WHERE trace_id = ${ghost}
    `;
    expect(result.length).toBe(0);
  });

  test('query combining INVERTED INDEX and BLOOM filter columns', async () => {
    const traceId = randomHex(32);
    const spanName = `combined-${randomHex(8)}`;
    const row = {
      timestamp:          ts(-11000).toISOString(),
      trace_id:           traceId,
      span_id:            randomHex(16),
      span_name:          spanName,
      service_name:       'test-service',
      gen_ai_system:      'openai',
      gen_ai_input_tokens: 50,
    };
    await sql`INSERT INTO ${sql(INDEXED)} ${sql([row])}`;

    const result = await sql`
      SELECT span_id FROM ${sql(INDEXED)}
      WHERE trace_id = ${traceId}
        AND span_name = ${spanName}
    `;
    expect(result.length).toBe(1);
    expect(result[0].span_id).toBe(row.span_id);
  });
});
