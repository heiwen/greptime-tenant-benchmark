import { SQL } from 'bun';
import { config } from './config.js';

export const sql = new SQL(config.dbUrl, {
  max: 100,
  idleTimeout: 20,
  connectionTimeout: 10,
  ssl: false,   // local Docker has no TLS
});

export function tenantSuffix(tenantId: string): string {
  return tenantId.replace(/-/g, '');
}

export function tenantTable(base: string, tenantId: string): string {
  return `${base}_${tenantSuffix(tenantId)}`;
}
