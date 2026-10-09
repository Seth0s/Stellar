/**
 * SUPERSEDED — pure decision.
 *
 * A task can end because it was REPLACED by another task, not because it
 * failed. `superseded` is a terminal status of its own: it is not counted as
 * a failure in any metric, it does not trigger a retry, it releases the
 * task's reservations and territory, and it stops blocking dependents.
 *
 * The status carries `supersededBy` — the id of the task that replaces this
 * one — which is required and must exist on the SAME board.
 *
 * Who may write it: the board's marked orchestrator and the human. An
 * implementer of the task NEVER writes it (participation beats the board
 * mark, same posture as `decideJudgmentWrite`).
 *
 * No I/O: the caller resolves the ids/facts and this module decides.
 */

import { TASK_CARD_IMPLEMENTER_ROLE } from "../task-purpose";
import { HUMAN_PRINCIPAL_ID } from "./judgment-write-decision";
import { APP_NOTICE } from "./agent-facing-notices";

/** The terminal status a task receives when it is swapped for another one. */
export const SUPERSEDED_STATUS = "superseded";

export type SupersedeTargetResolution =
  | { ok: true; targetId: string }
  | { ok: false; error: string; field: "supersededBy" };

/** AGENT-FACING — ENGLISH ONLY, not i18n'd (agents have no locale).
 * Names the field, like the other teaching refusals in the repo. */
export function describeSupersededTargetRequired(): string {
  return (
    `[de: stellar] update_task status "superseded" refused: "supersededBy" is required — ` +
    `name the task that REPLACES this one (the field is supersededBy). A superseded task without a substitute says nothing.`
  );
}

export function describeSupersededTargetUnknown(targetId: string): string {
  return `[de: stellar] update_task status "superseded" refused: supersededBy "${targetId}" does not name an existing task — nothing was written.`;
}

export function describeSupersededTargetSelf(taskId: string): string {
  return `[de: stellar] update_task status "superseded" refused: a task cannot supersede itself (supersededBy "${taskId}") — nothing was written.`;
}

export function describeSupersededTargetOtherBoard(targetId: string, targetBoard: string, taskBoard: string): string {
  return `[de: stellar] update_task status "superseded" refused: supersededBy "${targetId}" belongs to board "${targetBoard}", not "${taskBoard}" — the substitute must be a task of the SAME board. Nothing was written.`;
}

/**
 * Validates the `supersededBy` TARGET. The caller has already resolved the
 * id (prefix included) and knows whether the task exists (`targetBoardId ===
 * undefined` means it does not). `null` on either board is honest absence (a
 * task with no board): the target is refused only when BOTH boards are known
 * and differ — a board is never invented.
 */
export function resolveSupersedeTarget(input: {
  taskId: string;
  taskBoardId: string | null;
  targetId: string | null;
  /** `undefined` means the id resolves to no task. */
  targetBoardId: string | null | undefined;
}): SupersedeTargetResolution {
  if (!input.targetId) return { ok: false, field: "supersededBy", error: describeSupersededTargetRequired() };
  if (input.targetId === input.taskId) {
    return { ok: false, field: "supersededBy", error: describeSupersededTargetSelf(input.taskId) };
  }
  if (input.targetBoardId === undefined) {
    return { ok: false, field: "supersededBy", error: describeSupersededTargetUnknown(input.targetId) };
  }
  if (input.taskBoardId !== null && input.targetBoardId !== null && input.targetBoardId !== input.taskBoardId) {
    return {
      ok: false,
      field: "supersededBy",
      error: describeSupersededTargetOtherBoard(input.targetId, input.targetBoardId, input.taskBoardId),
    };
  }
  return { ok: true, targetId: input.targetId };
}

export type SupersedeAuthorshipDecision = { action: "allow" } | { action: "refuse"; error: string };

/** AGENT-FACING — ENGLISH ONLY, not i18n'd. */
export function describeSupersededImplementerRefusal(taskId: string): string {
  return (
    `[de: stellar] update_task status "superseded" refused on task "${taskId}": ` +
    `an implementer member of this task does not close it as superseded — participation wins the board mark. ` +
    `Whoever supersedes is the board's marked orchestrator or the human. Nothing was written.`
  );
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd. */
export function describeSupersededAuthorshipRefusal(taskId: string, requesterId: string | null): string {
  const who = requesterId ? `"${requesterId}"` : "an anonymous caller (no requesterId)";
  return (
    `[de: stellar] update_task status "superseded" refused on task "${taskId}": ` +
    `marking a task as replaced is coordination judgment — only the board's marked orchestrator ` +
    `(boards.orchestrator_card_id) or the human (${HUMAN_PRINCIPAL_ID}) does it; the caller was ${who}. ` +
    `Nothing was written.`
  );
}

/**
 * Decides who may mark `superseded`.
 *  1. An implementer of this task -> REFUSED (participation beats the mark).
 *  2. The card marked as the board's orchestrator -> allow.
 *  3. The human (named principal) -> allow.
 *  4. Anyone else / anonymous -> REFUSED.
 */
export function decideSupersedeAuthorship(input: {
  taskId: string;
  requesterId: string | null | undefined;
  requesterRoleOnTask: string | null;
  orchestratorCardId: string | null | undefined;
}): SupersedeAuthorshipDecision {
  if (input.requesterRoleOnTask === TASK_CARD_IMPLEMENTER_ROLE) {
    return { action: "refuse", error: describeSupersededImplementerRefusal(input.taskId) };
  }
  const requesterId = (input.requesterId ?? "").trim() || null;
  if (requesterId && input.orchestratorCardId && requesterId === input.orchestratorCardId) return { action: "allow" };
  if (requesterId === HUMAN_PRINCIPAL_ID) return { action: "allow" };
  return { action: "refuse", error: describeSupersededAuthorshipRefusal(input.taskId, requesterId) };
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd. Notice to the ORCHESTRATOR about a
 * dependent that still points at the superseded task: it names both sides and
 * states that the engine does NOT rewrite the dependency on its own. */
export function describeSupersededDependencyNotice(input: {
  dependentTaskId: string;
  supersededTaskId: string;
  substituteTaskId: string;
}): string {
  return APP_NOTICE.supersededDependency(input);
}
