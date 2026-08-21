/** Result of one item in a `mapGrouped` run — never a rejection. */
export type Settled<T, R> =
  | { item: T; value: R; error?: undefined }
  | { item: T; value?: undefined; error: unknown };

/**
 * Run `fn` over `items` concurrently, but never twice at once within a group.
 *
 * The manage tick marks every open position over the network, and those calls
 * used to be strictly serial, so the tick paid the SUM of every position's
 * latency. That is what pushed mean mark gaps past the poll budget
 * (RANGE-SHAPE-DECISION.md integrity (a) measured 16-19s against poll_s=15,
 * and the loop sleeps `max(0, poll - elapsed)`, so an over-budget tick has no
 * sleep left to give back). Running them concurrently issues exactly the same
 * API calls — it only stops them queueing behind each other.
 *
 * Grouping is the safety half, and the reason this is not a plain Promise.all.
 * The live executor caches one DLMM pool object per address and
 * `refetchStates()` mutates that object in place, so two positions in the same
 * pool — a tranche pair, or a re-entry — must not mark at the same time. Items
 * sharing a group key run one at a time, in their original order.
 *
 * `limit` caps how many groups are in flight, because the peak request rate is
 * what trips an RPC provider's rate limiter, not the total.
 *
 * Never rejects: a throwing item yields `{ error }` so callers keep the
 * per-item try/catch semantics they had when this was a `for` loop. Results
 * come back in input order.
 */
export async function mapGrouped<T, R>(
  items: readonly T[],
  groupKey: (item: T) => string,
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<Array<Settled<T, R>>> {
  const out = new Array<Settled<T, R>>(items.length);
  const groups = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = groupKey(item);
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });

  const queue = [...groups.values()];
  let next = 0;
  // Safe without a lock: `next++` cannot interleave, since nothing awaits
  // between the read and the write.
  const worker = async (): Promise<void> => {
    for (;;) {
      const group = queue[next++];
      if (!group) return;
      for (const i of group) {
        const item = items[i]!;
        try {
          out[i] = { item, value: await fn(item) };
        } catch (error) {
          out[i] = { item, error };
        }
      }
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}
