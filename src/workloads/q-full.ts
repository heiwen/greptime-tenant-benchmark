import { sql, tenantTable } from '../db.js';
import type { WorkloadFn } from './types.js';
import { TIER_CONFIG } from '../seed/spans.js';

// Compute average row size based on tier distribution
const AVG_ROW_BYTES = Object.values(TIER_CONFIG).reduce(
  (sum, c) => sum + c.share * c.totalRowBytes,
  0,
);

export function qFullS1(windowHours: number): WorkloadFn {
  return async ({ tenantId, strategy }) => {
    const cutoff = new Date(Date.now() - windowHours * 3600 * 1000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rows: any[];

    if (strategy === 'b') {
      rows = await sql`
        SELECT *
        FROM spans
        WHERE tenant_id = ${tenantId}
          AND "timestamp" > ${cutoff}
        ORDER BY "timestamp" DESC
        LIMIT 50
      `;
    } else {
      const table = tenantTable('spans', tenantId);
      rows = await sql`
        SELECT *
        FROM ${sql(table)}
        WHERE "timestamp" > ${cutoff}
        ORDER BY "timestamp" DESC
        LIMIT 50
      `;
    }

    const estimatedBytes = (rows as unknown[]).length * AVG_ROW_BYTES;
    return { bytes: estimatedBytes };
  };
}
