/**
 * Period numbers and sprint-close copy for the V4 Graphs and Sprints screens.
 * Counts only attributable verdicts (`aprovado` / `reprovado`).
 */

export type ChartPeriod = "sprint" | "7" | "30";

const DAY_MS = 86_400_000;

export function periodCutoff(period: ChartPeriod, now: number): number | null {
  if (period === "sprint") return null;
  const days = period === "7" ? 7 : 30;
  return now - days * DAY_MS;
}

export function previousPeriodCutoff(period: ChartPeriod, now: number): number | null {
  if (period === "sprint") return null;
  const days = period === "7" ? 7 : 30;
  return now - days * 2 * DAY_MS;
}

export function inPeriod(updatedAt: number, period: ChartPeriod, now: number): boolean {
  const from = periodCutoff(period, now);
  if (from === null) return true;
  return updatedAt >= from;
}

export function inPreviousPeriod(updatedAt: number, period: ChartPeriod, now: number): boolean {
  const from = previousPeriodCutoff(period, now);
  const to = periodCutoff(period, now);
  if (from === null || to === null) return false;
  return updatedAt >= from && updatedAt < to;
}

export function attributableVerdict(verdict: string | null | undefined): boolean {
  return verdict === "aprovado" || verdict === "reprovado";
}

export function doneCount<T extends { status: string }>(tasks: readonly T[]): number {
  return tasks.filter((t) => t.status === "done").length;
}

/**
 * Current sprint window is everything updated at or after the sprint opened.
 * The previous window is the same length, ending when this sprint started,
 * so the done-count delta has a period to compare against.
 */
export function inSprintWindow(updatedAt: number, startedAt: number): boolean {
  return updatedAt >= startedAt;
}

export function inPreviousSprintWindow(updatedAt: number, startedAt: number, now: number): boolean {
  const length = Math.max(0, now - startedAt);
  const from = startedAt - length;
  return updatedAt >= from && updatedAt < startedAt;
}

/** Signed difference of done counts: current window minus the previous one. */
export function doneDelta(currentDone: number, previousDone: number): number {
  return currentDone - previousDone;
}

export function verdictShare(
  verdicts: readonly { verdict: string | null }[],
): { typed: number; total: number; percent: number | null } {
  const typed = verdicts.filter((v) => attributableVerdict(v.verdict)).length;
  const total = verdicts.length;
  if (total === 0) return { typed: 0, total: 0, percent: null };
  return { typed, total, percent: Math.round((typed / total) * 100) };
}

/**
 * Share of attributable verdicts over the unattributed remainder.
 * A null row on a task that later received `aprovado`/`reprovado` is a round
 * before that verdict, not "the rest without attribution". Only rows on tasks
 * that never received an attributable verdict enter the denominator.
 */
export function verdictShareOfTasks(
  tasks: readonly { verdicts: readonly { verdict: string | null }[] }[],
): { typed: number; total: number; percent: number | null } {
  let typed = 0;
  let unattributed = 0;
  for (const task of tasks) {
    const hasTyped = task.verdicts.some((row) => attributableVerdict(row.verdict));
    if (hasTyped) {
      for (const row of task.verdicts) if (attributableVerdict(row.verdict)) typed += 1;
    } else {
      unattributed += task.verdicts.length;
    }
  }
  const total = typed + unattributed;
  if (total === 0) return { typed: 0, total: 0, percent: null };
  return { typed, total, percent: Math.round((typed / total) * 100) };
}

export function meanNumber(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Next multiple of 10 at or above the busiest provider, so the track is not the raw max. */
export function providerBarScale(maxTotal: number): number {
  if (maxTotal <= 0) return 1;
  return Math.ceil(maxTotal / 10) * 10;
}

/** Bar height as a share of the 200px axis, rounded. Zero stays zero. */
export function histogramBarHeight(count: number, max: number, chartMax = 200): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.round((count / max) * chartMax);
}

/** Integer percents that sum to 100. */
export function shareWidths(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return counts.map(() => 0);
  const rounded = counts.map((n) => Math.round((n / total) * 100));
  const drift = rounded.reduce((sum, n) => sum + n, 0) - 100;
  if (drift !== 0) {
    let idx = 0;
    for (let i = 1; i < rounded.length; i++) {
      if ((rounded[i] ?? 0) >= (rounded[idx] ?? 0)) idx = i;
    }
    rounded[idx] = (rounded[idx] ?? 0) - drift;
  }
  return rounded;
}

/** Hours and minutes, matching the graphs and sprints duration labels. */
export function formatDurationHm(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

export function medianNumber(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export type RoundBucket = "1" | "2" | "3" | "4+";

export function roundBucket(rounds: number): RoundBucket {
  if (rounds <= 1) return "1";
  if (rounds === 2) return "2";
  if (rounds === 3) return "3";
  return "4+";
}

export type CloseDialogCounts = {
  running: number;
  review: number;
  readyOrWaiting: number;
  open: number;
};

const REVIEW_END_ROLES = new Set(["reviewer", "orchestrator"]);

/**
 * Milliseconds from the concluding report until the first of: a reviewer or
 * orchestrator verdict, or a transition to done/failed. A finished task with
 * no verdict — the usual case, done via update_task — stops there. The
 * interval runs until `now` only while the task is still open.
 */
export function reviewDurationMs(input: {
  concludingReportAt: number | null;
  verdicts: readonly { at: number; verdict: string | null; role?: string | null }[];
  transitions?: readonly { toValue: string; at: number }[];
  now: number;
}): number {
  if (input.concludingReportAt === null) return 0;
  const start = input.concludingReportAt;
  let end = input.now;
  for (const verdict of input.verdicts) {
    if (verdict.verdict !== "aprovado" && verdict.verdict !== "reprovado") continue;
    if (verdict.role != null && verdict.role !== "" && !REVIEW_END_ROLES.has(verdict.role)) continue;
    if (verdict.at < start || verdict.at >= end) continue;
    end = verdict.at;
  }
  for (const step of input.transitions ?? []) {
    if (step.toValue !== "done" && step.toValue !== "failed") continue;
    if (step.at < start || step.at >= end) continue;
    end = step.at;
  }
  return Math.max(0, end - start);
}

/**
 * Review is the tail of running: the same milliseconds must not sit in the
 * blue segment and the orange one. The three displayed parts sum to the
 * cycle (queue + running) that `computeCycleTime` measured.
 */
export function allocateCycleSegments(input: {
  queuedMs: number;
  runningMs: number;
  reviewMs: number;
}): { queuedMs: number; runningMs: number; reviewMs: number } {
  const queuedMs = Math.max(0, input.queuedMs);
  const runningMs = Math.max(0, input.runningMs);
  const reviewMs = Math.min(Math.max(0, input.reviewMs), runningMs);
  return { queuedMs, runningMs: runningMs - reviewMs, reviewMs };
}

export function closeDialogCounts(columns: readonly string[]): CloseDialogCounts {
  let running = 0;
  let review = 0;
  let readyOrWaiting = 0;
  for (const col of columns) {
    if (col === "running") running += 1;
    else if (col === "review") review += 1;
    else if (col === "ready" || col === "waiting") readyOrWaiting += 1;
  }
  return { running, review, readyOrWaiting, open: running + review + readyOrWaiting };
}
