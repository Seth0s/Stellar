/**
 * DESIGN-BACKLOG.md §2.1 SINAL 3 — watchdog for the gap between
 * `card_status: idle` and `exit_without_report`.
 *
 * Exit without report (SINAL 2) already notifies the spawner when the
 * card DIES. Report (SINAL 1) notifies when a row lands. Nobody covered
 * the middle: card ALIVE, quiet, task still expecting a report, no row
 * in `reports`. Measured 2026-09-14: agents wrote the whole delivery into
 * scrollback (YAML / prose) and never called `report`; the orchestrator
 * only found out by reading the PTY by hand.
 *
 * This module is the pure gate. It does NOT poke the idle card — that
 * would burn its context mid-turn and race a thinking pause. It answers
 * only "should the spawner get one pointer, once, for this episode?".
 *
 * Threshold `IDLE_WITHOUT_REPORT_MS = 180_000` is not a taste pick: it is
 * the same ceiling already used for "silence ≠ idle" on the activity bar
 * (`ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS` in terminal-activity-decision.ts),
 * itself slack over a measured MCP-tool max of 122.7s. Below that, a
 * long silent tool can still look like idleness; at/above it, the same
 * codebase already treats silence as idle. `IDLE_THRESHOLD_MS` (5s) stays
 * the cheap `card_status` heuristic — too short to notify on.
 *
 * Once-only state lives in the caller (`Set` of card ids). Reset when a
 * report is accepted or the card exits (exit path takes over). Do NOT
 * reset on transient PTY chatter — a spinner would re-arm spam.
 */

/** Same ceiling as ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS — silence-as-work bound. */
export const IDLE_WITHOUT_REPORT_MS = 180_000;

/** How often the bus rescans alive cards. Cheap; aligns with card_status idle. */
export const IDLE_WITHOUT_REPORT_POLL_MS = 5_000;

export type IdleWithoutReportSkipReason =
  | "not_alive"
  | "waiting_consent"
  | "has_report"
  | "no_linked_running_task"
  | "already_notified"
  | "activity_unknown"
  | "not_idle_long_enough";

export type IdleWithoutReportDecision =
  | { action: "notify" }
  | { action: "skip"; reason: IdleWithoutReportSkipReason };

/**
 * Decide whether this card's idle-without-report episode should notify
 * the spawner. Pure — no I/O, no mutation of the once-set.
 */
export function decideIdleWithoutReport(input: {
  alive: boolean;
  waitingOnConsent: boolean;
  hasReport: boolean;
  /** Principal implementer link (`tasks.card_id`) on a non-judgment task. */
  hasLinkedRunningTask: boolean;
  alreadyNotified: boolean;
  /** `null` when the PTY registry has no activity clock for this card. */
  msSinceLastActivity: number | null;
  /** Override for tests; production uses IDLE_WITHOUT_REPORT_MS. */
  idleWithoutReportMs?: number;
}): IdleWithoutReportDecision {
  if (!input.alive) return { action: "skip", reason: "not_alive" };
  if (input.waitingOnConsent) return { action: "skip", reason: "waiting_consent" };
  if (input.hasReport) return { action: "skip", reason: "has_report" };
  if (!input.hasLinkedRunningTask) return { action: "skip", reason: "no_linked_running_task" };
  if (input.alreadyNotified) return { action: "skip", reason: "already_notified" };
  if (input.msSinceLastActivity === null) return { action: "skip", reason: "activity_unknown" };
  const floor = input.idleWithoutReportMs ?? IDLE_WITHOUT_REPORT_MS;
  if (input.msSinceLastActivity < floor) {
    return { action: "skip", reason: "not_idle_long_enough" };
  }
  return { action: "notify" };
}
