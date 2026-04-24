import { sql, tenantTable } from '../db.js';
import { config } from '../config.js';
import { formatDuration } from './progress.js';
import { randomJson } from './text.js';
import { itemRowToLp, lpWriteBatch } from './lp.js';
import { tenantConversationId, pickConversationIndex } from '../workloads/helpers.js';
import type { Strategy, ItemType } from '../types.js';

export const ITEM_TYPE_CONFIG: Record<ItemType, { weight: number; dataBytes: number }> = {
  user:      { weight: 0.40, dataBytes:   200 },
  assistant: { weight: 0.40, dataBytes:  1000 },
  tool:      { weight: 0.20, dataBytes:  3000 },
};

const ITEM_TYPES = Object.keys(ITEM_TYPE_CONFIG) as ItemType[];

export function pickItemType(): ItemType {
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

function stratifiedTimestamp(start: number, end: number, index: number, total: number): string {
  const slotSize = (end - start) / total;
  return new Date(start + index * slotSize + Math.random() * slotSize).toISOString();
}

// Half-width of the jitter window around a clustered conversation's anchor time.
const SESSION_HALF_WINDOW_MS = 48 * 60 * 60 * 1000; // ±48 hours

function sessionPad(segStart: number, segEnd: number): number {
  return Math.min(SESSION_HALF_WINDOW_MS, (segEnd - segStart) / 2);
}

function buildConversationAnchors(
  conversationsPerTenant: number,
  timeRanges: { historicalStart: number; historicalEnd: number; recentStart: number; recentEnd: number; freshStart: number; freshEnd: number },
  historicalShare: number,
): Float64Array {
  const { historicalStart, historicalEnd, recentStart, recentEnd, freshStart, freshEnd } = timeRanges;
  const totalShare = historicalShare + 0.15 + 0.10;
  const historicalCount = Math.floor(conversationsPerTenant * historicalShare / totalShare);
  const recentCount     = Math.floor(conversationsPerTenant * 0.15 / totalShare);

  const anchors = new Float64Array(conversationsPerTenant);
  const segments = [
    { count: historicalCount,                                          start: historicalStart, end: historicalEnd },
    { count: recentCount,                                              start: recentStart,     end: recentEnd },
    { count: conversationsPerTenant - historicalCount - recentCount,   start: freshStart,      end: freshEnd },
  ];

  let idx = 0;
  for (const seg of segments) {
    const pad = sessionPad(seg.start, seg.end);
    const anchorStart = seg.start + pad;
    const anchorEnd   = seg.end   - pad;
    for (let i = 0; i < seg.count; i++) {
      anchors[idx++] = anchorStart + Math.random() * (anchorEnd - anchorStart);
    }
  }
  return anchors;
}

function itemTimestampForConversation(anchorMs: number, segStart: number, segEnd: number): string {
  const pad = sessionPad(segStart, segEnd);
  const offset = (Math.random() * 2 - 1) * pad;
  const ts = Math.max(segStart, Math.min(segEnd, anchorMs + offset));
  return new Date(ts).toISOString();
}

async function countItems(strategy: Strategy, tableName: string, tenantId: string): Promise<number> {
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const result = strategy === 'b'
        ? await sql`SELECT COUNT(*) as c FROM conversation_items WHERE tenant_id = ${tenantId}`
        : await sql`SELECT COUNT(*) as c FROM ${sql(tableName)}`;
      return Number(result[0].c);
    } catch {
      if (attempt === 4) {
        // Postgres frontend unreachable under heavy LP load — assume 0 (re-seed this tenant).
        return 0;
      }
      await Bun.sleep(500 * (attempt + 1) + Math.random() * 500);
    }
  }
  return 0;
}

async function seedItemsForTenant(
  strategy: Strategy,
  tenantId: string,
  totalPerTenant: number,
  conversationsPerTenant: number,
  timeRanges: { historicalStart: number; historicalEnd: number; recentStart: number; recentEnd: number; freshStart: number; freshEnd: number },
  onBatch?: (n: number) => void,
): Promise<void> {
  const tableName = strategy === 'a' ? tenantTable('conversation_items', tenantId) : 'conversation_items';
  const lpUrl = `${config.httpUrl}/v1/influxdb/write?db=public&precision=ns`;
  const batchSize = config.seedBatchSize;

  const existing = await countItems(strategy, tableName, tenantId);
  const { historicalStart, historicalEnd, recentStart, recentEnd, freshStart, freshEnd } = timeRanges;

  const hs = config.historicalShare;
  const totalShare = hs + 0.15 + 0.10;
  const effectiveTotal = Math.round(totalPerTenant * totalShare);

  if (existing >= effectiveTotal) {
    return;
  }

  const toInsert = effectiveTotal - existing;

  // Clustered conversations (index < half) all have historical anchors because
  // half = floor(N/2) < floor(N*historicalShare/totalShare) = historicalCount.
  // Assigning clustered conversations to non-historical segments would clamp their
  // items to the segment boundary instead of the anchor neighbourhood, breaking the
  // clustering guarantee. Only the historical segment uses the clustered pool;
  // recent and fresh segments use scattered only.
  const anchors = buildConversationAnchors(conversationsPerTenant, timeRanges, hs);

  const hCount = Math.floor(toInsert * hs / totalShare);
  const rCount = Math.floor(toInsert * 0.15 / totalShare);
  const segments = [
    { count: hCount,                     start: historicalStart, end: historicalEnd, clusteredOk: true  },
    { count: rCount,                     start: recentStart,     end: recentEnd,     clusteredOk: false },
    { count: toInsert - hCount - rCount, start: freshStart,      end: freshEnd,      clusteredOk: false },
  ];

  for (const seg of segments) {
    let segInserted = 0;
    while (segInserted < seg.count) {
      const thisBatch = Math.min(batchSize, seg.count - segInserted);
      const rows: { timestamp: string; line: string }[] = [];
      for (let i = 0; i < thisBatch; i++) {
        const pool = seg.clusteredOk && Math.random() < 0.5 ? 'clustered' : 'scattered';
        const convIdx = pickConversationIndex(pool, conversationsPerTenant);
        const timestamp = pool === 'clustered'
          ? itemTimestampForConversation(anchors[convIdx], seg.start, seg.end)
          : stratifiedTimestamp(seg.start, seg.end, segInserted + i, seg.count);
        const row = generateItemRow(strategy === 'b' ? tenantId : null, tenantConversationId(tenantId, convIdx), timestamp);
        rows.push({ timestamp, line: itemRowToLp(tableName, row, config.itemPk) });
        if (i % 10 === 9) await Bun.sleep(0); // yield so concurrent tasks can interleave
      }
      rows.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
      const lines = rows.map(r => r.line);
      await lpWriteBatch(lpUrl, lines);
      segInserted += thisBatch;
      onBatch?.(thisBatch);
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
  let totalRows = 0;
  const startMs = Date.now();
  const totalRows_target = tenants.length * totalPerTenant;

  console.log(`[items] Seeding ${tenants.length} tenants (${concurrency} concurrent)...`);

  const heartbeat = setInterval(() => {
    const elapsed = (Date.now() - startMs) / 1000;
    const rps = elapsed > 0 ? totalRows / elapsed : 0;
    const eta = rps > 0 ? (totalRows_target - totalRows) / rps : 0;
    const etaStr = eta > 0 ? ` | eta: ${formatDuration(eta * 1000)}` : '';
    console.log(
      `[items] ${completed}/${tenants.length} done, ${inFlight} in-flight | ${totalRows.toLocaleString()} rows | ${rps.toFixed(0)} rows/s | elapsed: ${formatDuration(elapsed * 1000)}${etaStr}`,
    );
  }, 30_000);

  await new Promise<void>((resolve, reject) => {
    function drain() {
      while (inFlight < concurrency && next < tenants.length) {
        const tenantId = tenants[next++];
        inFlight++;

        seedItemsForTenant(strategy, tenantId, totalPerTenant, conversationsPerTenant, timeRanges, (n) => { totalRows += n; })
          .then(() => { completed++; })
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

  clearInterval(heartbeat);
  const elapsed = (Date.now() - startMs) / 1000;
  const rps = elapsed > 0 ? totalRows / elapsed : 0;
  console.log(`[items] Complete: ${completed}/${tenants.length} tenants | ${totalRows.toLocaleString()} rows | avg ${rps.toFixed(0)} rows/s | elapsed: ${formatDuration(elapsed * 1000)}`);
}
