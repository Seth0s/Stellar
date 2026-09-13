/**
 * Pure decision for where a `spawn_agent` brief comes from.
 *
 * Auto-dispatch already delivers `task.prompt`. Manual `spawn_agent` used
 * to take a free `brief` with no link to that row — two texts for the
 * same work. `taskId` (optional) makes those paths share one source.
 *
 * `taskId` is optional in earnest: spawning without a task (explore, a
 * command, a conversation) stays first-class. This unifies the two
 * paths WHEN a task exists; it does not make a task a prerequisite.
 *
 * `taskId` + `brief` together are refused, same shape as
 * `resolveStickyWriteContent` (`content` + `path`). They are two sources
 * for the same delivered text. An addendum that belongs on the work is
 * `update_task` prompt-append (already marked) and then spawn with
 * `taskId`. A one-off that is not the task is spawn without `taskId`.
 * Concatenating at spawn time would recreate the second source of truth
 * this exists to remove — auto-dispatch would never see the addendum.
 */

export type SpawnBriefInput = {
  taskId?: string | null;
  brief?: string | null;
};

export type SpawnBriefTask = {
  prompt: string | null;
};

export type SpawnBriefLookup = {
  findTask: (id: string) => SpawnBriefTask | undefined;
};

export type SpawnBriefDecision =
  | { ok: true; brief: string | undefined; taskId?: string }
  | { ok: false; error: string };

/** The one transform from a stored task prompt to a delivered brief.
 * Empty / whitespace / null is absent — we do not invent a prompt. */
export function briefFromTaskPrompt(prompt: string | null | undefined): string | undefined {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  return text.length > 0 ? text : undefined;
}

export function resolveSpawnBrief(input: SpawnBriefInput, lookup: SpawnBriefLookup): SpawnBriefDecision {
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  const hasTaskId = taskId.length > 0;
  const hasBrief = input.brief !== undefined && input.brief !== null;
  if (hasTaskId && hasBrief) return { ok: false, error: "pass taskId or brief, not both" };
  if (!hasTaskId) {
    return { ok: true, brief: input.brief ?? undefined };
  }
  const task = lookup.findTask(taskId);
  if (!task) return { ok: false, error: `no such task "${taskId}"` };
  return { ok: true, brief: briefFromTaskPrompt(task.prompt), taskId };
}
