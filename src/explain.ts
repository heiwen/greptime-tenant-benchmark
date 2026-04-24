import { sql, tenantTable } from './db.js';
import { loadTenants } from './seed/tenants.js';

function divider(title: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(title);
  console.log('='.repeat(80));
}

function printRows(rows: unknown[]): void {
  for (const row of rows) {
    const values = Object.values(row as Record<string, unknown>);
    console.log(values.map((v) => (v === null ? '' : String(v))).join('\n'));
  }
}

async function main(): Promise<void> {
  const tenants = await loadTenants();
  const tenantId = tenants[0]!;
  console.log(`tenant_id = ${tenantId}`);

  const convRow = await sql`
    SELECT conversation_id
    FROM conversation_items
    WHERE tenant_id = ${tenantId}
    LIMIT 1
  `;
  const conversationId = (convRow[0] as { conversation_id: string }).conversation_id;
  console.log(`conversation_id = ${conversationId}`);

  const tableA = tenantTable('conversation_items', tenantId);
  const uuidRe = /^[0-9a-f-]{36}$/i;
  if (!uuidRe.test(tenantId) || !uuidRe.test(conversationId)) {
    throw new Error('Refusing to inline non-UUID identifiers into SQL');
  }

  const run = async (label: string, query: string) => {
    divider(label);
    printRows(await sql.unsafe(query));
  };

  await run(
    'B: Q-conv (SELECT *, ORDER BY created_at ASC, no LIMIT)',
    `EXPLAIN ANALYZE
     SELECT "id", conversation_id, created_at, "type", "data"
     FROM conversation_items
     WHERE tenant_id = '${tenantId}'
       AND conversation_id = '${conversationId}'
     ORDER BY created_at ASC`
  );

  await run(
    'B: Q-id first page (ORDER BY created_at DESC, id DESC, LIMIT 50)',
    `EXPLAIN ANALYZE
     SELECT "id", conversation_id, created_at, "type"
     FROM conversation_items
     WHERE tenant_id = '${tenantId}'
       AND conversation_id = '${conversationId}'
     ORDER BY created_at DESC, "id" DESC
     LIMIT 50`
  );

  await run(
    `A: Q-conv on ${tableA}`,
    `EXPLAIN ANALYZE
     SELECT "id", conversation_id, created_at, "type", "data"
     FROM ${tableA}
     WHERE conversation_id = '${conversationId}'
     ORDER BY created_at ASC`
  );

  await run(
    `A: Q-id first page on ${tableA}`,
    `EXPLAIN ANALYZE
     SELECT "id", conversation_id, created_at, "type"
     FROM ${tableA}
     WHERE conversation_id = '${conversationId}'
     ORDER BY created_at DESC, "id" DESC
     LIMIT 50`
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
