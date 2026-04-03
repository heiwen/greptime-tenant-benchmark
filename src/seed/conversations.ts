import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import { randomJson } from './text.js';
import type { Strategy, ItemType } from '../types.js';

export const ITEM_TYPE_CONFIG: Record<ItemType, { weight: number; dataBytes: number }> = {
  user:      { weight: 0.40, dataBytes:   200 },
  assistant: { weight: 0.40, dataBytes:  1000 },
  tool:      { weight: 0.20, dataBytes:  3000 },
};

const ITEM_TYPES = Object.keys(ITEM_TYPE_CONFIG) as ItemType[];

function pickItemType(): ItemType {
  const r = Math.random();
  let cumulative = 0;
  for (const type of ITEM_TYPES) {
    cumulative += ITEM_TYPE_CONFIG[type].weight;
    if (r < cumulative) return type;
  }
  return 'assistant';
}

export function generateItemRow(
  tenantId: string | null,
  conversationId: string,
  timestamp: bigint,
): Record<string, unknown> {
  const type = pickItemType();
  const dataBytes = ITEM_TYPE_CONFIG[type].dataBytes;

  const row: Record<string, unknown> = {
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    created_at: timestamp,
    type,
    data: randomJson(dataBytes),
  };

  if (tenantId !== null) {
    row.tenant_id = tenantId;
  }

  return row;
}

function randomTimestampInRange(startMs: number, endMs: number): bigint {
  return BigInt(Math.floor(startMs + Math.random() * (endMs - startMs)));
}

export async function seedConversationItems(
  strategy: Strategy,
  tenants: string[],
  totalPerTenant: number,
  conversationsPerTenant: number,
): Promise<void> {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;
  const MS_PER_MONTH = 30 * MS_PER_DAY;

  const historicalStart = now - 18 * MS_PER_MONTH;
  const historicalEnd   = now - 4 * MS_PER_MONTH;
  const recentStart     = now - 3 * MS_PER_MONTH;
  const recentEnd       = now - MS_PER_MONTH;
  const freshStart      = now - 7 * MS_PER_DAY;
  const freshEnd        = now;

  const historicalCount = Math.floor(totalPerTenant * 0.75);
  const recentCount     = Math.floor(totalPerTenant * 0.15);
  const freshCount      = totalPerTenant - historicalCount - recentCount;

  const batchSize = config.seedBatchSize;

  for (let t = 0; t < tenants.length; t++) {
    const tenantId = tenants[t];
    const tableName = strategy === 'a'
      ? tenantTable('conversation_items', tenantId)
      : 'conversation_items';

    console.log(`[items] Tenant ${t + 1}/${tenants.length}: ${tenantId} → ${tableName}`);

    // Generate conversation IDs for this tenant upfront
    const conversationIds: string[] = [];
    for (let i = 0; i < conversationsPerTenant; i++) {
      conversationIds.push(crypto.randomUUID());
    }

    const segments = [
      { count: historicalCount, start: historicalStart, end: historicalEnd },
      { count: recentCount,     start: recentStart,     end: recentEnd },
      { count: freshCount,      start: freshStart,      end: freshEnd },
    ];

    let totalInserted = 0;

    for (const seg of segments) {
      let segInserted = 0;

      while (segInserted < seg.count) {
        const thisBatch = Math.min(batchSize, seg.count - segInserted);
        const rows: Record<string, unknown>[] = [];

        for (let i = 0; i < thisBatch; i++) {
          const conversationId = conversationIds[Math.floor(Math.random() * conversationIds.length)];
          const ts = randomTimestampInRange(seg.start, seg.end);
          const row = generateItemRow(strategy === 'b' ? tenantId : null, conversationId, ts);
          rows.push(row);
        }

        await sql`INSERT INTO ${sql(tableName)} ${sql(rows)}`;

        segInserted += thisBatch;
        totalInserted += thisBatch;

        if (totalInserted % 50_000 === 0) {
          console.log(`  [items] ${tenantId}: ${totalInserted}/${totalPerTenant} rows inserted`);
        }
      }
    }

    console.log(`  [items] ${tenantId}: complete (${totalInserted} rows)`);
  }
}
