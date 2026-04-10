import { SQL } from 'bun';
import { config } from './config.js';

export const sql = new SQL(config.dbUrl, {
  max: 100,
  idleTimeout: 300,
  connectionTimeout: 10,
  ssl: false,    // local Docker has no TLS
  prepare: false, // workaround: Bun.SQL keys prepared statement cache on null/non-null
                  // type per parameter, so batches with variable nullability accumulate
                  // a new named prepared statement per batch, growing server memory until
                  // OOM. Disabling named prepared statements avoids this; parameterization
                  // is preserved. Impact on this benchmark is negligible.
});

export function tenantSuffix(tenantId: string): string {
  return tenantId.replace(/-/g, '');
}

export function tenantTable(base: string, tenantId: string): string {
  return `${base}_${tenantSuffix(tenantId)}`;
}
