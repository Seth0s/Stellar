/**
 * Pure decision for auto-dispatch spawn params.
 *
 * Provider: NEVER invent a constant (`?? "claude"` bit five tasks on
 * 2026-09-13). Undeclared → refuse with a visible reason; the orchestrator
 * declares. Inheritance of provider is deliberately NOT here — multiprovider
 * routing is by task shape, not lineage (owner 2026-09-13).
 *
 * Cwd: own declaration wins; else the dependency chain (parent task cwd,
 * then grandparent, …). Repo does not change down a deps edge. Divergent
 * parent cwds → refuse. Nobody has one → `undefined` so the renderer keeps
 * `activeBoardCwd` (declared board-root fallback, not a hardcoded path).
 */

/** Non-empty trimmed cwd, or null if absent. Whitespace-only is absent. */
export function normalizeTaskCwd(cwd: string | null | undefined): string | null {
  const trimmed = typeof cwd === "string" ? cwd.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Non-empty task cwd wins; otherwise `undefined` so the renderer keeps
 * using `activeBoardCwd`. */
export function resolveTaskDispatchCwd(taskCwd: string | null | undefined): string | undefined {
  return normalizeTaskCwd(taskCwd) ?? undefined;
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

export const PROVIDER_UNDECLARED_REASON = "provider não declarado";

export type TaskDispatchProviderDecision =
  | { action: "dispatch"; provider: string }
  | { action: "refuse"; reason: string };

/** Only an explicit non-empty provider dispatches. No default, no inherit. */
export function decideTaskDispatchProvider(provider: string | null | undefined): TaskDispatchProviderDecision {
  const trimmed = typeof provider === "string" ? provider.trim() : "";
  if (!trimmed) return { action: "refuse", reason: PROVIDER_UNDECLARED_REASON };
  return { action: "dispatch", provider: trimmed };
}

/** One ancestor row for cwd inheritance — filled by the bus from `getTask`. */
export type AncestorCwdNode = {
  id: string;
  cwd: string | null | undefined;
  depIds: string[];
};

export type TaskDispatchCwdDecision =
  | { action: "ok"; cwd: string | undefined }
  | { action: "refuse"; reason: string };

/**
 * Own cwd wins. Else unique cwd from the dependency chain (BFS: parent
 * declaration, else that parent's deps). Divergent resolved cwds → refuse
 * with an actionable reason. Empty chain → `undefined` (board root).
 */
export function decideTaskDispatchCwd(
  taskCwd: string | null | undefined,
  ancestors: AncestorCwdNode[],
  rootDepIds: string[],
): TaskDispatchCwdDecision {
  const own = normalizeTaskCwd(taskCwd);
  if (own) return { action: "ok", cwd: own };

  const byId = new Map(ancestors.map((node) => [node.id, node]));
  const resolved: string[] = [];
  const seen = new Set<string>();

  function walk(depIds: string[]) {
    for (const id of depIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id);
      if (!node) continue;
      const cwd = normalizeTaskCwd(node.cwd);
      if (cwd) {
        resolved.push(cwd);
        continue;
      }
      walk(node.depIds);
    }
  }
  walk(rootDepIds);

  const unique = [...new Set(resolved)];
  if (unique.length === 1) return { action: "ok", cwd: unique[0] };
  if (unique.length > 1) {
    return { action: "refuse", reason: `pais divergem em cwd: ${unique.join(", ")}` };
  }
  return { action: "ok", cwd: undefined };
}
