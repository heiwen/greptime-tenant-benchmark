export type Strategy = 'a' | 'b';
export type Scenario = 's1' | 's2';
export type SpanTier = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';
export type ItemType = 'user' | 'assistant' | 'tool';

export interface WorkloadContext {
  tenantId: string;
  strategy: Strategy;
}

export type WorkloadFn = (ctx: WorkloadContext) => Promise<{ bytes?: number }>;

export interface RunResult {
  workload: string;
  strategy: Strategy;
  scenario: Scenario;
  concurrency: number;
  durationSecs: number;
  count: number;
  errors: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  throughputQps: number;
  throughputMbps: number;
}
