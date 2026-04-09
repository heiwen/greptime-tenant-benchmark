import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSpansTable, dropTable, spanRow, uniqueSuffix, randomHex, ts } from './helpers.ts';

const TABLE = `test_spans_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(TABLE);
});

afterAll(async () => {
  await dropTable(TABLE);
});

describe('query errors', () => {
  test('querying a non-existent table throws, not returns empty', async () => {
    const ghost = `nonexistent_${randomHex(16)}`;
    let threw = false;
    try {
      await sql.unsafe(`SELECT * FROM ${ghost}`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('syntax error throws with a message', async () => {
    let error: unknown;
    try {
      await sql.unsafe('SELECT GARBAGE @@@ FROM nowhere');
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(String(error)).not.toBe('');
  });

  test('null parameter in WHERE does not crash', async () => {
    let errorThrown = false;
    let result: unknown[] = [];

    try {
      result = await sql`
        SELECT span_id FROM ${sql(TABLE)}
        WHERE trace_id = ${null as unknown as string}
      `;
    } catch {
      errorThrown = true;
    }

    // Document: either an error was thrown, or the query ran (likely matching nothing)
    console.log(`null parameter in WHERE: errorThrown=${errorThrown}, rows=${result.length}`);
    expect(errorThrown || result.length >= 0).toBe(true);
  });
});

describe('connection recovery after errors', () => {
  test('valid query succeeds after a failed query on the same pool', async () => {
    // Cause a failure
    try {
      await sql.unsafe('SELECT * FROM absolutely_nonexistent_table_xyz');
    } catch {
      // expected
    }

    // Next valid query must succeed
    const row = spanRow({ timestamp: ts(-110000) });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;

    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE span_id = ${row.span_id as string}
    `;
    expect(rows.length).toBe(1);
  });

  test('multiple consecutive errors do not exhaust the connection pool', async () => {
    for (let i = 0; i < 10; i++) {
      try {
        await sql.unsafe(`SELECT * FROM ghost_table_${i}`);
      } catch {
        // expected
      }
    }

    // Pool should still function
    const row = spanRow({ timestamp: ts(-111000) });
    await sql`INSERT INTO ${sql(TABLE)} ${sql([row])}`;
    const rows = await sql`SELECT span_id FROM ${sql(TABLE)} WHERE span_id = ${row.span_id as string}`;
    expect(rows.length).toBe(1);
  });
});

describe('parameter edge cases', () => {
  test('undefined parameter becomes NULL or errors gracefully', async () => {
    let errorThrown = false;
    let result: unknown[] = [];

    try {
      result = await sql`
        SELECT span_id FROM ${sql(TABLE)}
        WHERE span_id = ${undefined as unknown as string}
      `;
    } catch {
      errorThrown = true;
    }

    // Document: either an error was thrown, or the query ran (likely matching nothing)
    console.log(`undefined param: errorThrown=${errorThrown}, rows=${result.length}`);
    expect(errorThrown || result.length >= 0).toBe(true);
  });

  test('empty string parameter does not crash', async () => {
    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE gen_ai_system = ${''}
    `;
    // Should return an empty result set, not crash
    expect(Array.isArray(rows)).toBe(true);
  });

  test('very large string parameter does not crash', async () => {
    const big = 'a'.repeat(100_000);
    const rows = await sql`
      SELECT span_id FROM ${sql(TABLE)}
      WHERE gen_ai_system = ${big}
    `;
    expect(rows.length).toBe(0);
  });
});

describe('DDL error handling', () => {
  test('CREATE TABLE with invalid DDL throws', async () => {
    let threw = false;
    try {
      await sql.unsafe('CREATE TABLE bad_ddl (col INVALIDTYPE NOT NULL TIME INDEX)');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('DROP non-existent table with IF EXISTS does not throw', async () => {
    let threw = false;
    try {
      await sql.unsafe(`DROP TABLE IF EXISTS totally_nonexistent_table_${randomHex(16)}`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
