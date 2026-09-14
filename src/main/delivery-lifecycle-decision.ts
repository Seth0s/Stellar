/**
 * Lifecycle of a programmatic PTY delivery after enqueue — cancel-on-author-
 * death and per-origin rate ceiling. Pure so message-bus keeps only the FIFO
 * chain and the PTY write.
 *
 * Live incident 2026-09-14: origin card looped `send_to_card` into the human
 * PTY; closing the origin killed `cursor-agent` and removed the card row, but
 * `enqueueCardDelivery` FIFO is keyed by DESTINATION — pending items kept
 * typing. Owner: "cuidado, ainda está mandando os probe".
 *
 * Criterion (owner brief): the queue holds pending deliveries, not live
 * intents. When the author ceases to exist, deliveries that have NOT yet
 * started writing must stop counting. A legitimate final report pointer may
 * still be queued when the agent exits — system enqueues omit `requesterId`,
 * so cancel-by-requester leaves them alone. In-flight (`started`) continues:
 * aborting mid-type risks a half-written composer; "written" means the FIFO
 * item has entered `deliverCard`, including confirm / park / steer.
 *
 * Rate (measured 2026-09-14 in tmp/delivery-rate-measure.txt): deliveries are
 * NOT persisted in SQLite. Proxies (reports, task_transitions) peak at ≤2
 * events / 10s per card. The live probe loop was 12 / 23s. Ceiling below
 * turns that loop into an enqueue error for the agent instead of damage at
 * the destination. No special-case for the human card — same cap everywhere.
 */

/** Settled by cancel — never produced by the confirm loop. */
export type CancelledDeliveryState = "cancelled";

export type DeliveryLifecycleRecord = {
  id: string;
  target: string;
  /** Agent `send` stamps this; report/exit pointers and status-ask omit it. */
  requesterId?: string;
  delivery: string;
  /** True once the FIFO item has entered the write path (do not cancel). */
  started?: boolean;
};

export type CancelPendingFromRequesterInput = {
  records: Iterable<DeliveryLifecycleRecord>;
  requesterId: string;
};

export type CancelPendingFromRequesterResult = {
  cancelledIds: string[];
};

/**
 * Drop every not-yet-started queued delivery authored by `requesterId`.
 * In-flight (`started`) and system rows (no requesterId) are untouched.
 */
export function cancelPendingFromRequester(
  input: CancelPendingFromRequesterInput,
): CancelPendingFromRequesterResult {
  const cancelledIds: string[] = [];
  const requesterId = input.requesterId;
  if (!requesterId) return { cancelledIds };

  for (const record of input.records) {
    if (record.requesterId !== requesterId) continue;
    if (record.delivery !== "queued") continue;
    if (record.started) continue;
    cancelledIds.push(record.id);
  }
  return { cancelledIds };
}

/** Sliding-window ceiling for agent `send` enqueues (requester × target). */
export const ORIGIN_DELIVERY_RATE_LIMIT = {
  max: 5,
  windowMs: 10_000,
} as const;

export type OriginDeliveryRateSample = {
  requesterId: string;
  target: string;
  atMs: number;
};

export type OriginDeliveryRateDecision =
  | { action: "allow" }
  | { action: "refuse"; error: string; countInWindow: number };

/**
 * Refuse when this enqueue would push the (requester, target) pair over
 * `ORIGIN_DELIVERY_RATE_LIMIT` inside the sliding window ending at `nowMs`.
 * Call only for agent-authored sends (has requesterId). System pointers skip.
 */
export function decideOriginDeliveryRate(input: {
  samples: readonly OriginDeliveryRateSample[];
  requesterId: string;
  target: string;
  nowMs: number;
  limit?: { max: number; windowMs: number };
}): OriginDeliveryRateDecision {
  const limit = input.limit ?? ORIGIN_DELIVERY_RATE_LIMIT;
  if (!input.requesterId || !input.target) return { action: "allow" };

  const windowStart = input.nowMs - limit.windowMs;
  let countInWindow = 0;
  for (const sample of input.samples) {
    if (sample.requesterId !== input.requesterId) continue;
    if (sample.target !== input.target) continue;
    if (sample.atMs < windowStart) continue;
    countInWindow++;
  }

  if (countInWindow >= limit.max) {
    return {
      action: "refuse",
      countInWindow,
      error:
        `delivery rate limit: card ${input.requesterId} already enqueued ` +
        `${countInWindow} deliveries to ${input.target} within ${limit.windowMs}ms ` +
        `(max ${limit.max}) — likely a loop; wait or cancel pending deliveries`,
    };
  }
  return { action: "allow" };
}

/** Keep only samples that can still affect a future refuse decision. */
export function pruneOriginDeliveryRateSamples(
  samples: readonly OriginDeliveryRateSample[],
  nowMs: number,
  windowMs: number = ORIGIN_DELIVERY_RATE_LIMIT.windowMs,
): OriginDeliveryRateSample[] {
  const windowStart = nowMs - windowMs;
  return samples.filter((s) => s.atMs >= windowStart);
}

export type ListDeliveriesFilter = {
  requesterId?: string;
  target?: string;
  /** When set, only rows whose `delivery` equals this (typically `"queued"`). */
  delivery?: string;
};

export function filterDeliveryRecords<T extends DeliveryLifecycleRecord>(
  records: Iterable<T>,
  filter: ListDeliveriesFilter,
): T[] {
  const out: T[] = [];
  for (const record of records) {
    if (filter.requesterId !== undefined && record.requesterId !== filter.requesterId) continue;
    if (filter.target !== undefined && record.target !== filter.target) continue;
    if (filter.delivery !== undefined && record.delivery !== filter.delivery) continue;
    out.push(record);
  }
  return out;
}
