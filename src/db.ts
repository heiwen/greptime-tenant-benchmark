import postgres from 'postgres';
import { config } from './config.js';

export const sql = postgres(config.dbUrl, {
  max: 100,
  idle_timeout: 20,
  connect_timeout: 10,
});

export function tenantSuffix(tenantId: string): string {
  return tenantId.replace(/-/g, '');
}

export function tenantTable(base: string, tenantId: string): string {
  return `${base}_${tenantSuffix(tenantId)}`;
}
