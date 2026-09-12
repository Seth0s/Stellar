/**
 * Pure decision for hybrid task-status precedence (DESIGN-BACKLOG.md §2.1
 * "Decisão 8 (status híbrido com precedência)").
 *
 * Product answers (repo owner, 2026-09-11):
 *  1. The human ALWAYS wins.
 *  2. An agent write is ACCEPTED WITH A WARNING — never refused, never
 *     refused in silence.
 *  3. Divergence between what the app observes and what the human decided
 *     is SIGNALED, never prevented.
 *
 * Reading that makes the three coherent: the human-chosen status stays
 * AUTHORITATIVE. App and agent may still write (no call becomes an error),
 * but their contribution does NOT displace the human status — it is
 * recorded as a declaration and produces a live divergence signal. The
 * alternative ("agent write overwrites, human gets a notice afterwards")
 * contradicts answer 1.
 *
 * Lives at the write choke point (`upsertTaskInternal` in store.ts) so
 * callers cannot forget to consult the previous actor — the same empirical
 * reason `task_transitions` is written inside upsert, not via a separate
 * API someone has to remember.
 *
 * Callers that fire side effects AFTER upsert (auto-dispatch, auto-retry)
 * MUST observe `statusChanged` — a held write is not a silent no-op for
 * them; spawning on top of a held status is exactly the bug class the
 * adversarial review found (2026-09-11).
 *
 * Precedence of ORDERING (`order` > `suggestedOrder` > `implicitOrder`) is
 * a different axis, already closed — this module never touches it.
 */

/** Mirrored from `store.ts`'s `TaskActor` — kept local so this module
 * stays free of a runtime import from the store (the store imports THIS
 * file at the choke point). Same three values, same meaning. */
export type StatusWriteActor = "app" | "agent" | "human";

export type StatusWriteInput = {
  /** Last `kind:'status'` transition actor. `null` when the task has no
   * status trail yet (create, or predata with an empty trail). */
  previousActor: StatusWriteActor | null;
  /** Status currently on the row. `null` only on create (no existing row). */
  previousStatus: string | null;
  /**
   * Status the caller is proposing, or `null` when the caller did NOT
   * touch status (bookkeeping-only write: result/suggestedOrder/cardId).
   * Distinguishes "explicitly proposed the same status" (legitimate
   * alignment → clear divergence) from "did not propose status at all"
   * (must KEEP any live divergence — adversarial review 2026-09-11).
   */
  proposedStatus: string | null;
  /** Who is writing this upsert. */
  newActor: StatusWriteActor;
  /** Live divergence currently persisted — returned unchanged when
   * `proposedStatus` is null so a non-status update cannot wipe the signal. */
  existingDivergedStatus: string | null;
  existingDivergedActor: StatusWriteActor | null;
};

export type StatusWriteDecision = {
  /** Status that must be persisted on `tasks.status`. */
  status: string;
  /** True when `tasks.status` actually moves — drives a `kind:'status'`
   * transition insert. False when the human lock holds the row still OR
   * the caller did not propose a status. Side-effect callers (spawn,
   * retry) MUST gate on this. */
  statusChanged: boolean;
  /** Live divergence signal to persist. Both null = clear / none.
   * Survives across reads so the Fila card can show it; cleared when the
   * human writes again or when a later write EXPLICITLY aligns with the
   * human status. A status-omitted write returns the existing values. */
  divergedStatus: string | null;
  divergedActor: StatusWriteActor | null;
  /** Insert a `kind:'declaration'` transition (audit of the parked write).
   * Deliberately NOT a `kind:'status'` row — that would flip `last_actor`
   * away from `"human"` and unlock the next overwrite. */
  recordDeclaration: boolean;
  /** Answer 2: warn the writing agent (MCP response + typeAndSubmit).
   * Only set when `newActor === "agent"` and the human lock held. App
   * holds produce a board signal only (answer 3) — there is no agent PTY
   * to address, and `electron.Notification` is invisible inside a PTY. */
  warnAgent: boolean;
  /**
   * The status value that was declared against the human lock, when a
   * declaration was recorded. Callers that need the warning text use this
   * (not `task.status`, which may have been the held human value).
   */
  declaredStatus: string | null;
};

/**
 * Decide the authoritative status and whether to signal divergence.
 *
 * Rules, in order:
 *  1. Create (no previous row) → apply, no signal.
 *  2. Caller did not propose status (`proposedStatus === null`) → keep
 *     current status AND keep any live divergence; no declaration.
 *  3. Explicit proposal equals current → status no-op; CLEAR divergence
 *     (legitimate alignment — card "came back to life" / observation matches).
 *  4. Human writes → ALWAYS apply; CLEAR divergence.
 *  5. App/agent writes while last status actor is human → HOLD human
 *     status; SET divergence to the proposed value; warn when actor is
 *     agent; record a declaration (not a status transition).
 *  6. Otherwise → apply; CLEAR divergence.
 */
export function decideStatusWrite(input: StatusWriteInput): StatusWriteDecision {
  const {
    previousActor,
    previousStatus,
    proposedStatus,
    newActor,
    existingDivergedStatus,
    existingDivergedActor,
  } = input;

  if (previousStatus === null) {
    // Create — proposedStatus must be the initial status (callers always
    // pass one). Treat null as a programming error by falling through to
    // empty string rather than inventing a default.
    const initial = proposedStatus ?? "";
    return {
      status: initial,
      statusChanged: true,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    };
  }

  // Bookkeeping-only write: do not treat "injected existing.status" as an
  // alignment proposal. Keep the live divergence signal intact.
  if (proposedStatus === null) {
    return {
      status: previousStatus,
      statusChanged: false,
      divergedStatus: existingDivergedStatus,
      divergedActor: existingDivergedActor,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    };
  }

  if (proposedStatus === previousStatus) {
    return {
      status: previousStatus,
      statusChanged: false,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    };
  }

  if (newActor === "human") {
    return {
      status: proposedStatus,
      statusChanged: true,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    };
  }

  if (previousActor === "human") {
    return {
      status: previousStatus,
      statusChanged: false,
      divergedStatus: proposedStatus,
      divergedActor: newActor,
      recordDeclaration: true,
      warnAgent: newActor === "agent",
      declaredStatus: proposedStatus,
    };
  }

  return {
    status: proposedStatus,
    statusChanged: true,
    divergedStatus: null,
    divergedActor: null,
    recordDeclaration: false,
    warnAgent: false,
    declaredStatus: null,
  };
}

/** Answer 2 — text delivered to the writing agent via `typeAndSubmit` (and
 * echoed on the MCP/`acbridge` response). Kept next to the decision so the
 * wording cannot drift from the rule that produced it. Prefixed `[de:
 * stellar]` to match every other automated notice on the board.
 *
 * AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
 * See `src/shared/i18n/agent-facing.ts`. */
export function describeStatusHeldWarning(authoritativeStatus: string, proposedStatus: string): string {
  return `[de: stellar] update_task pediu status "${proposedStatus}" mas o status humano "${authoritativeStatus}" prevalece — divergência sinalizada no quadro Fila.`;
}
