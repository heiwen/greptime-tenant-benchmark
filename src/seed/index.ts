import { config } from '../config.js';
import { generateTenants, saveTenants, loadTenants } from './tenants.js';
import { seedSpans, TIER_CONFIG } from './spans.js';
import { seedConversationItems, ITEM_TYPE_CONFIG } from './conversations.js';
import { sql } from '../db.js';
import { existsSync } from 'fs';
import { join } from 'path';

async function pipeWithPrefix(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer) process.stdout.write(prefix + buffer + '\n');
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line) process.stdout.write(prefix + line + '\n');
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  const strategyIdx = args.indexOf('--strategy');
  if (strategyIdx < 0) {
    console.error('Usage: bun run src/seed/index.ts --strategy a|b [--workers N] [--scenario s1|s2|all] [--tenants t1,t2,...]');
    process.exit(1);
  }
  const strategyArg = args[strategyIdx + 1];
  if (strategyArg !== 'a' && strategyArg !== 'b') {
    console.error('--strategy must be a or b');
    process.exit(1);
  }
  const strategy = strategyArg as 'a' | 'b';

  const tenantsFile = join(config.resultsDir, 'tenants.json');

  // --- Orchestrator: spawn N worker processes ---
  const workersIdx = args.indexOf('--workers');
  const workerIndexIdx = args.indexOf('--worker-index');

  if (workerIndexIdx < 0) {
    const workerCount = workersIdx >= 0 ? parseInt(args[workersIdx + 1], 10) : config.seedWorkers;
    if (isNaN(workerCount) || workerCount < 1) {
      console.error('--workers must be a positive integer');
      process.exit(1);
    }

    // Ensure tenants file exists before workers start
    if (!existsSync(tenantsFile)) {
      console.log(`Generating ${config.tenantCount} tenants...`);
      const tenants = generateTenants(config.tenantCount);
      await saveTenants(tenants);
    }

    console.log(`Spawning ${workerCount} workers for strategy ${strategy.toUpperCase()}...`);

    const baseArgs = workersIdx >= 0
      ? args.filter((_, i) => i !== workersIdx && i !== workersIdx + 1)
      : args;
    const procs = Array.from({ length: workerCount }, (_, i) =>
      Bun.spawn({
        cmd: [process.execPath, process.argv[1], ...baseArgs, '--worker-index', String(i), '--worker-count', String(workerCount)],
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env as Record<string, string>,
      }),
    );

    const exitCodes = await Promise.all(
      procs.map(async (proc, i) => {
        const prefix = `[W${i}] `;
        await Promise.all([
          pipeWithPrefix(proc.stdout, prefix),
          pipeWithPrefix(proc.stderr, prefix),
        ]);
        return proc.exited;
      }),
    );

    if (exitCodes.some((code) => code !== 0)) {
      console.error(`Workers exited with codes: ${exitCodes.join(', ')}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // --- Worker or single-process mode ---
  const scenarioIdx = args.indexOf('--scenario');
  const scenarioArg = scenarioIdx >= 0 ? args[scenarioIdx + 1] : 'all';
  const runS1 = scenarioArg === 'all' || scenarioArg === 's1';
  const runS2 = scenarioArg === 'all' || scenarioArg === 's2';

  // Load or generate tenants
  let tenants: string[];
  const tenantsIdx = args.indexOf('--tenants');

  if (tenantsIdx >= 0) {
    tenants = args[tenantsIdx + 1].split(',').map((t) => t.trim());
    console.log(`Using ${tenants.length} tenants from --tenants argument`);
  } else if (existsSync(tenantsFile)) {
    tenants = await loadTenants();
    console.log(`Loaded ${tenants.length} tenants from ${tenantsFile}`);
  } else {
    console.log(`Generating ${config.tenantCount} tenants...`);
    tenants = generateTenants(config.tenantCount);
    await saveTenants(tenants);
  }

  // Slice tenants for this worker
  if (workerIndexIdx >= 0) {
    const workerIndex = parseInt(args[workerIndexIdx + 1], 10);
    const workerCount = parseInt(args[args.indexOf('--worker-count') + 1], 10);
    const chunkSize = Math.ceil(tenants.length / workerCount);
    tenants = tenants.slice(workerIndex * chunkSize, (workerIndex + 1) * chunkSize);
    console.log(`Worker ${workerIndex}: ${tenants.length} tenants`);
  }

  const spansPerTenant = Math.max(1, Math.round(config.spansPerTenant * config.sparseMultiplier));
  const itemsPerTenant = Math.max(1, Math.round(config.itemsPerTenant * config.sparseMultiplier));
  const conversationsPerTenant = Math.max(1, Math.round(config.conversationsPerTenant * config.sparseMultiplier));

  if (config.sparseMultiplier !== 1.0) {
    console.log(`Sparse mode: ${config.sparseMultiplier}× — ${spansPerTenant} spans/tenant, ${itemsPerTenant} items/tenant`);
  }

  const startTime = Date.now();

  if (runS1) {
    console.log(`\nSeeding spans (S1) for strategy ${strategy.toUpperCase()}...`);
    console.log(`  Tenants: ${tenants.length}, spans per tenant: ${spansPerTenant}, concurrency: ${config.seedConcurrency}`);
    await seedSpans(strategy, tenants, spansPerTenant);
  }

  if (runS2) {
    console.log(`\nSeeding conversation items (S2) for strategy ${strategy.toUpperCase()}...`);
    console.log(`  Tenants: ${tenants.length}, items per tenant: ${itemsPerTenant}, concurrency: ${config.seedConcurrency}`);
    await seedConversationItems(strategy, tenants, itemsPerTenant, conversationsPerTenant);
  }

  const elapsedSecs = (Date.now() - startTime) / 1000;

  let estimatedBytes = 0;
  if (runS1) {
    const avgSpanBytes = Object.values(TIER_CONFIG).reduce(
      (sum, c) => sum + c.share * c.totalRowBytes,
      0,
    );
    estimatedBytes += tenants.length * spansPerTenant * avgSpanBytes;
  }
  if (runS2) {
    const avgItemBytes = Object.values(ITEM_TYPE_CONFIG).reduce(
      (sum, c) => sum + c.weight * c.dataBytes,
      0,
    ) + 200;
    estimatedBytes += tenants.length * itemsPerTenant * avgItemBytes;
  }

  const estimatedGb = (estimatedBytes / 1e9).toFixed(2);
  console.log(`\nSeeding complete in ${elapsedSecs.toFixed(1)}s`);
  console.log(`Estimated data seeded: ~${estimatedGb} GB`);

  await sql.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
