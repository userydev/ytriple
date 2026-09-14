/**
 * Deterministic id generation.
 *
 * Core may use neither randomness nor the wall clock, and there is no id port:
 * ids come from a per-task counter instead. The payoff is that two runs of the
 * same task produce identical ids, which is what makes recorded provider
 * fixtures and snapshot replays possible.
 */
export interface IdFactory {
  next(prefix: string): string;
}

export function createIdFactory(): IdFactory {
  const counters = new Map<string, number>();

  return {
    next(prefix) {
      const current = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, current);
      return `${prefix}-${current}`;
    },
  };
}
