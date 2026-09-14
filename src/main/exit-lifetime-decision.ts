/**
 * Time-aware classification for `exit_without_report` (retry-sem-freio).
 *
 * A retry budget with no notion of time is a multiplier: when a card dies
 * in a few seconds (bad CLI flag, missing binary, quota at launch),
 * `maxRetries: 2` burned three cards in ~40s (tasks ec01dc40 / 1f82dddf,
 * 2026-09-13 15:50 — lifetimes ~12s, ~4s, ~5s). Legitimate work that day
 * ran for ~36 minutes before a successful report.
 *
 * Choice: lifetime floor, not backoff. Backoff would still spawn three
 * cards (just slower). A death below the floor did not "consume a retry
 * attempt" — it consumed a launch diagnosis. The owner must SEE that
 * (status `failed` + reason), not watch the task flip back to running.
 *
 * Floor `INSTANT_EXIT_LIFETIME_MS = 30_000` is from that measurement: above
 * the longest instant death in the cluster (12s) with margin, still far
 * below any session that actually did work. Not a taste pick.
 *
 * Unknown lifetime (`null`) does NOT escalate — after restart we lose the
 * in-memory link clock; failing open to the typed interrompida path avoids
 * false `failed` on a long-lived card whose start time we no longer have.
 *
 * Spawn-on-exit retry stays dead (2023a74): in-line `report` retry covers
 * declared failures while the agent is alive. This module only classifies
 * the write `markTaskFailed` should make.
 */

import type { FailureKind } from "./failure-kind-decision";

/** Measured ceiling of the 15:50 instant-death cluster (max ~12s) + margin. */
export const INSTANT_EXIT_LIFETIME_MS = 30_000;

export type ExitLifetimeWrite = {
  /** Instant diagnosis → failed column (visible). Otherwise interrompida→pending. */
  status: "pending" | "failed";
  failureKind: FailureKind;
  /** Replace/augment the exit error so the Fila names the diagnosis. */
  error: string;
  instant: boolean;
};

export function describeInstantExitDiagnosis(lifetimeMs: number, exitError: string): string {
  const secs = Math.max(0, Math.round(lifetimeMs / 1000));
  const floorSecs = Math.round(INSTANT_EXIT_LIFETIME_MS / 1000);
  return (
    `${exitError} — launch diagnosis: card lived ${secs}s ` +
    `(below ${floorSecs}s lifetime floor); not a retryable interruption`
  );
}

/**
 * Classify an exit-without-report for the failure write.
 * `lifetimeMs === null` → same as a long-lived exit (interrompida/pending).
 */
export function decideExitWithoutReportWrite(input: {
  lifetimeMs: number | null;
  exitError: string;
}): ExitLifetimeWrite {
  if (input.lifetimeMs !== null && input.lifetimeMs < INSTANT_EXIT_LIFETIME_MS) {
    return {
      status: "failed",
      failureKind: "julgada",
      error: describeInstantExitDiagnosis(input.lifetimeMs, input.exitError),
      instant: true,
    };
  }
  return {
    status: "pending",
    failureKind: "interrompida",
    error: input.exitError,
    instant: false,
  };
}
