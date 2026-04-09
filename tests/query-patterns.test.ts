import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { createSpansTable, dropTable, spanRow, uniqueSuffix, randomHex, ts } from './helpers.ts';

// Own pool: SELECT * on spans table triggers ERR_POSTGRES_UNSUPPORTED_NUMERIC_FORMAT.
// Isolated to avoid corrupting the shared pool used by parallel test files.
const sql = new SQL(
  process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public',
  { max: 5, idleTimeout: 30, connectionTimeout: 15, ssl: false, prepare: false },
);

const TABLE = `test_spans_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(TABLE);
});

afterAll(async () => {
  await dropTable(TABLE);
});

describe('time range queries', () => {
  test('WHERE > cutoff is exclusive of the boundary', async () => {
    const marker = randomHex(8);
    const cutoff = ts(-3600); // 1 hour before base
    // Row exactly at cutoff — should NOT be returned by `> cutoff`
    const atCutoff = spanRow({ service_name: `excl-${marker}`, timestamp: cutoff });
    // Row 1 second after cutoff — should be returned
    const afterCutoff = spanRow({ service_name: `excl-${marker}`, timestamp: new Date(cutoff.getTime() + 1_000) });

    await sql`INSERT INTO ${sql(TABLE)} ${sql([atCutoff, afterCutoff])}`;

    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE service_name = ${'excl-' + marker}
        AND "timestamp" > ${cutoff.toISOString()}
    `;

    const ids = rows.map((r: Record<string, unknown>) => r.span_id);
    expect(ids).not.toContain(atCutoff.span_id);
    expect(ids).toContain(afterCutoff.span_id);
  });

  test('empty result when cutoff is in the future', async () => {
    const marker = randomHex(8);
    const row = spanRow({ service_name: `empty-${marker}` });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE service_name = ${'empty-' + marker}
        AND "timestamp" > ${future}
    `;
    expect(rows.length).toBe(0);
  });

  test('LIMIT 50 when exactly 50 rows match returns exactly 50', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 50 }, (_, i) =>
      spanRow({ service_name: `limit50-${marker}`, timestamp: ts(-1000 + i) }),
    );
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE service_name = ${'limit50-' + marker}
      LIMIT 50
    `;
    expect(result.length).toBe(50);
  });

  test('LIMIT 50 with 100 matching rows returns exactly 50', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 100 }, (_, i) =>
      spanRow({ service_name: `limit100-${marker}`, timestamp: ts(-2000 + i) }),
    );
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE service_name = ${'limit100-' + marker}
      LIMIT 50
    `;
    expect(result.length).toBe(50);
  });
});

describe('ORDER BY', () => {
  test('ORDER BY timestamp DESC returns newest first', async () => {
    const marker = randomHex(8);
    const rows = [
      spanRow({ service_name: `order-${marker}`, timestamp: ts(-300) }),
      spanRow({ service_name: `order-${marker}`, timestamp: ts(-100) }),
      spanRow({ service_name: `order-${marker}`, timestamp: ts(-200) }),
    ];
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT "timestamp" FROM ${sql(TABLE)}
      WHERE service_name = ${'order-' + marker}
      ORDER BY "timestamp" DESC
    `;

    const times = result.map((r: Record<string, unknown>) => new Date(r.timestamp as string | Date).getTime());
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
  });

  test('ORDER BY timestamp ASC returns oldest first', async () => {
    const marker = randomHex(8);
    const rows = [
      spanRow({ service_name: `asc-${marker}`, timestamp: ts(-300) }),
      spanRow({ service_name: `asc-${marker}`, timestamp: ts(-100) }),
      spanRow({ service_name: `asc-${marker}`, timestamp: ts(-200) }),
    ];
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT "timestamp" FROM ${sql(TABLE)}
      WHERE service_name = ${'asc-' + marker}
      ORDER BY "timestamp" ASC
    `;

    const times = result.map((r: Record<string, unknown>) => new Date(r.timestamp as string | Date).getTime());
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
  });

  test('ORDER BY two columns DESC/ASC', async () => {
    const marker = randomHex(8);
    const sharedTs = ts(-500);
    const rows = [
      spanRow({ service_name: `2col-${marker}`, timestamp: sharedTs, span_id: 'fff0000000000001', gen_ai_input_tokens: 10 }),
      spanRow({ service_name: `2col-${marker}`, timestamp: sharedTs, span_id: 'aaa0000000000001', gen_ai_input_tokens: 20 }),
      spanRow({ service_name: `2col-${marker}`, timestamp: ts(-600),  span_id: 'bbb0000000000001', gen_ai_input_tokens: 30 }),
    ];
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const result = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE service_name = ${'2col-' + marker}
      ORDER BY "timestamp" DESC, span_id ASC
    `;

    // The two rows at sharedTs should come first, ordered span_id ASC
    expect(result[0].span_id).toBe('aaa0000000000001');
    expect(result[1].span_id).toBe('fff0000000000001');
    // Then the older row
    expect(result[2].span_id).toBe('bbb0000000000001');
  });

  test('tied timestamps: ORDER BY timestamp DESC, span_id DESC is stable across runs', async () => {
    const marker = randomHex(8);
    const sharedTs = ts(-800);
    // All 10 rows have the same timestamp
    const rows = Array.from({ length: 10 }, (_, i) =>
      spanRow({
        service_name: `tied-${marker}`,
        timestamp: sharedTs,
        span_id: `tied${String(i).padStart(12, '0')}`,
      }),
    );
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const run1 = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE service_name = ${'tied-' + marker}
      ORDER BY "timestamp" DESC, span_id DESC
    `;
    const run2 = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE service_name = ${'tied-' + marker}
      ORDER BY "timestamp" DESC, span_id DESC
    `;

    const ids1 = run1.map((r: Record<string, unknown>) => r.span_id);
    const ids2 = run2.map((r: Record<string, unknown>) => r.span_id);
    expect(ids1).toEqual(ids2);
  });
});

describe('cursor pagination', () => {
  test('paginating 200 rows in pages of 50 returns all rows with no gaps or duplicates', async () => {
    const marker = randomHex(8);
    // Spread rows 1 second apart so every timestamp is unique
    const rows = Array.from({ length: 200 }, (_, i) =>
      spanRow({ service_name: `page-${marker}`, timestamp: ts(-3000 + i) }),
    );
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const allIds = new Set<string>();
    let lastTs: string | null = null;
    let lastId: string | null = null;
    let pages = 0;

    while (true) {
      let page: Array<Record<string, unknown>>;

      if (lastTs === null) {
        page = await sql`
          SELECT span_id, "timestamp" FROM ${sql(TABLE)}
          WHERE service_name = ${'page-' + marker}
          ORDER BY "timestamp" DESC, span_id DESC
          LIMIT 50
        `;
      } else {
        page = await sql`
          SELECT span_id, "timestamp" FROM ${sql(TABLE)}
          WHERE service_name = ${'page-' + marker}
            AND ("timestamp" < ${lastTs} OR ("timestamp" = ${lastTs} AND span_id < ${lastId!}))
          ORDER BY "timestamp" DESC, span_id DESC
          LIMIT 50
        `;
      }

      if (page.length === 0) break;
      pages++;

      for (const r of page) {
        const id = r.span_id as string;
        expect(allIds.has(id)).toBe(false); // no duplicates
        allIds.add(id);
      }

      const last = page[page.length - 1];
      lastTs = new Date(last.timestamp as string | Date).toISOString();
      lastId = last.span_id as string;

      if (page.length < 50) break;
    }

    expect(allIds.size).toBe(200); // no gaps
    expect(pages).toBe(4);         // 200 / 50
  }, 30_000);
});

describe('SELECT column list vs SELECT *', () => {
  test('selecting specific columns returns the same values as SELECT *', async () => {
    const row = spanRow();
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const [full] = await sql`
      SELECT * FROM ${sql(TABLE)} WHERE span_id = ${row.span_id as string}
    `;
    const [partial] = await sql`
      SELECT span_id, trace_id, gen_ai_system FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect(partial.span_id).toBe(full.span_id);
    expect(partial.trace_id).toBe(full.trace_id);
    expect(partial.gen_ai_system).toBe(full.gen_ai_system);
    // partial should not have fields not in the SELECT list
    expect(partial.span_name).toBeUndefined();
  });
});

describe('COUNT', () => {
  test('COUNT before and after insert reflects the delta', async () => {
    const marker = randomHex(8);

    const before = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'count-' + marker}
    `;
    const countBefore = Number(before[0].c);

    const rows = Array.from({ length: 7 }, (_, i) =>
      spanRow({ service_name: `count-${marker}`, timestamp: ts(-4000 + i) }),
    );
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const after = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'count-' + marker}
    `;
    expect(Number(after[0].c)).toBe(countBefore + 7);
  });
});
