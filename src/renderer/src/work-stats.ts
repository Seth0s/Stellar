/**
 * Work-flow numbers for the Fila "Como anda" panel.
 *
 * Parent task `identidade-de-ator` (5447cddc): there is no reliable
 * subject ("who"). Stats are by provider/model/task class only — never
 * invent an agent leaderboard.
 *
 * Every aggregate here is computable from existing tables
 * (`task_transitions`, `task_verdicts`, `task_cards`) with no new column.
 */

/** Below this n, a provider/model comparison is labeled insufficient —
 * counts stay visible, rates/percentages do not. */
export const MIN_COMPARE_N = 5;

export type ArrivalCycle = {
  taskId: string;
  /** First `to_value='pending'` (inclusive start). */
  firstPendingAt: number;
  /** First `to_value='done'` after that start. */
  firstDoneAt: number;
  /** `firstDoneAt - firstPendingAt` (ms). */
  ms: number;
  /** True when any later transition leaves `done` (from_value='done'). */
  reopened: boolean;
};

export type WorkStatsCoverage = {
  tasksInView: number;
  doneWithCycle: number;
  doneWithRounds: number;
  reopened: number;
  verdictRows: number;
  verdictTyped: number;
  verdictNull: number;
  participations: number;
  orphanParticipations: number;
  withProvider: number;
};

export type ProviderRoundStats = {
  /** `provider` or `provider/model` when model is known. */
  key: string;
  provider: string;
  model: string | null;
  tasks: number;
  medianRounds: number | null;
  /** True when `tasks < MIN_COMPARE_N` — UI must not dress this as a rate. */
  insufficient: boolean;
};

export type WorkStats = {
  coverage: WorkStatsCoverage;
  /** Median first-pending → first-done among tasks that have both. */
  medianCycleMs: number | null;
  /** Median count of `task_verdicts` rows per done task that has ≥1 row. */
  medianRounds: number | null;
  providerRounds: ProviderRoundStats[];
  cycles: ArrivalCycle[];
};

/** Sorted median. Empty → null (absence, never 0 pretending to be data). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Arrival cycle: start = first transition to `pending`, end = first
 * transition to `done`. A later leave from `done` sets `reopened` but
 * does NOT stretch the headline interval — stretching to last-done
 * would hide the bounce. Callers surface `reopened` as its own count.
 *
 * Tasks without both bounds are omitted (honest absence).
 */
export function computeArrivalCycles(
  byTask: ReadonlyMap<string, readonly { toValue: string; fromValue?: string | null; at: number }[]>,
): ArrivalCycle[] {
  const out: ArrivalCycle[] = [];
  for (const [taskId, transitions] of byTask) {
    let firstPendingAt: number | null = null;
    let firstDoneAt: number | null = null;
    let reopened = false;
    for (const tr of transitions) {
      if (firstPendingAt === null && tr.toValue === "pending") firstPendingAt = tr.at;
      if (firstPendingAt !== null && firstDoneAt === null && tr.toValue === "done" && tr.at >= firstPendingAt) {
        firstDoneAt = tr.at;
      }
      if (tr.fromValue === "done" && tr.toValue !== "done") reopened = true;
      // When fromValue is absent (board trail only has toValue), detect
      // reopen as a transition TO a non-done after we already saw done.
      if (tr.fromValue === undefined && firstDoneAt !== null && tr.toValue !== "done" && tr.at > firstDoneAt) {
        reopened = true;
      }
    }
    if (firstPendingAt === null || firstDoneAt === null) continue;
    out.push({
      taskId,
      firstPendingAt,
      firstDoneAt,
      ms: firstDoneAt - firstPendingAt,
      reopened,
    });
  }
  return out;
}

export type WorkStatsInputTask = {
  id: string;
  status: string;
  verdicts: readonly { verdict: string | null; provider: string | null; at: number }[];
  cards: readonly {
    cardId: string;
    role: string;
    provider: string | null;
    model?: string | null;
    /** True when the `cards` row is gone (LEFT JOIN miss). */
    orphan?: boolean;
  }[];
  statusTransitions: readonly { toValue: string; fromValue?: string | null; at: number }[];
};

/**
 * Aggregate the few numbers the Fila panel shows. Scope = the task list
 * passed in (live sprint or frozen snapshot) — same lens as the board.
 */
export function computeWorkStats(tasks: readonly WorkStatsInputTask[]): WorkStats {
  const byTask = new Map<string, WorkStatsInputTask["statusTransitions"]>();
  for (const t of tasks) byTask.set(t.id, t.statusTransitions);
  const cycles = computeArrivalCycles(byTask);

  let verdictRows = 0;
  let verdictTyped = 0;
  let verdictNull = 0;
  let participations = 0;
  let orphanParticipations = 0;
  let withProvider = 0;
  const roundsPerDone: number[] = [];
  let doneWithRounds = 0;
  const providerBuckets = new Map<string, { provider: string; model: string | null; rounds: number[] }>();

  for (const t of tasks) {
    for (const c of t.cards) {
      participations += 1;
      if (c.orphan) orphanParticipations += 1;
      if (c.provider) withProvider += 1;
    }
    verdictRows += t.verdicts.length;
    for (const v of t.verdicts) {
      if (v.verdict === "aprovado" || v.verdict === "reprovado") verdictTyped += 1;
      else verdictNull += 1;
    }
    if (t.status === "done" && t.verdicts.length > 0) {
      doneWithRounds += 1;
      roundsPerDone.push(t.verdicts.length);
      // Provider class for the task: prefer implementer profile, else any
      // card with a provider. No "who" — class only.
      const impl = t.cards.find((c) => c.role === "implementer" && c.provider) ?? t.cards.find((c) => c.provider);
      if (impl?.provider) {
        const model = impl.model ?? null;
        const key = model ? `${impl.provider}/${model}` : impl.provider;
        const bucket = providerBuckets.get(key) ?? { provider: impl.provider, model, rounds: [] };
        bucket.rounds.push(t.verdicts.length);
        providerBuckets.set(key, bucket);
      }
    }
  }

  const providerRounds: ProviderRoundStats[] = [...providerBuckets.entries()]
    .map(([key, b]) => ({
      key,
      provider: b.provider,
      model: b.model,
      tasks: b.rounds.length,
      medianRounds: median(b.rounds),
      insufficient: b.rounds.length < MIN_COMPARE_N,
    }))
    .sort((a, b) => b.tasks - a.tasks || a.key.localeCompare(b.key));

  return {
    coverage: {
      tasksInView: tasks.length,
      doneWithCycle: cycles.length,
      doneWithRounds,
      reopened: cycles.filter((c) => c.reopened).length,
      verdictRows,
      verdictTyped,
      verdictNull,
      participations,
      orphanParticipations,
      withProvider,
    },
    medianCycleMs: median(cycles.map((c) => c.ms)),
    medianRounds: median(roundsPerDone),
    providerRounds,
    cycles,
  };
}

/** Display helper — minutes, one decimal when < 10, else integer. */
export function formatCycleMinutes(ms: number): string {
  const min = ms / 60_000;
  if (min < 10) return `${(Math.round(min * 10) / 10).toFixed(1)}`;
  return String(Math.round(min));
}
