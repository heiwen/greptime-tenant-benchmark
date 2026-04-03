import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import type { WorkloadFn } from './types.js';
import { tenantConversationId } from './helpers.js';

export function qTimeS1(windowHours: number): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    // Use number for query filter params — ms timestamps fit safely in JS number
    const cutoffMs = Date.now() - windowHours * 3600 * 1000;

    if (strategy === 'b') {
      await sql`
        SELECT trace_id, span_id, timestamp, duration_nano,
               gen_ai_system, gen_ai_request_model,
               gen_ai_input_tokens, gen_ai_output_tokens
        FROM spans
        WHERE tenant_id = ${tenantId}
          AND timestamp > ${cutoffMs}
        ORDER BY timestamp DESC
        LIMIT 50
      `;
    } else {
      const table = tenantTable('spans', tenantId);
      await sql`
        SELECT trace_id, span_id, timestamp, duration_nano,
               gen_ai_system, gen_ai_request_model,
               gen_ai_input_tokens, gen_ai_output_tokens
        FROM ${sql(table)}
        WHERE timestamp > ${cutoffMs}
        ORDER BY timestamp DESC
        LIMIT 50
      `;
    }

    return {};
  };
}

export function qTimeS2(windowHours: number): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    // Use number for query filter params — ms timestamps fit safely in JS number
    const cutoffMs = Date.now() - windowHours * 3600 * 1000;
    // Pick a random conversation from this tenant's known conversations
    const convIndex = Math.floor(Math.random() * config.conversationsPerTenant);
    const conversationId = tenantConversationId(tenantId, convIndex);

    if (strategy === 'b') {
      await sql`
        SELECT id, conversation_id, created_at, type
        FROM conversation_items
        WHERE tenant_id = ${tenantId}
          AND conversation_id = ${conversationId}
          AND created_at > ${cutoffMs}
        ORDER BY created_at DESC
        LIMIT 50
      `;
    } else {
      const table = tenantTable('conversation_items', tenantId);
      await sql`
        SELECT id, conversation_id, created_at, type
        FROM ${sql(table)}
        WHERE conversation_id = ${conversationId}
          AND created_at > ${cutoffMs}
        ORDER BY created_at DESC
        LIMIT 50
      `;
    }

    return {};
  };
}

export { tenantConversationId };
