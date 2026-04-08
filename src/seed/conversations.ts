import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import { makeProgressLogger } from './progress.js';
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
  timestamp: string,
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

function randomTimestampInRange(startMs: number, endMs: number): string {
  return new Date(startMs + Math.random() * (endMs - startMs)).toISOString();
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

async function seedItemsForTenant(
  strategy: Strategy,
  tenantId: string,
  totalPerTenant: number,
  conversationsPerTenant: number,
  timeRanges: { historicalStart: number; historicalEnd: number; recentStart: number; recentEnd: number; freshStart: number; freshEnd: number },
): Promise<void> {
  const tableName = strategy === 'a' ? tenantTable('conversation_items', tenantId) : 'conversation_items';
  const batchSize = config.seedBatchSize;

  const existing = await countItems(strategy, tableName, tenantId);
  if (existing >= totalPerTenant) {
    return;
  }

  const toInsert = totalPerTenant - existing;
  const { historicalStart, historicalEnd, recentStart, recentEnd, freshStart, freshEnd } = timeRanges;

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

  for (const seg of segments) {
    let segInserted = 0;
    while (segInserted < seg.count) {
      const thisBatch = Math.min(batchSize, seg.count - segInserted);
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < thisBatch; i++) {
        const conversationId = conversationIds[Math.floor(Math.random() * conversationIds.length)];
        rows.push(generateItemRow(strategy === 'b' ? tenantId : null, conversationId, randomTimestampInRange(seg.start, seg.end)));
      }
      await retryInsert(() => sql`INSERT INTO ${sql(tableName)} ${sql(rows)}`);
      segInserted += thisBatch;
    }
  }
}

export async function seedConversationItems(
  strategy: Strategy,
  tenants: string[],
  totalPerTenant: number,
  conversationsPerTenant: number,
  concurrency = config.seedConcurrency,
): Promise<void> {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;
  const MS_PER_MONTH = 30 * MS_PER_DAY;

  const timeRanges = {
    historicalStart: now - 18 * MS_PER_MONTH,
    historicalEnd:   now - 4  * MS_PER_MONTH,
    recentStart:     now - 3  * MS_PER_MONTH,
    recentEnd:       now - 1  * MS_PER_MONTH,
    freshStart:      now - 7  * MS_PER_DAY,
    freshEnd:        now,
  };

  let completed = 0;
  let next = 0;
  let inFlight = 0;
  const logProgress = makeProgressLogger('items', tenants.length);

  console.log(`[items] Seeding ${tenants.length} tenants (${concurrency} concurrent)...`);

  await new Promise<void>((resolve, reject) => {
    function drain() {
      while (inFlight < concurrency && next < tenants.length) {
        const tenantId = tenants[next++];
        inFlight++;

        seedItemsForTenant(strategy, tenantId, totalPerTenant, conversationsPerTenant, timeRanges)
          .then(() => {
            completed++;
            logProgress(completed);
          })
          .catch(reject)
          .finally(() => {
            inFlight--;
            if (next === tenants.length && inFlight === 0) {
              resolve();
            } else {
              drain();
            }
          });
      }
    }
    drain();
    if (tenants.length === 0) resolve();
  });

  console.log(`[items] Complete: ${completed} seeded`);
}
