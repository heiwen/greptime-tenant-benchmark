import { config } from '../config.js';
import { join } from 'path';

export function generateTenants(count: number): string[] {
  const hexDigits = '0123456789abcdef';
  const perDigit = Math.floor(count / 16);
  const remainder = count % 16;

  const tenants: string[] = [];

  for (let d = 0; d < 16; d++) {
    // Distribute remainder: first `remainder` digits get one extra tenant
    const thisCount = perDigit + (d < remainder ? 1 : 0);
    const targetChar = hexDigits[d];

    for (let i = 0; i < thisCount; i++) {
      const uuid = crypto.randomUUID();
      // Replace the first character with the target hex digit to ensure
      // uniform partition distribution
      const modified = targetChar + uuid.slice(1);
      tenants.push(modified);
    }
  }

  // Shuffle the array so tenants aren't ordered by hex digit
  for (let i = tenants.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tenants[i], tenants[j]] = [tenants[j], tenants[i]];
  }

  return tenants;
}

export async function saveTenants(tenants: string[]): Promise<void> {
  const path = join(config.resultsDir, 'tenants.json');
  await Bun.write(path, JSON.stringify(tenants, null, 2));
  console.log(`Saved ${tenants.length} tenants to ${path}`);
}

export async function loadTenants(): Promise<string[]> {
  const path = join(config.resultsDir, 'tenants.json');
  const text = await Bun.file(path).text();
  return JSON.parse(text) as string[];
}
