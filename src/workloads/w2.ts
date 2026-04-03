import { sql, tenantTable } from '../db.js';
import { generateSpanRow, pickTier, TIER_CONFIG } from '../seed/spans.js';
import type { WorkloadFn } from './types.js';

export function w2(): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    const tableName = strategy === 'a'
      ? tenantTable('spans', tenantId)
      : 'spans';

    const tier = pickTier();
    const tierRowBytes = TIER_CONFIG[tier].totalRowBytes;
    const traceId = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const baseTs = BigInt(Date.now());

    const rows: Record<string, unknown>[] = [];

    // Root span (no parent)
    const rootRow = generateSpanRow(strategy === 'b' ? tenantId : null, baseTs);
    rootRow.trace_id = traceId;
    rootRow.parent_span_id = null;
    rows.push(rootRow);

    // 4 child spans
    const rootSpanId = rootRow.span_id as string;
    for (let i = 1; i < 5; i++) {
      const childTs = baseTs + BigInt(i * 10); // slight offset
      const childRow = generateSpanRow(strategy === 'b' ? tenantId : null, childTs);
      childRow.trace_id = traceId;
      childRow.parent_span_id = rootSpanId;
      rows.push(childRow);
    }

    await sql`INSERT INTO ${sql(tableName)} ${sql(rows)}`;

    return { bytes: 5 * tierRowBytes };
  };
}
