/**
 * The two-step answer to "a card ended its turn and no report came": first ASK
 * THE CARD itself (it usually just forgot), and only if that fails tell the
 * orchestrator. Pure — the bus owns the clocks, the once-per-episode state and
 * the delivery; this owns the timing rule.
 *
 * Why two steps and not one: the orchestrator reading scrollback is the
 * expensive path, and the measured failure is a card that simply forgot the
 * tool call. A reminder costs one line in a card that is already at its prompt.
 *
 * No loop by construction: `remind` is returned only while nothing was sent
 * (`remindedAgoMs === null`) and `escalate` only after it, and the caller stamps
 * both once per episode. A card that ignores the reminder reaches the
 * orchestrator exactly once.
 */

/** How long the turn must stay ended, with no report in the episode, before the
 *  card itself is reminded. */
export const SELF_REMINDER_FLOOR_MS = 20_000;

/** After the reminder: how long the card then gets (idle again, no report)
 *  before the orchestrator is told. */
export const SELF_REMINDER_ESCALATE_MS = 60_000;

export type SelfReminderDecision = { action: "wait" } | { action: "remind" } | { action: "escalate" };

export function decideSelfReminder(input: {
  /** How long the turn has CONTINUOUSLY been seen as ended (resets when the
   *  card is seen working again). */
  idleForMs: number;
  /** Time since the reminder was sent, or null when none was sent yet. */
  remindedAgoMs: number | null;
  floorMs?: number;
  escalateMs?: number;
}): SelfReminderDecision {
  const floor = input.floorMs ?? SELF_REMINDER_FLOOR_MS;
  const escalate = input.escalateMs ?? SELF_REMINDER_ESCALATE_MS;
  if (input.remindedAgoMs === null) {
    return input.idleForMs >= floor ? { action: "remind" } : { action: "wait" };
  }
  // Both clocks must have run: the card may have reacted to the reminder (work,
  // then idle again), and the orchestrator is told `escalate` ms after that.
  return Math.min(input.idleForMs, input.remindedAgoMs) >= escalate ? { action: "escalate" } : { action: "wait" };
}
