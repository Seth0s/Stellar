/**
 * Which cards' `filesChanged` count toward a gate-isolation dispute.
 *
 * Measured: `collectDeclaredFiles` took every board task's `card_id` (terminal
 * included) and `getReport` still returned declarations for archived or
 * deleted cards, so the shared-mode note listed ghost ids alongside the one
 * live writer. Only ACTIVE participation counts as a concurrent claim:
 *   - task not terminal (done / failed / superseded);
 *   - unreleased implementer link that is not a mere reservation, OR the
 *     legacy case (principal `card_id`, no `task_cards` rows);
 *   - card alive (exists, not archived — the caller's `isCardAlive`).
 *
 * A dead card that still sits on a pending task's `card_id` is OMITTED, not
 * renamed into a separate warning: it is not a concurrent writer on the
 * shared tree, and citing it was the measured noise. Territory conflict
 * already uses the same live-implementer rule (`hasExecutingImplementer`).
 */

export type ActiveDeclarationImplementer = {
  cardId: string;
  /** `null` = executing; any other value = reserved / not executing. */
  reservationState: string | null;
};

export type ActiveDeclarationTask = {
  status: string;
  /** Principal `tasks.card_id`. */
  cardId: string | null;
  /** Unreleased implementer rows (`released_at IS NULL`). */
  liveImplementers: readonly ActiveDeclarationImplementer[];
};

/**
 * Card ids whose declarations may dispute isolation. Order is insertion
 * order of first sighting across `tasks` — callers that need a Set can wrap.
 */
export function activeDeclarationCardIds(input: {
  tasks: readonly ActiveDeclarationTask[];
  isTerminalStatus: (status: string) => boolean;
  isCardAlive: (cardId: string) => boolean;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (cardId: string) => {
    if (seen.has(cardId)) return;
    seen.add(cardId);
    out.push(cardId);
  };
  for (const task of input.tasks) {
    if (input.isTerminalStatus(task.status)) continue;
    const executing = task.liveImplementers.filter(
      (l) => l.reservationState == null && input.isCardAlive(l.cardId),
    );
    if (executing.length > 0) {
      for (const l of executing) add(l.cardId);
      continue;
    }
    // Legacy: principal card_id with no task_cards rows at all.
    if (
      task.liveImplementers.length === 0 &&
      task.cardId !== null &&
      input.isCardAlive(task.cardId)
    ) {
      add(task.cardId);
    }
  }
  return out;
}

/**
 * Drops declarations from cards that are not in the active set. Pure seam
 * for `decideGateIsolation` inputs built before the collect-path filter.
 */
export function filterActiveDeclaredFiles<T extends { cardId: string }>(
  declared: readonly T[],
  activeCardIds: ReadonlySet<string> | readonly string[],
): T[] {
  const active =
    activeCardIds instanceof Set ? activeCardIds : new Set(activeCardIds);
  return declared.filter((d) => active.has(d.cardId));
}
