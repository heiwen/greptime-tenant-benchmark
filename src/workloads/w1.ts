import { sql, tenantTable } from '../db.js';
import { randomJson } from '../seed/text.js';
import { ITEM_TYPE_CONFIG, pickItemType } from '../seed/conversations.js';
import type { WorkloadFn } from './types.js';

export function w1(): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    const tableName = strategy === 'a'
      ? tenantTable('conversation_items', tenantId)
      : 'conversation_items';

    const conversationId = crypto.randomUUID();
    const itemCount = 10 + Math.floor(Math.random() * 21); // 10–30 items

    let totalBytes = 0;
    const baseMs = Date.now();

    for (let i = 0; i < itemCount; i++) {
      const type = pickItemType();
      const dataBytes = ITEM_TYPE_CONFIG[type].dataBytes;
      const data = randomJson(dataBytes);
      const createdAt = new Date(baseMs + i).toISOString(); // 1ms offset per item to ensure unique TIME INDEX

      totalBytes += dataBytes;

      const row: Record<string, unknown> = {
        id: crypto.randomUUID(),
        conversation_id: conversationId,
        created_at: createdAt,
        type,
        data,
      };

      if (strategy === 'b') {
        row.tenant_id = tenantId;
      }

      if (strategy === 'b') {
        await sql`INSERT INTO conversation_items ${sql(row)}`;
      } else {
        await sql`INSERT INTO ${sql(tableName)} ${sql(row)}`;
      }
    }

    return { bytes: totalBytes };
  };
}
