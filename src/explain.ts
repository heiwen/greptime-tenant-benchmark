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

  divider('B: Q-conv (SELECT *, ORDER BY created_at ASC, no LIMIT)');
  printRows(await sql`
    EXPLAIN ANALYZE
    SELECT "id", conversation_id, created_at, "type", "data"
    FROM conversation_items
    WHERE tenant_id = ${tenantId}
      AND conversation_id = ${conversationId}
    ORDER BY created_at ASC
  `);

  divider('B: Q-id first page (ORDER BY created_at DESC, id DESC, LIMIT 50)');
  printRows(await sql`
    EXPLAIN ANALYZE
    SELECT "id", conversation_id, created_at, "type"
    FROM conversation_items
    WHERE tenant_id = ${tenantId}
      AND conversation_id = ${conversationId}
    ORDER BY created_at DESC, "id" DESC
    LIMIT 50
  `);

  divider(`A: Q-conv on ${tableA}`);
  printRows(await sql`
    EXPLAIN ANALYZE
    SELECT "id", conversation_id, created_at, "type", "data"
    FROM ${sql(tableA)}
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at ASC
  `);

  divider(`A: Q-id first page on ${tableA}`);
  printRows(await sql`
    EXPLAIN ANALYZE
    SELECT "id", conversation_id, created_at, "type"
    FROM ${sql(tableA)}
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC, "id" DESC
    LIMIT 50
  `);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
