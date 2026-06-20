// Run an async fn over items with a bounded number of calls in flight,
// preserving input order in the results. Routing a real suite is hundreds of
// model calls; doing them one at a time is the difference between seconds and
// minutes. The bound keeps us from stampeding the provider's rate limit.

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  let next = 0;

  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
