// Bounded-concurrency map.
//
// treg has no per-token concurrency limit, and the work is I/O bound, so the paid steps run
// several at a time. The worker count is the backpressure: N in flight, no more, no queue of
// promises the runtime has to hold.

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit max in-flight calls
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>} results in input order
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(limit | 0 || 1, items.length));
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
