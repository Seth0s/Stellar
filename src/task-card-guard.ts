/**
 * Board-scoped decision for the singleton task-card surface.
 *
 * The same pure function is used by the renderer (Rail and the final card
 * creation path) and by the main-process spawn_card gate. Keeping archived
 * state in the input makes the rule explicit: an archived card is history,
 * not a live queue occupying this board's slot.
 */
export type TaskCardGuardCard = {
  id: string;
  boardId: string;
  kind: string;
  archivedAt: number | null;
};

export type TaskCardSpawnDecision =
  | { action: "create" }
  | { action: "reuse"; cardId: string; existingCount: number };

function stableCardIdCompare(a: TaskCardGuardCard, b: TaskCardGuardCard): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

/**
 * Returns `reuse` for the first stable live task card on this board, or
 * `create` when none exists. If legacy data ever contains two live task
 * cards, callers deliberately reuse the lowest stable id and leave both
 * rows intact; this guard prevents adding a third without silently deleting
 * user data.
 */
export function decideTaskCardSpawn(cards: readonly TaskCardGuardCard[], boardId: string): TaskCardSpawnDecision {
  const existing = cards
    .filter((card) => card.boardId === boardId && card.kind === "task" && card.archivedAt === null)
    .slice()
    .sort(stableCardIdCompare);
  if (existing.length === 0) return { action: "create" };
  return { action: "reuse", cardId: existing[0].id, existingCount: existing.length };
}
