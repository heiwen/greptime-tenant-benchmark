import { sql } from '../db.js';
import { loadTenants } from '../seed/tenants.js';
import { existsSync } from 'fs';

async function main() {
  const args = process.argv.slice(2);

  const strategyIdx = args.indexOf('--strategy');
  const strategyArg = strategyIdx >= 0 ? args[strategyIdx + 1] : 'both';
  const strategies: ('a' | 'b')[] = strategyArg === 'both'
    ? ['a', 'b']
    : [strategyArg as 'a' | 'b'];

  for (const strategy of strategies) {
    if (strategy === 'b') {
      console.log('Dropping Strategy B tables...');
      await sql`DROP TABLE IF EXISTS spans`;
      console.log('  Dropped spans');
      await sql`DROP TABLE IF EXISTS conversation_items`;
      console.log('  Dropped conversation_items');
    }

    if (strategy === 'a') {
      let tenants: string[] = [];
      if (existsSync('./results/tenants.json')) {
        tenants = await loadTenants();
      } else {
        console.error('results/tenants.json not found. Cannot drop Strategy A tables.');
        process.exit(1);
      }

      console.log(`Dropping Strategy A tables for ${tenants.length} tenants...`);
      let dropped = 0;

      for (const tenantId of tenants) {
        const suffix = tenantId.replace(/-/g, '');
        await sql.unsafe(`DROP TABLE IF EXISTS spans_${suffix}`);
        await sql.unsafe(`DROP TABLE IF EXISTS conversation_items_${suffix}`);
        dropped++;

        if (dropped % 10 === 0) {
          console.log(`  Progress: ${dropped}/${tenants.length} tenants dropped`);
        }
      }

      console.log(`Strategy A: dropped tables for ${dropped} tenants`);
    }
  }

  console.log('Drop complete.');
  await sql.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
