import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import { tenantConversationId, pickConversationIndex } from './helpers.js';
import type { WorkloadFn, CursorState } from './types.js';

const spansCursors = new Map<string, CursorState>();

// One active conversation per tenant. Pages through it until exhausted, then picks a new one.
// Bounded to tenantCount entries (vs. one entry per conversation in the old approach).
interface S2State { conversationId: string; cursor: CursorState | null; }
const itemsState = new Map<string, S2State>();

function getOrInitS2State(tenantId: string): S2State {
  let state = itemsState.get(tenantId);
  if (!state) {
    const idx = pickConversationIndex('scattered', config.conversationsPerTenant);
    state = { conversationId: tenantConversationId(tenantId, idx), cursor: null };
    itemsState.set(tenantId, state);
  }
  return state;
}

export function qIdS1(_page: number): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    const cursor = spansCursors.get(tenantId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];

    if (!cursor) {
      // First call: no cursor, get latest page
      const now = new Date();
      if (strategy === 'b') {
        rows = await sql`
          SELECT trace_id, span_id, "timestamp", duration_nano,
                 gen_ai_system, gen_ai_request_model,
                 gen_ai_input_tokens, gen_ai_output_tokens
          FROM spans
          WHERE tenant_id = ${tenantId}
            AND "timestamp" <= ${now}
          ORDER BY "timestamp" DESC, span_id DESC
          LIMIT 50
        `;
      } else {
        const table = tenantTable('spans', tenantId);
        rows = await sql`
          SELECT trace_id, span_id, "timestamp", duration_nano,
                 gen_ai_system, gen_ai_request_model,
                 gen_ai_input_tokens, gen_ai_output_tokens
          FROM ${sql(table)}
          WHERE "timestamp" <= ${now}
          ORDER BY "timestamp" DESC, span_id DESC
          LIMIT 50
        `;
      }
    } else {
      const lastTs = cursor.lastTs;
      const lastId = cursor.lastId;

      if (strategy === 'b') {
        rows = await sql`
          SELECT trace_id, span_id, "timestamp", duration_nano,
                 gen_ai_system, gen_ai_request_model,
                 gen_ai_input_tokens, gen_ai_output_tokens
          FROM spans
          WHERE tenant_id = ${tenantId}
            AND ("timestamp" < ${lastTs} OR ("timestamp" = ${lastTs} AND span_id < ${lastId}))
          ORDER BY "timestamp" DESC, span_id DESC
          LIMIT 50
        `;
      } else {
        const table = tenantTable('spans', tenantId);
        rows = await sql`
          SELECT trace_id, span_id, "timestamp", duration_nano,
                 gen_ai_system, gen_ai_request_model,
                 gen_ai_input_tokens, gen_ai_output_tokens
          FROM ${sql(table)}
          WHERE ("timestamp" < ${lastTs} OR ("timestamp" = ${lastTs} AND span_id < ${lastId}))
          ORDER BY "timestamp" DESC, span_id DESC
          LIMIT 50
        `;
      }
    }

    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      spansCursors.set(tenantId, {
        lastTs: last.timestamp,
        lastId: last.span_id,
      });
    } else {
      spansCursors.delete(tenantId);
    }

    return {};
  };
}

export function qIdS2(_page: number): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    const state = getOrInitS2State(tenantId);
    const { conversationId, cursor } = state;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];

    if (!cursor) {
      if (strategy === 'b') {
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM conversation_items
          WHERE tenant_id = ${tenantId}
            AND conversation_id = ${conversationId}
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      } else {
        const table = tenantTable('conversation_items', tenantId);
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM ${sql(table)}
          WHERE conversation_id = ${conversationId}
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      }
    } else {
      const { lastTs, lastId } = cursor;

      if (strategy === 'b') {
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM conversation_items
          WHERE tenant_id = ${tenantId}
            AND conversation_id = ${conversationId}
            AND (created_at < ${lastTs} OR (created_at = ${lastTs} AND "id" < ${lastId}))
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      } else {
        const table = tenantTable('conversation_items', tenantId);
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM ${sql(table)}
          WHERE conversation_id = ${conversationId}
            AND (created_at < ${lastTs} OR (created_at = ${lastTs} AND "id" < ${lastId}))
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      }
    }

    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      state.cursor = { lastTs: last.created_at, lastId: last.id };
    } else {
      // Conversation exhausted — next call picks a new one
      itemsState.delete(tenantId);
    }

    return {};
  };
}
