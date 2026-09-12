/**
 * DESIGN-BACKLOG.md §2.1 "Historico de sprints — fechamento EXPLICITO"
 * + "Falha TIPADA: julgada vs interrompida".
 *
 * Pure decision for what a sprint close freezes and who migrates.
 * Snapshot counts MUST be computed here at close time — never re-derived
 * later from live task status (open tasks migrate; a live query would
 * rewrite the past).
 *
 * Closed product answers (dono do repo, 2026-09-11) — do not reopen:
 *  1. Julgada (status failed) does NOT migrate — documented where it
 *     happened; counts in countFailed. Interrompida is rewritten to
 *     pending at write time, so it migrates as todo and does NOT count
 *     as a sprint failure.
 *  2. One live `sprint_id` per task; history lives in the frozen row +
 *     `snapshot_json` (board view of closed sprints).
 *  3. Empty queue / already-closed are REFUSED with a visible reason
 *     (enforced in store.closeSprint, not here — this module only
 *     freezes whatever members it is given).
 */

/** Status strings that appear on the Fila board today. Unknown statuses
 * count as `todo` (same fallback as `columnForStatus` in the renderer). */
export type SprintBucket = "todo" | "doing" | "done" | "failed";

const STATUS_TO_BUCKET: Record<string, SprintBucket> = {
  pending: "todo",
  running: "doing",
  done: "done",
  failed: "failed",
};

export function bucketForStatus(status: string): SprintBucket {
  return STATUS_TO_BUCKET[status] ?? "todo";
}

export type SprintTaskInput = {
  id: string;
  status: string;
};

export type SprintSnapshotCounts = {
  countTodo: number;
  countDoing: number;
  countDone: number;
  countFailed: number;
};

export type SprintCloseDecision = SprintSnapshotCounts & {
  /** Task ids that leave this sprint and enter the next one. */
  migrateIds: string[];
  /** Same as `migrateIds.length` — recorded as migrated_out on the
   * closed row and migrated_in on the newly opened row. */
  migratedOut: number;
};

/**
 * Freeze the board state at close.
 *
 * - todo / doing / unknown→todo → count + migrate
 * - done → countDone, stay
 * - failed → countFailed (julgada), stay
 *
 * Interrompida never appears here as status=failed: the write path
 * rewrites it to pending, so it migrates via the todo bucket. No
 * failureKind branch — that would be a dead path pretending to be a race.
 */
export function decideSprintClose(tasks: readonly SprintTaskInput[]): SprintCloseDecision {
  const counts: SprintSnapshotCounts = {
    countTodo: 0,
    countDoing: 0,
    countDone: 0,
    countFailed: 0,
  };
  const migrateIds: string[] = [];
  for (const t of tasks) {
    const bucket = bucketForStatus(t.status);
    if (bucket === "todo") counts.countTodo += 1;
    else if (bucket === "doing") counts.countDoing += 1;
    else if (bucket === "done") counts.countDone += 1;
    else counts.countFailed += 1;
    if (bucket === "todo" || bucket === "doing") migrateIds.push(t.id);
  }
  return {
    ...counts,
    migrateIds,
    migratedOut: migrateIds.length,
  };
}
