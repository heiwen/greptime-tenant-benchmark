import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, createSharedSpansTable, dropTable, uniqueSuffix, randomHex, ts } from './helpers.ts';

const TABLE = `test_shared_${uniqueSuffix()}`;

// Two regular tenants
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

// Tenants at hex partition boundaries
const TENANT_ZERO = `0${crypto.randomUUID().slice(1)}`; // starts with '0'
const TENANT_F    = `f${crypto.randomUUID().slice(1)}`; // starts with 'f'

function sharedRow(tenantId: string, offsetSec: number): Record<string, unknown> {
  return {
    tenant_id:          tenantId,
    timestamp:          ts(-100000 + offsetSec).toISOString(),
    trace_id:           randomHex(32),
    span_id:            randomHex(16),
    service_name:       `svc-${tenantId.slice(0, 8)}`,
    gen_ai_system:      'openai',
    gen_ai_input_tokens: 100,
  };
}

beforeAll(async () => {
  await createSharedSpansTable(TABLE);

  // 100 rows each for tenant A and B
  const rowsA = Array.from({ length: 100 }, (_, i) => sharedRow(TENANT_A, i));
  const rowsB = Array.from({ length: 100 }, (_, i) => sharedRow(TENANT_B, 200 + i));

  // 10 rows each for boundary tenants
  const rowsZero = Array.from({ length: 10 }, (_, i) => sharedRow(TENANT_ZERO, 400 + i));
  const rowsF    = Array.from({ length: 10 }, (_, i) => sharedRow(TENANT_F,    500 + i));

  await sql`INSERT INTO ${sql(TABLE)} ${sql(rowsA)}`;
  await sql`INSERT INTO ${sql(TABLE)} ${sql(rowsB)}`;
  await sql`INSERT INTO ${sql(TABLE)} ${sql(rowsZero)}`;
  await sql`INSERT INTO ${sql(TABLE)} ${sql(rowsF)}`;
}, 30_000);

afterAll(async () => {
  await dropTable(TABLE);
});

describe('tenant isolation', () => {
  test("querying tenant A returns exactly 100 rows", async () => {
    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE tenant_id = ${TENANT_A}
    `;
    expect(Number(r.c)).toBe(100);
  });

  test("querying tenant B returns exactly 100 rows", async () => {
    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE tenant_id = ${TENANT_B}
    `;
    expect(Number(r.c)).toBe(100);
  });

  test("tenant A rows contain no tenant B data", async () => {
    const rows = await sql`
      SELECT tenant_id FROM ${sql(TABLE)}
      WHERE tenant_id = ${TENANT_A}
    `;
    for (const r of rows) {
      expect(r.tenant_id).toBe(TENANT_A);
    }
  });

  test("tenant B rows contain no tenant A data", async () => {
    const rows = await sql`
      SELECT tenant_id FROM ${sql(TABLE)}
      WHERE tenant_id = ${TENANT_B}
    `;
    for (const r of rows) {
      expect(r.tenant_id).toBe(TENANT_B);
    }
  });

  test('COUNT(*) without tenant filter equals sum of all tenants', async () => {
    const [total] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
    `;
    const [a] = await sql`SELECT COUNT(*) AS c FROM ${sql(TABLE)} WHERE tenant_id = ${TENANT_A}`;
    const [b] = await sql`SELECT COUNT(*) AS c FROM ${sql(TABLE)} WHERE tenant_id = ${TENANT_B}`;
    const [z] = await sql`SELECT COUNT(*) AS c FROM ${sql(TABLE)} WHERE tenant_id = ${TENANT_ZERO}`;
    const [f] = await sql`SELECT COUNT(*) AS c FROM ${sql(TABLE)} WHERE tenant_id = ${TENANT_F}`;

    const sum = Number(a.c) + Number(b.c) + Number(z.c) + Number(f.c);
    expect(Number(total.c)).toBe(sum);
  });
});

describe('partition boundary tenants', () => {
  test("tenant whose UUID starts with '0' is stored and queryable", async () => {
    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE tenant_id = ${TENANT_ZERO}
    `;
    expect(Number(r.c)).toBe(10);
  });

  test("tenant whose UUID starts with 'f' is stored and queryable", async () => {
    const [r] = await sql`
      SELECT COUNT(*) AS c FROM ${sql(TABLE)}
      WHERE tenant_id = ${TENANT_F}
    `;
    expect(Number(r.c)).toBe(10);
  });

  test("rows from '0' tenant do not bleed into 'f' tenant query", async () => {
    const rows = await sql`
      SELECT tenant_id FROM ${sql(TABLE)}
      WHERE tenant_id = ${TENANT_F}
    `;
    for (const r of rows) {
      expect(r.tenant_id).toBe(TENANT_F);
    }
  });
});
