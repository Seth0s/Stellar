/**
 * Task proposal (`tasks.purpose`) — what the task IS, declared once at
 * create. Distinct from `task_cards.role` (who a card is on that task)
 * and from `deriveStage` (where a running implement/fix task is).
 *
 * Absent/`null` is NORMAL, not a missing default: measured 2026-09-13,
 * 91/91 `task_cards.role` were the silent `implementer` default and
 * 140/148 `task_verdicts.verdict` were null. A silent purpose default
 * would make the Fila lie with more confidence. The UI shows an empty
 * chip; it never invents a value from the prompt text.
 */

export const TASK_PURPOSES = ["investigate", "implement", "measure", "fix"] as const;
export type TaskPurpose = (typeof TASK_PURPOSES)[number];

/** `task_cards.role` — what ONE card does on ONE task. A card role, not a
 * purpose: a `fix` task can have an implementer and a reviewer at once.
 * Measured 2026-09-13: 0 of 91 rows were `reviewer`, because no MCP tool
 * wrote the column. Since then two do: `spawn_agent({taskId, role})` and
 * `link_task_card` (message-bus.ts), both validating against this list
 * and refusing anything else. `implementer` stays the default when the
 * caller says nothing. The Fila ` ↔ review` chip arrow derives from
 * `reviewer` rows. */
export const TASK_CARD_ROLES = ["implementer", "reviewer"] as const;
export type TaskCardRole = (typeof TASK_CARD_ROLES)[number];
export const TASK_CARD_IMPLEMENTER_ROLE: TaskCardRole = "implementer";
export const TASK_CARD_REVIEWER_ROLE: TaskCardRole = "reviewer";

export function normalizeTaskPurpose(raw: unknown): TaskPurpose | null {
  if (typeof raw !== "string") return null;
  return (TASK_PURPOSES as readonly string[]).includes(raw) ? (raw as TaskPurpose) : null;
}

/** `null` = not a role we know. Callers REFUSE on null (same principle
 * as `spawn_agent`'s effort check); they never fall back to implementer
 * from a typo — the default only applies when the field is absent. */
export function normalizeTaskCardRole(raw: unknown): TaskCardRole | null {
  if (typeof raw !== "string") return null;
  return (TASK_CARD_ROLES as readonly string[]).includes(raw) ? (raw as TaskCardRole) : null;
}

export function cardHasReviewer(roles: readonly string[]): boolean {
  return roles.includes(TASK_CARD_REVIEWER_ROLE);
}
