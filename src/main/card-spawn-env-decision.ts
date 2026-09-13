/**
 * Facts the app already knows at PTY spawn, delivered without a briefing
 * and without a new tool the agent would have to discover.
 *
 * Stable → env (`AGENT_CANVAS_*`). Mutable (who else is alive, whether
 * the board is autonomous) stays on the existing tools (`list_cards`,
 * `board_mode`) — an env snapshot of those ages the moment a peer opens
 * or the human toggles the board.
 *
 * `taskId` is optional in earnest. Spawn without a task is first-class:
 * the key is omitted, never a placeholder.
 */

export type DeclaredTaskIdInput = {
  /** Spawn-opts / env value. Empty or whitespace is absent — we do not invent. */
  explicit?: string | null;
  /** Task ids whose `tasks.card_id` is this card (the implementer amarra). */
  primaryTaskIds?: readonly string[];
  /** Task ids from `task_cards` for this card. */
  linkTaskIds?: readonly string[];
};

function uniqueNonEmpty(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The task this card serves, when that is a stored fact. Never picks
 * among several: one explicit, or one primary, or one link, or nothing.
 */
export function resolveDeclaredTaskId(input: DeclaredTaskIdInput): string | undefined {
  const explicit = typeof input.explicit === "string" ? input.explicit.trim() : "";
  if (explicit) return explicit;

  const primaries = uniqueNonEmpty(input.primaryTaskIds);
  if (primaries.length === 1) return primaries[0];
  if (primaries.length > 1) return undefined;

  const links = uniqueNonEmpty(input.linkTaskIds);
  if (links.length === 1) return links[0];
  return undefined;
}

export type CardIdentityEnvInput = {
  taskId?: string | null;
  cwd: string;
};

/** Extra `AGENT_CANVAS_*` keys. `TASK_ID` only when a task was declared. */
export function decideCardIdentityEnv(input: CardIdentityEnvInput): Record<string, string> {
  const env: Record<string, string> = { AGENT_CANVAS_CWD: input.cwd };
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  if (taskId) env.AGENT_CANVAS_TASK_ID = taskId;
  return env;
}

/**
 * Stamp `taskId` onto a free-form report object when the caller omitted
 * it. Does not overwrite, does not wrap arrays/primitives, does not
 * invent an id.
 */
export function fillReportTaskId(report: unknown, taskId: string | undefined): unknown {
  const id = typeof taskId === "string" ? taskId.trim() : "";
  if (!id) return report;
  if (report === null || typeof report !== "object" || Array.isArray(report)) return report;
  if (Object.prototype.hasOwnProperty.call(report, "taskId")) return report;
  return { ...report, taskId: id };
}
