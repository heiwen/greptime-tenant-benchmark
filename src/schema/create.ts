import { sql } from '../db.js';
import { spansTableA, spansTableB, conversationItemsTableA, conversationItemsTableB } from './ddl.js';
import { loadTenants } from '../seed/tenants.js';
import { existsSync } from 'fs';

async function main() {
  const args = process.argv.slice(2);

  const strategyIdx = args.indexOf('--strategy');
  const strategyArg = strategyIdx >= 0 ? args[strategyIdx + 1] : 'both';
  const strategies: ('a' | 'b')[] = strategyArg === 'both'
    ? ['a', 'b']
    : [strategyArg as 'a' | 'b'];

  const dropFlag = args.includes('--drop');

  const tenantsIdx = args.indexOf('--tenants');
  let tenants: string[] = [];

  if (strategies.includes('a')) {
    if (tenantsIdx >= 0) {
      tenants = args[tenantsIdx + 1].split(',').map((t) => t.trim());
    } else if (existsSync('./results/tenants.json')) {
      tenants = await loadTenants();
    } else {
      console.error('Strategy A requires tenant list. Pass --tenants or ensure results/tenants.json exists.');
      process.exit(1);
    }
  }

  for (const strategy of strategies) {
    if (strategy === 'b') {
      console.log('Creating Strategy B tables...');

      if (dropFlag) {
        console.log('  Dropping existing spans...');
        await sql`DROP TABLE IF EXISTS spans`;
        console.log('  Dropping existing conversation_items...');
        await sql`DROP TABLE IF EXISTS conversation_items`;
      }

      try {
        console.log('  Creating spans (Strategy B)...');
        await sql.unsafe(spansTableB());
        console.log('  Created spans');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Skipped spans (already exists or error): ${msg}`);
      }

      try {
        console.log('  Creating conversation_items (Strategy B)...');
        await sql.unsafe(conversationItemsTableB());
        console.log('  Created conversation_items');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Skipped conversation_items (already exists or error): ${msg}`);
      }
    }

    if (strategy === 'a') {
      const CONCURRENCY = 20;
      console.log(`Creating Strategy A tables for ${tenants.length} tenants (${CONCURRENCY} concurrent)...`);
      let created = 0;
      let skipped = 0;
      let inFlight = 0;
      let next = 0;

      await new Promise<void>((resolve, reject) => {
        function drain() {
          while (inFlight < CONCURRENCY && next < tenants.length) {
            const tenantId = tenants[next++];
            inFlight++;

            (async () => {
              if (dropFlag) {
                const spanTable = `spans_${tenantId.replace(/-/g, '')}`;
                const itemTable = `conversation_items_${tenantId.replace(/-/g, '')}`;
                await sql.unsafe(`DROP TABLE IF EXISTS ${spanTable}`);
                await sql.unsafe(`DROP TABLE IF EXISTS ${itemTable}`);
              }

              try {
                await sql.unsafe(spansTableA(tenantId));
                created++;
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`  Skipped spans for ${tenantId}: ${msg}`);
                skipped++;
              }

              try {
                await sql.unsafe(conversationItemsTableA(tenantId));
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`  Skipped conversation_items for ${tenantId}: ${msg}`);
              }

              const done = created + skipped;
              if (done % 100 === 0 || done === tenants.length) {
                console.log(`  Progress: ${done}/${tenants.length} tenants`);
              }
            })().then(() => {
              inFlight--;
              if (next === tenants.length && inFlight === 0) {
                resolve();
              } else {
                drain();
              }
            }).catch(reject);
          }
        }
        drain();
        if (tenants.length === 0) resolve();
      });

      console.log(`Strategy A: created ${created} tenant table sets, skipped ${skipped}`);
    }
  }

  console.log('Schema creation complete.');
  await sql.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
