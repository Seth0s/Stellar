/**
 * CAMADA 4 — integrante da task não julga a própria task.
 *
 * Product rule (owner, 2026-09-14): who PARTICIPATES as implementer may
 * only ASK (`request_task_status`); who is OUTSIDE the task, or linked as
 * reviewer, may WRITE judgment (`done`/`failed`). The criterion is
 * membership of THIS task — not the word "implementer" alone, and not
 * "member of any task".
 *
 * Reviewer tension: a reviewer IS a participant AND may judge — judging
 * is the role. So the gate is not "every row in task_cards is barred";
 * only the implementer link is barred from writing judgment.
 *
 * Board-orchestrator delegation (same day): the marked card may sign
 * judgment in the human's place with actor `orchestrator`, BUT
 * participation still wins — if that card is implementer on THIS task,
 * it only asks. No exception.
 *
 * Lives next to the `update_task` handler (message-bus), not inside
 * `decideStatusWrite`: human/app writers never pass through this gate,
 * and the store choke point has no writer card id today. Agents reach
 * judgment only via `update_task`.
 *
 * `deriveCompletionProposal` (renderer) is PRESENTATION of readiness for
 * the human click — not a second write authority. One rule decides who
 * may conclude; the bar only shows signals.
 */

import { isJudgmentStatus } from "../task-status-derive";
import { TASK_CARD_IMPLEMENTER_ROLE, TASK_CARD_REVIEWER_ROLE } from "../task-purpose";

export type JudgmentRequesterRole = typeof TASK_CARD_IMPLEMENTER_ROLE | typeof TASK_CARD_REVIEWER_ROLE | string | null;

export type JudgmentWriteDecision =
  | { action: "allow" }
  | { action: "refuse"; error: string };

/**
 * AGENT-FACING — DO NOT TRANSLATE. Names the tool the implementer must
 * use, same teaching style as `report-retry-decision.ts`.
 */
export function describeImplementerJudgmentRefusal(proposedStatus: string): string {
  return (
    `[de: stellar] update_task status "${proposedStatus}" recusado: ` +
    `integrante implementer desta task não grava julgamento (done/failed). ` +
    `Use request_task_status para pedir a mudança — orquestrador, reviewer ou humano julgam.`
  );
}

/**
 * AGENT-FACING — DO NOT TRANSLATE. Names the contract field the same
 * way `report-retry-decision.ts` names a missing schema key — refusal
 * that teaches, not silence.
 */
export function describeReviewWantedJudgmentRefusal(proposedStatus: string): string {
  return (
    `[de: stellar] update_task status "${proposedStatus}" recusado: ` +
    `review="wanted" nesta task — só um card com role=reviewer grava julgamento (done/failed). ` +
    `Implementer, outsider e orquestrador (assinatura delegada) são recusados. ` +
    `Vincule um reviewer (spawn_agent/link_task_card com role=reviewer) e deixe-o julgar, ` +
    `ou use request_task_status para pedir ao humano.`
  );
}

/**
 * Decide whether an agent `update_task` may write a judgment status.
 *
 * @param proposedStatus status field from the request, or null when omitted
 * @param requesterRoleOnTask role from `task_cards` for (taskId, requesterId);
 *   `null` when the caller has no link on this task OR no requesterId
 *   (anonymous / external orchestrator — treated as outsider).
 * @param reviewWanted when true (`tasks.review = "wanted"`), only a linked
 *   reviewer may write judgment — board-orchestrator delegation loses.
 */
export function decideJudgmentWrite(input: {
  proposedStatus: string | null;
  requesterRoleOnTask: JudgmentRequesterRole;
  reviewWanted?: boolean;
}): JudgmentWriteDecision {
  if (input.proposedStatus === null) return { action: "allow" };
  if (!isJudgmentStatus(input.proposedStatus)) return { action: "allow" };
  // `review: wanted` beats delegated signature AND outsider write.
  if (input.reviewWanted && input.requesterRoleOnTask !== TASK_CARD_REVIEWER_ROLE) {
    return { action: "refuse", error: describeReviewWantedJudgmentRefusal(input.proposedStatus) };
  }
  if (input.requesterRoleOnTask === TASK_CARD_IMPLEMENTER_ROLE) {
    return { action: "refuse", error: describeImplementerJudgmentRefusal(input.proposedStatus) };
  }
  // reviewer (may judge), outsider (null), or unknown role → allow write.
  // Unknown roles are not implementer; barring them would invent policy.
  // Board-orchestrator mark does NOT widen this gate — the marked card
  // is simply an outsider (or reviewer) whose actor stamp becomes
  // `orchestrator` at the write site when it is allowed.
  void TASK_CARD_REVIEWER_ROLE;
  return { action: "allow" };
}

/** Look up the caller's role on one task from a `task_cards` dump. */
export function roleOnTask(
  cards: readonly { card_id: string; role: string }[],
  cardId: string | null | undefined,
): JudgmentRequesterRole {
  if (!cardId) return null;
  const row = cards.find((c) => c.card_id === cardId);
  return row ? row.role : null;
}
