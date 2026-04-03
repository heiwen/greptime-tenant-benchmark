import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import { randomJson } from './text.js';
import { tenantConversationId } from '../workloads/helpers.js';
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
  timestamp: Date,
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

function randomTimestampInRange(startMs: number, endMs: number): Date {
  return new Date(startMs + Math.random() * (endMs - startMs));
}

async function retryInsert(fn: () => Promise<void>, retries = 10, delayMs = 15_000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  [retry] Connection error, waiting ${delayMs / 1000}s for frontend to restart... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function countItems(strategy: Strategy, tableName: string, tenantId: string): Promise<number> {
  const result = strategy === 'b'
    ? await sql`SELECT COUNT(*) as c FROM conversation_items WHERE tenant_id = ${tenantId}`
    : await sql`SELECT COUNT(*) as c FROM ${sql(tableName)}`;
  return Number(result[0].c);
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

  const batchSize = config.seedBatchSize;

  for (let t = 0; t < tenants.length; t++) {
    const tenantId = tenants[t];
    const tableName = strategy === 'a'
      ? tenantTable('conversation_items', tenantId)
      : 'conversation_items';

    const existing = await countItems(strategy, tableName, tenantId);
    if (existing >= totalPerTenant) {
      console.log(`[items] Tenant ${t + 1}/${tenants.length}: ${tenantId} → already complete (${existing} rows), skipping`);
      continue;
    }

    const toInsert = totalPerTenant - existing;
    console.log(`[items] Tenant ${t + 1}/${tenants.length}: ${tenantId} → ${tableName} (inserting ${toInsert})`);

    // Generate deterministic conversation IDs — must match what workloads query via tenantConversationId()
    const conversationIds: string[] = [];
    for (let i = 0; i < conversationsPerTenant; i++) {
      conversationIds.push(tenantConversationId(tenantId, i));
    }

    const segments = [
      { count: Math.floor(toInsert * 0.75), start: historicalStart, end: historicalEnd },
      { count: Math.floor(toInsert * 0.15), start: recentStart,     end: recentEnd },
      { count: toInsert - Math.floor(toInsert * 0.75) - Math.floor(toInsert * 0.15), start: freshStart, end: freshEnd },
    ];

    let totalInserted = existing;

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

        await retryInsert(() => sql`INSERT INTO ${sql(tableName)} ${sql(rows)}`);

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
