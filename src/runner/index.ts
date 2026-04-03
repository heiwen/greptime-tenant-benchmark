import { config } from '../config.js';
import { loadTenants } from '../seed/tenants.js';
import { sql } from '../db.js';
import { runWorkload } from './concurrency.js';
import { writeCsv } from './metrics.js';
import { startScraping, writeScrapeResults } from './scrape.js';
import { SCENARIOS } from './scenarios.js';
import type { RunResult, Strategy } from '../types.js';
import { existsSync } from 'fs';
import { join } from 'path';

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function printSummaryTable(results: RunResult[]): void {
  if (results.length === 0) {
    console.log('No results to display.');
    return;
  }

  console.log('\n' + '═'.repeat(130));
  console.log(
    pad('Workload', 30) +
    pad('Strategy', 10) +
    pad('Scenario', 10) +
    pad('VUs', 6) +
    pad('Count', 10) +
    pad('Errors', 8) +
    pad('p50ms', 8) +
    pad('p90ms', 8) +
    pad('p95ms', 8) +
    pad('p99ms', 8) +
    pad('QPS', 10) +
    pad('MB/s', 8),
  );
  console.log('─'.repeat(130));

  for (const r of results) {
    console.log(
      pad(r.workload, 30) +
      pad(r.strategy.toUpperCase(), 10) +
      pad(r.scenario.toUpperCase(), 10) +
      pad(r.concurrency, 6) +
      pad(r.count, 10) +
      pad(r.errors, 8) +
      pad(r.p50.toFixed(1), 8) +
      pad(r.p90.toFixed(1), 8) +
      pad(r.p95.toFixed(1), 8) +
      pad(r.p99.toFixed(1), 8) +
      pad(r.throughputQps.toFixed(2), 10) +
      pad(r.throughputMbps.toFixed(3), 8),
    );
  }

  console.log('═'.repeat(130));
}

async function main() {
  const args = process.argv.slice(2);

  // Parse --strategy
  const strategyIdx = args.indexOf('--strategy');
  const strategyArg = strategyIdx >= 0 ? args[strategyIdx + 1] : 'both';
  const strategies: Strategy[] = strategyArg === 'both'
    ? ['a', 'b']
    : [strategyArg as Strategy];

  // Parse --scenario (comma-separated names, or 'all')
  const scenarioIdx = args.indexOf('--scenario');
  const scenarioFilter = scenarioIdx >= 0 ? args[scenarioIdx + 1].split(',').map((s) => s.trim()) : null;

  // Parse --skip-scrape
  const skipScrape = args.includes('--skip-scrape');

  // Parse --no-warmup (skips 60s warmup — useful for local/smoke runs)
  const noWarmup = args.includes('--no-warmup');

  // Parse --output
  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : config.resultsDir;

  // Load tenants
  const tenantsFile = join(config.resultsDir, 'tenants.json');
  if (!existsSync(tenantsFile)) {
    console.error(`Tenants file not found: ${tenantsFile}`);
    console.error('Run seed first: bun run src/seed/index.ts --strategy a|b');
    process.exit(1);
  }

  const allTenants = await loadTenants();
  console.log(`Loaded ${allTenants.length} tenants`);

  // Filter scenarios
  const selectedScenarios = scenarioFilter
    ? SCENARIOS.filter((s) => scenarioFilter.includes(s.name))
    : SCENARIOS;

  if (selectedScenarios.length === 0) {
    console.error('No matching scenarios found.');
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const allResults: RunResult[] = [];

  for (const strategy of strategies) {
    for (const scenario of selectedScenarios) {
      // m4-50tenants-b is Strategy B only
      if (scenario.name === 'm4-50tenants-b' && strategy !== 'b') {
        console.log(`Skipping ${scenario.name} for strategy ${strategy.toUpperCase()} (B only)`);
        continue;
      }

      const tenantSubset = allTenants.slice(0, Math.min(scenario.tenantDiversity, allTenants.length));

      console.log(`\n${'─'.repeat(80)}`);
      console.log(`Running: ${scenario.name} | Strategy ${strategy.toUpperCase()} | ${scenario.concurrency} VUs | ${scenario.durationSecs}s`);
      console.log(`  ${scenario.description}`);
      console.log(`  Tenants: ${tenantSubset.length}`);

      // Start Prometheus scraping
      let scraper: ReturnType<typeof startScraping> | null = null;
      if (!skipScrape) {
        scraper = startScraping(config.prometheusUrl, 5000);
      }

      // Warm-up phase (60s, results discarded) — skip with --no-warmup for local runs
      if (noWarmup) {
        console.log('  Warm-up: skipped (--no-warmup)');
      } else {
        console.log(`  Warm-up: 60s at ${scenario.concurrency} VUs...`);
        await runWorkload({
          workloadFn: scenario.workloadFn,
          tenants: tenantSubset,
          strategy,
          concurrency: scenario.concurrency,
          durationSecs: 60,
        });
        console.log('  Warm-up complete.');
      }

      // Actual benchmark
      console.log(`  Benchmark: ${scenario.durationSecs}s...`);
      const benchStart = Date.now();
      const metrics = await runWorkload({
        workloadFn: scenario.workloadFn,
        tenants: tenantSubset,
        strategy,
        concurrency: scenario.concurrency,
        durationSecs: scenario.durationSecs,
      });
      const actualDuration = (Date.now() - benchStart) / 1000;

      // Stop scraping
      if (scraper) {
        scraper.stop();
        const snapshots = scraper.getSnapshots();
        const scrapeFile = join(outputDir, `scrape-${strategy}-${scenario.name}-${timestamp}.json`);
        await writeScrapeResults(snapshots, scrapeFile);
        console.log(`  Prometheus snapshots: ${snapshots.length} → ${scrapeFile}`);
      }

      const result = metrics.summary(
        scenario.name,
        strategy,
        scenario.scenario,
        scenario.concurrency,
        actualDuration,
      );

      allResults.push(result);

      console.log(
        `  Done: ${result.count} ops, ${result.errors} errors, ` +
        `p50=${result.p50.toFixed(1)}ms p99=${result.p99.toFixed(1)}ms ` +
        `QPS=${result.throughputQps.toFixed(2)}`,
      );

      // Write incremental CSV after each scenario
      const csvFile = join(outputDir, `results-${strategy}-${timestamp}.csv`);
      const strategyResults = allResults.filter((r) => r.strategy === strategy);
      await writeCsv(strategyResults, csvFile);
    }
  }

  // Final summary
  printSummaryTable(allResults);

  // Write combined CSV
  const combinedCsv = join(outputDir, `results-combined-${timestamp}.csv`);
  await writeCsv(allResults, combinedCsv);
  console.log(`\nResults written to ${combinedCsv}`);

  await sql.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
