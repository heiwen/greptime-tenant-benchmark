import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSpansTable, dropTable, spanRow, uniqueSuffix, randomHex, ts } from './helpers.ts';

const TABLE = `test_spans_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(TABLE);
});

afterAll(async () => {
  await dropTable(TABLE);
});

describe('concurrent writes', () => {
  test('50 concurrent inserts of 10 rows each — all 500 rows are stored', async () => {
    const marker = randomHex(8);

    await Promise.all(
      Array.from({ length: 50 }, (_, worker) =>
        sql`INSERT INTO ${sql(TABLE)} ${sql(
          Array.from({ length: 10 }, (_, i) =>
            spanRow({
              service_name: `conc-write-${marker}`,
              timestamp:    ts(-10000 + worker * 100 + i),
            }),
          ),
        )}`,
      ),
    );

    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'conc-write-' + marker}
    `;
    expect(Number(r.c)).toBe(500);
  }, 60_000);

  test('20 concurrent inserts to same table do not error', async () => {
    const marker = randomHex(8);
    const errors: unknown[] = [];

    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        try {
          await sql`INSERT INTO ${sql(TABLE)} ${sql([
            spanRow({ service_name: `conc-err-${marker}`, timestamp: ts(-20000 + i) }),
          ])}`;
        } catch (e) {
          errors.push(e);
        }
      }),
    );

    expect(errors.length).toBe(0);
  });
});

describe('concurrent reads', () => {
  test('20 concurrent reads of the same set of rows return consistent results', async () => {
    const marker = randomHex(8);
    const rows = Array.from({ length: 30 }, (_, i) =>
      spanRow({ service_name: `conc-read-${marker}`, timestamp: ts(-30000 + i) }),
    );
    await sql`INSERT INTO ${sql(TABLE)} ${sql(rows)}`;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        sql`
          SELECT COUNT(*) AS c FROM ${sql(TABLE)}
          WHERE service_name = ${'conc-read-' + marker}
        `,
      ),
    );

    for (const r of results) {
      expect(Number(r[0].c)).toBe(30);
    }
  }, 30_000);
});

describe('mixed concurrent reads and writes', () => {
  test('interleaved reads and writes — no errors, final count is correct', async () => {
    const marker = randomHex(8);
    const errors: unknown[] = [];
    let insertedCount = 0;

    // 10 writers, each inserting 5 rows; 10 readers running concurrently
    const writers = Array.from({ length: 10 }, async (_, worker) => {
      try {
        await sql`INSERT INTO ${sql(TABLE)} ${sql(
          Array.from({ length: 5 }, (_, i) =>
            spanRow({
              service_name: `mixed-${marker}`,
              timestamp:    ts(-40000 + worker * 50 + i),
            }),
          ),
        )}`;
        insertedCount += 5;
      } catch (e) {
        errors.push(e);
      }
    });

    const readers = Array.from({ length: 10 }, async () => {
      try {
        await sql`
          SELECT COUNT(*) AS c FROM ${sql(TABLE)}
          WHERE service_name = ${'mixed-' + marker}
        `;
      } catch (e) {
        errors.push(e);
      }
    });

    await Promise.all([...writers, ...readers]);

    expect(errors.length).toBe(0);

    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE service_name = ${'mixed-' + marker}
    `;
    expect(Number(r.c)).toBe(50);
  }, 30_000);
});
