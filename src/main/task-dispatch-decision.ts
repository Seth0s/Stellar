/**
 * Pure decision for auto-dispatch/retry spawn params (DESIGN-BACKLOG.md —
 * card `claude` alone at board root / "trust this folder").
 *
 * `onTaskDone` used to hardcode `cwd: undefined`, so the
 * renderer always fell through to `cwd || activeBoardCwd` (board root).
 * That is still the declared fallback when a task has no cwd of its own —
 * this module makes that choice explicit and testable. No repo-heuristic
 * resolution: if the task row has no cwd, we return `undefined` and the
 * existing board-root path stays in force.
 */

/** Non-empty task cwd wins; otherwise `undefined` so the renderer keeps
 * using `activeBoardCwd`. Whitespace-only is treated as absent. */
export function resolveTaskDispatchCwd(taskCwd: string | null | undefined): string | undefined {
  const trimmed = typeof taskCwd === "string" ? taskCwd.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Label that ties the spawned card to the task — without this the card
 * is born with the provider's ordinal name and looks "from nowhere". */
export function resolveTaskDispatchLabel(task: { id: string; prompt: string | null }): string {
  const prompt = task.prompt?.trim();
  if (prompt) {
    // Same spirit as connector-label truncation — short pill, not a novel.
    return prompt.length > 48 ? `${prompt.slice(0, 45)}…` : prompt;
  }
  return `task ${task.id.slice(0, 8)}`;
}
