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

/** `reviewer` is a card role, not a purpose. Measured 2026-09-13: 0 of
 * 91 `task_cards` rows were `reviewer` — `linkTaskCard` exists
 * (`store.ts`) but no MCP tool writes it. The ` ↔ review` chip arrow
 * derives from this string and will not appear until someone does. */
export const TASK_CARD_REVIEWER_ROLE = "reviewer";

export function normalizeTaskPurpose(raw: unknown): TaskPurpose | null {
  if (typeof raw !== "string") return null;
  return (TASK_PURPOSES as readonly string[]).includes(raw) ? (raw as TaskPurpose) : null;
}

export function cardHasReviewer(roles: readonly string[]): boolean {
  return roles.includes(TASK_CARD_REVIEWER_ROLE);
}
