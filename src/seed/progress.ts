function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function makeProgressLogger(label: string, total: number) {
  const startMs = Date.now();
  // Log every 5% of tenants, but at least every 50 and at most every 500.
  const interval = Math.min(500, Math.max(50, Math.round(total * 0.05)));

  return function log(completed: number): void {
    if (completed !== total && completed % interval !== 0) return;

    const elapsedMs = Date.now() - startMs;
    const rate = completed / (elapsedMs / 1000); // tenants/sec
    const remainingSecs = rate > 0 ? (total - completed) / rate : 0;
    const pct = Math.round((completed / total) * 100);

    const etaPart = completed < total
      ? ` | eta: ${formatDuration(remainingSecs * 1000)}`
      : ' | done';

    console.log(
      `[${label}] ${completed}/${total} (${pct}%) | elapsed: ${formatDuration(elapsedMs)} | ${rate.toFixed(1)} t/s${etaPart}`,
    );
  };
}
