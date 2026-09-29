/** Backoff schedule (ms) for the success page: 1s,2s,3s,5s,5s... stopping after ~30s total. */
export function pollDelays(totalMs = 30_000): number[] {
  const steps = [1000, 2000, 3000];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; sum < totalMs; i++) {
    const d = steps[i] ?? 5000;
    out.push(d);
    sum += d;
  }
  return out;
}
