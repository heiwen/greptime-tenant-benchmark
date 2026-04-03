import { sql, tenantTable } from '../db.js';
import type { WorkloadFn, CursorState } from './types.js';

// Module-level cursor maps keyed by tenantId
const spansCursors = new Map<string, CursorState>();
const itemsCursors = new Map<string, CursorState>();

export function qIdS1(_page: number): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    const cursor = spansCursors.get(tenantId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];

    if (!cursor) {
      // First call: no cursor, get latest page
      if (strategy === 'b') {
        rows = await sql`
          SELECT trace_id, span_id, "timestamp", duration_nano,
                 gen_ai_system, gen_ai_request_model,
                 gen_ai_input_tokens, gen_ai_output_tokens
          FROM spans
          WHERE tenant_id = ${tenantId}
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
    const cursor = itemsCursors.get(tenantId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];

    if (!cursor) {
      if (strategy === 'b') {
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM conversation_items
          WHERE tenant_id = ${tenantId}
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      } else {
        const table = tenantTable('conversation_items', tenantId);
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM ${sql(table)}
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      }
    } else {
      const lastTs = cursor.lastTs;
      const lastId = cursor.lastId;

      if (strategy === 'b') {
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM conversation_items
          WHERE tenant_id = ${tenantId}
            AND (created_at < ${lastTs} OR (created_at = ${lastTs} AND "id" < ${lastId}))
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      } else {
        const table = tenantTable('conversation_items', tenantId);
        rows = await sql`
          SELECT "id", conversation_id, created_at, "type"
          FROM ${sql(table)}
          WHERE (created_at < ${lastTs} OR (created_at = ${lastTs} AND "id" < ${lastId}))
          ORDER BY created_at DESC, "id" DESC
          LIMIT 50
        `;
      }
    }

    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      itemsCursors.set(tenantId, {
        lastTs: last.created_at,
        lastId: last.id,
      });
    } else {
      itemsCursors.delete(tenantId);
    }

    return {};
  };
}
