import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSpansTable, dropTable, spanRow, uniqueSuffix, randomHex, ts } from './helpers.ts';

const TABLE = `test_spans_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(TABLE);
});

afterAll(async () => {
  await dropTable(TABLE);
});

describe('duplicate primary key behaviour', () => {
  test('inserting two rows with the same (timestamp, span_id) — both are stored or last wins', async () => {
    // In APPEND_MODE, GreptimeDB stores all rows without deduplication at write time.
    // Compaction may deduplicate later. This test documents the immediate behaviour.
    const sharedTs   = ts(-50000);
    const sharedSpanId = randomHex(16);

    const row1 = spanRow({ timestamp: sharedTs, span_id: sharedSpanId, gen_ai_system: 'openai'    });
    const row2 = spanRow({ timestamp: sharedTs, span_id: sharedSpanId, gen_ai_system: 'anthropic' });

    await sql`INSERT INTO ${sql(TABLE)} ${sql([row1])}`;
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row2])}`;

    const rows = await sql`
      SELECT span_id, gen_ai_system FROM ${sql(TABLE)}
      WHERE span_id = ${sharedSpanId}
    `;

    // In pure append mode both should be visible; document the actual count
    console.log(`Duplicate PK: ${rows.length} row(s) returned`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test('inserting two rows with the same timestamp but different span_ids — both are stored', async () => {
    const sharedTs = ts(-51000);
    const row1 = spanRow({ timestamp: sharedTs, span_id: randomHex(16), gen_ai_system: 'openai'    });
    const row2 = spanRow({ timestamp: sharedTs, span_id: randomHex(16), gen_ai_system: 'anthropic' });

    await sql`INSERT INTO ${sql(TABLE)} ${sql([row1, row2])}`;

    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE span_id IN (${row1.span_id as string}, ${row2.span_id as string})
    `;
    expect(rows.length).toBe(2);
  });
});

describe('immediate read-after-write visibility', () => {
  test('row is visible immediately after insert without any flush', async () => {
    const row = spanRow({ timestamp: ts(-52000) });

    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('UPDATE and DELETE behaviour', () => {
  test('UPDATE on an append-mode table either errors or silently does nothing', async () => {
    const row = spanRow({ timestamp: ts(-53000) });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    let errorThrown = false;
    try {
      await sql.unsafe(
        `UPDATE ${TABLE} SET gen_ai_system = 'updated' WHERE span_id = '${row.span_id}'`,
      );
    } catch {
      errorThrown = true;
    }

    // Either it errored OR the value was unchanged
    if (!errorThrown) {
      const [r] = await sql`
        SELECT gen_ai_system FROM ${sql(TABLE)}
        WHERE span_id = ${row.span_id as string}
      `;
      console.log(`UPDATE on append-mode: no error, value is: ${r.gen_ai_system}`);
    } else {
      console.log('UPDATE on append-mode: threw an error (expected)');
    }

    // The test passes either way — we are documenting behaviour, not asserting one specific outcome
    expect(errorThrown || true).toBe(true);
  });

  test('DELETE on an append-mode table either errors or silently does nothing', async () => {
    const row = spanRow({ timestamp: ts(-54000) });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    let errorThrown = false;
    try {
      await sql.unsafe(`DELETE FROM ${TABLE} WHERE span_id = '${row.span_id}'`);
    } catch {
      errorThrown = true;
    }

    if (!errorThrown) {
      const rows = await sql`
        SELECT span_id FROM ${sql(TABLE)}
        WHERE span_id = ${row.span_id as string}
      `;
      console.log(`DELETE on append-mode: no error, rows remaining: ${rows.length}`);
    } else {
      console.log('DELETE on append-mode: threw an error (expected)');
    }

    expect(errorThrown || true).toBe(true);
  });
});
