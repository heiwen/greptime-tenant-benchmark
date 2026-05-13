import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import { tenantConversationId, pickConversationIndex } from './helpers.js';
import type { WorkloadFn } from './types.js';
import { quoteSql, runExplainInBench, shouldExplain } from './explain.js';

let qConvCounter = 0;

function qConvSql(strategy: 'a' | 'b', tenantId: string, conversationId: string): string {
  if (strategy === 'b') {
    return `SELECT "id", conversation_id, created_at, "type", "data"
      FROM conversation_items
      WHERE tenant_id = ${quoteSql(tenantId)}
        AND conversation_id = ${quoteSql(conversationId)}
      ORDER BY created_at ASC`;
  }

  return `SELECT "id", conversation_id, created_at, "type", "data"
    FROM ${tenantTable('conversation_items', tenantId)}
    WHERE conversation_id = ${quoteSql(conversationId)}
    ORDER BY created_at ASC`;
}

// Mirrors the gateway's "load conversation history before sending next LLM turn" pattern:
// fetch all items for a single conversation_id, including the data payload, in chronological order.
//
// 'clustered'  → picks from the first half of conversation IDs, whose items are seeded within
//               ±48h of a single anchor time (single-session conversations).
// 'scattered'  → picks from the second half, whose items are spread randomly across 18 months
//               (long-running conversations resumed many times).
export function qConvS2(pool: 'clustered' | 'scattered'): WorkloadFn {
  const total = config.conversationsPerTenant;
  return async ({ tenantId, strategy }) => {
    const conversationId = tenantConversationId(tenantId, pickConversationIndex(pool, total));
    const seq = ++qConvCounter;

    if (shouldExplain(seq)) {
      await runExplainInBench({
        seq,
        workload: `q-conv-${pool}`,
        strategy,
        tenantId,
        key: conversationId,
        query: qConvSql(strategy, tenantId, conversationId),
      });
      return {};
    }

    if (strategy === 'b') {
      await sql`
        SELECT "id", conversation_id, created_at, "type", "data"
        FROM conversation_items
        WHERE tenant_id = ${tenantId}
          AND conversation_id = ${conversationId}
        ORDER BY created_at ASC
      `;
    } else {
      const table = tenantTable('conversation_items', tenantId);
      await sql`
        SELECT "id", conversation_id, created_at, "type", "data"
        FROM ${sql(table)}
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at ASC
      `;
    }

    return {};
  };
}
