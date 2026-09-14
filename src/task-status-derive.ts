/**
 * CAMADA 3 — `pending`/`running` are DERIVED from live implementer
 * participation; `done`/`failed` stay written judgments.
 *
 * Rationale (DESIGN-BACKLOG.md §2.1, "status se parte em duas"):
 * participation is observable state *now* (is there a live implementer
 * card?); judgment is an event that *happened*. They do not belong in
 * the same written column — writing both is what let four actors fight
 * over `tasks.status`, and what left `running` rows lying forever after
 * a restart (no PTY, still "running").
 *
 * One rule:
 *   judgment (done/failed)? → that
 *   else live implementer? → running
 *   else → pending
 *
 * Derive on READ. Liveness is the in-memory PTY registry (O(1) Map).
 * Participation for THIS derivation is `tasks.card_id` (principal
 * implementer) + isAlive — NOT `listTaskCardsForCardStmt` (that query
 * filters out done/failed tasks and is blind to reviewers on completed
 * work; see adversarial finding on 5bd45eb / task a1a49a99). Reviewers
 * never become `tasks.card_id` (cf59339), so they correctly do not move
 * derived status.
 */

export type TaskJudgmentStatus = "done" | "failed";
export type TaskParticipationStatus = "pending" | "running";
export type DerivedTaskStatus = TaskJudgmentStatus | TaskParticipationStatus;

export function isJudgmentStatus(status: string): status is TaskJudgmentStatus {
  return status === "done" || status === "failed";
}

/** Stored domain: pending|done|failed. `running` is never authoritative. */
export function coerceStoredTaskStatus(status: string): string {
  return status === "running" ? "pending" : status;
}

export function deriveTaskStatus(storedStatus: string, hasLiveImplementer: boolean): DerivedTaskStatus {
  if (isJudgmentStatus(storedStatus)) return storedStatus;
  return hasLiveImplementer ? "running" : "pending";
}

export type StatusActor = "app" | "agent" | "human" | "orchestrator";

/**
 * Human hold against live participation must be VISIBLE. When effective
 * is already pending, a human-hold diverged signal is noise (aligned).
 * Judgment rows keep whatever diverged_* the write funnel stored.
 * Board-orchestrator delegated signature is authoritative the same way.
 */
export function deriveParticipationDivergence(input: {
  storedStatus: string;
  effectiveStatus: string;
  lastStatusActor: StatusActor | null | undefined;
  existingDivergedStatus: string | null | undefined;
  existingDivergedActor: StatusActor | null | undefined;
}): { divergedStatus: string | null; divergedActor: StatusActor | null } {
  if (isJudgmentStatus(input.storedStatus)) {
    return {
      divergedStatus: input.existingDivergedStatus ?? null,
      divergedActor: input.existingDivergedActor ?? null,
    };
  }
  if (input.effectiveStatus === "pending") {
    if (
      (input.existingDivergedActor === "human" || input.existingDivergedActor === "orchestrator") &&
      input.existingDivergedStatus === "pending"
    ) {
      return { divergedStatus: null, divergedActor: null };
    }
    return {
      divergedStatus: input.existingDivergedStatus ?? null,
      divergedActor: input.existingDivergedActor ?? null,
    };
  }
  if (
    input.lastStatusActor === "human" ||
    input.lastStatusActor === "orchestrator" ||
    ((input.existingDivergedActor === "human" || input.existingDivergedActor === "orchestrator") &&
      input.existingDivergedStatus === "pending")
  ) {
    // Keep the stamp that created the hold — don't rewrite orchestrator
    // as human (false trail).
    const holdActor: StatusActor =
      input.lastStatusActor === "orchestrator" || input.existingDivergedActor === "orchestrator"
        ? "orchestrator"
        : "human";
    return { divergedStatus: "pending", divergedActor: holdActor };
  }
  return {
    divergedStatus: input.existingDivergedStatus ?? null,
    divergedActor: input.existingDivergedActor ?? null,
  };
}

/**
 * Linking an implementer to `failed` reopens by ACT → pending placeholder.
 * `done` stays — a completed judgment is not undone by attaching a card.
 */
export function storedStatusAfterImplementerLink(storedStatus: string): string {
  return storedStatus === "failed" ? "pending" : coerceStoredTaskStatus(storedStatus);
}
