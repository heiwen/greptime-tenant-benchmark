import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { createSpansTable, createItemsTable, dropTable, spanRow, minimalSpanRow, itemRow, uniqueSuffix, ts } from './helpers.ts';

// Own pool: SELECT * on spans table triggers ERR_POSTGRES_UNSUPPORTED_NUMERIC_FORMAT
// (BIGINT/INT columns returned in binary format). Isolated to avoid corrupting the
// shared helpers.ts pool used by other parallel test files for DDL.
const sql = new SQL(
  process.env.GREPTIMEDB_URL ?? 'postgres://greptime@localhost:4003/public',
  { max: 5, idleTimeout: 30, connectionTimeout: 15, ssl: false, prepare: false },
);

const SPANS = `test_spans_${uniqueSuffix()}`;
const ITEMS = `test_items_${uniqueSuffix()}`;

beforeAll(async () => {
  await createSpansTable(SPANS);
  await createItemsTable(ITEMS);
});

afterAll(async () => {
  await dropTable(SPANS);
  await dropTable(ITEMS);
  sql.close();
});

describe('span roundtrip', () => {
  test('all fields survive insert → select', async () => {
    const row = spanRow({
      span_name:            'openai.gpt-4o.chat',
      span_kind:            'CLIENT',
      span_status_code:     'OK',
      span_status_message:  null,
      service_name:         'ai-gateway',
      gen_ai_system:        'openai',
      gen_ai_request_model: 'gpt-4o',
      gen_ai_input_tokens:  1234,
      gen_ai_output_tokens: 567,
      gen_ai_total_tokens:  1801,
    });

    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT * FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect(r).toBeDefined();
    expect(r.span_id).toBe(row.span_id);
    expect(r.trace_id).toBe(row.trace_id);
    expect(r.span_name).toBe('openai.gpt-4o.chat');
    expect(r.span_kind).toBe('CLIENT');
    expect(r.span_status_code).toBe('OK');
    expect(r.span_status_message).toBeNull();
    expect(r.service_name).toBe('ai-gateway');
    expect(r.gen_ai_system).toBe('openai');
    expect(r.gen_ai_request_model).toBe('gpt-4o');
    expect(Number(r.gen_ai_input_tokens)).toBe(1234);
    expect(Number(r.gen_ai_output_tokens)).toBe(567);
    expect(Number(r.gen_ai_total_tokens)).toBe(1801);
    expect(r.gen_ai_input_messages).toBe(row.gen_ai_input_messages);
    expect(r.gen_ai_output_messages).toBe(row.gen_ai_output_messages);
    expect(r.span_attributes).toBe('{}');
    expect(Number(r.duration_nano)).toBe(500_000_000);
  });

  test('nullable fields return null when not set', async () => {
    const row = minimalSpanRow();
    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT * FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect(r.parent_span_id).toBeNull();
    expect(r.span_name).toBeNull();
    expect(r.span_kind).toBeNull();
    expect(r.span_status_code).toBeNull();
    expect(r.span_status_message).toBeNull();
    expect(r.service_name).toBeNull();
    expect(r.gen_ai_system).toBeNull();
    expect(r.gen_ai_request_model).toBeNull();
    expect(r.gen_ai_input_tokens).toBeNull();
    expect(r.gen_ai_output_tokens).toBeNull();
    expect(r.gen_ai_total_tokens).toBeNull();
    expect(r.gen_ai_input_messages).toBeNull();
    expect(r.gen_ai_output_messages).toBeNull();
    expect(r.span_attributes).toBeNull();
    expect(r.timestamp_end).toBeNull();
    expect(r.duration_nano).toBeNull();
  });

  test('UTF-8 and special characters in STRING fields', async () => {
    const content = 'Hello 世界 🌍 \n\t "quoted" \\backslash';
    const row = spanRow({
      span_name:           content,
      gen_ai_input_messages: JSON.stringify([{ role: 'user', content }]),
    });

    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT span_name, gen_ai_input_messages FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect(r.span_name).toBe(content);
    const parsed = JSON.parse(r.gen_ai_input_messages as string);
    expect(parsed[0].content).toBe(content);
  });

  test('timestamp roundtrip preserves milliseconds', async () => {
    const t = new Date(2024, 5, 15, 10, 30, 45, 123); // explicit ms
    const row = spanRow({ timestamp: t });

    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT "timestamp" FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;

    // Returned timestamp must match at millisecond precision
    const returned = new Date(r.timestamp as string | Date);
    expect(returned.getTime()).toBe(t.getTime());
  });

  test('large JSON string in gen_ai_input_messages', async () => {
    const large = JSON.stringify({ content: 'x'.repeat(50_000) });
    const row = spanRow({ gen_ai_input_messages: large });

    await sql`INSERT INTO ${sql(SPANS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT gen_ai_input_messages FROM ${sql(SPANS)}
      WHERE span_id = ${row.span_id as string}
    `;

    expect(r.gen_ai_input_messages).toBe(large);
  });
});

describe('conversation item roundtrip', () => {
  test('all fields survive insert → select', async () => {
    const row = itemRow({
      type: 'assistant',
      data: JSON.stringify({ content: 'Hello, how can I help?' }),
    });

    await sql`INSERT INTO ${sql(ITEMS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT * FROM ${sql(ITEMS)}
      WHERE "id" = ${row.id as string}
    `;

    expect(r).toBeDefined();
    expect(r.id).toBe(row.id);
    expect(r.conversation_id).toBe(row.conversation_id);
    expect(r.type).toBe('assistant');
    const parsed = JSON.parse(r.data as string);
    expect(parsed.content).toBe('Hello, how can I help?');
  });

  test('nullable type and data fields return null', async () => {
    const row = itemRow({ type: null, data: null });

    await sql`INSERT INTO ${sql(ITEMS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT "type", "data" FROM ${sql(ITEMS)}
      WHERE "id" = ${row.id as string}
    `;

    expect(r.type).toBeNull();
    expect(r.data).toBeNull();
  });

  test('timestamp roundtrip preserves milliseconds', async () => {
    const t = new Date(2024, 3, 20, 14, 0, 0, 500);
    const row = itemRow({ created_at: t });

    await sql`INSERT INTO ${sql(ITEMS)} ${sql([row])}`;

    const [r] = await sql`
      SELECT created_at FROM ${sql(ITEMS)}
      WHERE "id" = ${row.id as string}
    `;

    const returned = new Date(r.created_at as string | Date);
    expect(returned.getTime()).toBe(t.getTime());
  });
});
