import type { WorkloadFn, Scenario } from '../types.js';
import { qTimeS1, qTimeS2 } from '../workloads/q-time.js';
import { qIdS1, qIdS2 } from '../workloads/q-id.js';
import { qFullS1 } from '../workloads/q-full.js';
import { w1 } from '../workloads/w1.js';
import { w2 } from '../workloads/w2.js';

export interface ScenarioRun {
  name: string;
  scenario: Scenario;
  workloadFn: WorkloadFn;
  concurrency: number;
  durationSecs: number;
  tenantDiversity: number;
  description: string;
}

// Mixed workload: 70% qTimeS1(1), 15% qIdS1(1), 10% W2, 5% W1
function makeMixedWorkloadFn(): WorkloadFn {
  const fns = [
    { fn: qTimeS1(1), weight: 0.70 },
    { fn: qIdS1(1),   weight: 0.15 },
    { fn: w2(),       weight: 0.10 },
    { fn: w1(),       weight: 0.05 },
  ];

  return async (ctx) => {
    const r = Math.random();
    let cumulative = 0;
    for (const { fn, weight } of fns) {
      cumulative += weight;
      if (r < cumulative) {
        return fn(ctx);
      }
    }
    return fns[0].fn(ctx);
  };
}

export const SCENARIOS: ScenarioRun[] = [
  // ── S1 workload scenarios (spans) ────────────────────────────────────────
  {
    name: 'w2-1vu',
    scenario: 's1',
    workloadFn: w2(),
    concurrency: 1,
    durationSecs: 120,
    tenantDiversity: 1,
    description: 'Single-tenant span write, 1 VU',
  },
  {
    name: 'w2-10vu',
    scenario: 's1',
    workloadFn: w2(),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Multi-tenant span write, 10 VUs',
  },
  {
    name: 'w2-50vu',
    scenario: 's1',
    workloadFn: w2(),
    concurrency: 50,
    durationSecs: 120,
    tenantDiversity: 50,
    description: 'Multi-tenant span write, 50 VUs',
  },
  {
    name: 'q-time-1h-10vu',
    scenario: 's1',
    workloadFn: qTimeS1(1),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Span time-range query (1h window), 10 VUs',
  },
  {
    name: 'q-time-24h-10vu',
    scenario: 's1',
    workloadFn: qTimeS1(24),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Span time-range query (24h window), 10 VUs',
  },
  {
    name: 'q-time-7d-10vu',
    scenario: 's1',
    workloadFn: qTimeS1(168),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Span time-range query (7d window), 10 VUs',
  },
  {
    name: 'q-id-10vu',
    scenario: 's1',
    workloadFn: qIdS1(1),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Span cursor-pagination query, 10 VUs',
  },
  {
    name: 'q-full-10vu',
    scenario: 's1',
    workloadFn: qFullS1(1),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Span full SELECT * query, 10 VUs',
  },

  // ── S2 workload scenarios (conversation items) ────────────────────────────
  {
    name: 'w1-1vu',
    scenario: 's2',
    workloadFn: w1(),
    concurrency: 1,
    durationSecs: 120,
    tenantDiversity: 1,
    description: 'Single-tenant conversation item write, 1 VU',
  },
  {
    name: 'w1-10vu',
    scenario: 's2',
    workloadFn: w1(),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Multi-tenant conversation item write, 10 VUs',
  },
  {
    name: 'w1-50vu',
    scenario: 's2',
    workloadFn: w1(),
    concurrency: 50,
    durationSecs: 120,
    tenantDiversity: 50,
    description: 'Multi-tenant conversation item write, 50 VUs',
  },
  {
    name: 'q-time-1h-10vu-s2',
    scenario: 's2',
    workloadFn: qTimeS2(1),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Conversation item time-range query (1h window), 10 VUs',
  },
  {
    name: 'q-time-24h-10vu-s2',
    scenario: 's2',
    workloadFn: qTimeS2(24),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Conversation item time-range query (24h window), 10 VUs',
  },
  {
    name: 'q-time-7d-10vu-s2',
    scenario: 's2',
    workloadFn: qTimeS2(168),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Conversation item time-range query (7d window), 10 VUs',
  },
  {
    name: 'q-id-10vu-s2',
    scenario: 's2',
    workloadFn: qIdS2(1),
    concurrency: 10,
    durationSecs: 120,
    tenantDiversity: 10,
    description: 'Conversation item cursor-pagination query, 10 VUs',
  },

  // ── Memory pressure scenarios ─────────────────────────────────────────────
  {
    name: 'm1-1tenant',
    scenario: 's1',
    workloadFn: qTimeS1(24),
    concurrency: 50,
    durationSecs: 300,
    tenantDiversity: 1,
    description: 'Memory pressure: 50 VUs hammering 1 tenant, 5min',
  },
  {
    name: 'm2-5tenants',
    scenario: 's1',
    workloadFn: qTimeS1(24),
    concurrency: 50,
    durationSecs: 300,
    tenantDiversity: 5,
    description: 'Memory pressure: 50 VUs across 5 tenants, 5min',
  },
  {
    name: 'm3-50tenants',
    scenario: 's1',
    workloadFn: qTimeS1(24),
    concurrency: 50,
    durationSecs: 300,
    tenantDiversity: 50,
    description: 'Memory pressure: 50 VUs across 50 tenants, 5min',
  },
  {
    name: 'm4-50tenants-b',
    scenario: 's1',
    workloadFn: qTimeS1(24),
    concurrency: 50,
    durationSecs: 300,
    tenantDiversity: 50,
    description: 'Memory pressure Strategy B: 50 VUs across 50 tenants, 5min',
  },

  // ── Mixed workload scenarios ───────────────────────────────────────────────
  {
    name: 'mixed-10vu',
    scenario: 's1',
    workloadFn: makeMixedWorkloadFn(),
    concurrency: 10,
    durationSecs: 900,
    tenantDiversity: 10,
    description: 'Mixed workload (70% read, 15% paginate, 10% span write, 5% item write), 10 VUs',
  },
  {
    name: 'mixed-50vu',
    scenario: 's1',
    workloadFn: makeMixedWorkloadFn(),
    concurrency: 50,
    durationSecs: 900,
    tenantDiversity: 50,
    description: 'Mixed workload, 50 VUs',
  },
  {
    name: 'mixed-100vu',
    scenario: 's1',
    workloadFn: makeMixedWorkloadFn(),
    concurrency: 100,
    durationSecs: 900,
    tenantDiversity: 100,
    description: 'Mixed workload, 100 VUs',
  },
];
