/**
 * Filters + projection for `list_tasks` / `acbridge list-tasks`.
 *
 * Derived from what the orchestrator actually queried in sqlite this
 * sprint (task briefings + the card-467 critique), not from a generic
 * REST wishlist:
 *
 *   select … from tasks where board_id=? and status in ('pending','running')
 *   — every "what's live on the board" scan
 *   pending + card vivo (PTY still up)
 *   — "Fila mente" / "pending com card vivo"
 *   updated_at window
 *   — timeline between tasks (critique's `since`)
 *
 * Projection is two named views, not free-form field lists: a field
 * allowlist becomes an API nobody remembers; `summary` vs `full` is one
 * bit the agent can learn. Measured on the live DB (~104 tasks): full
 * dump ≈ 276 KiB (prompt+result dominate); summary of the same ≈ 38 KiB;
 * filtered summary ≈ a few KiB. Pagination is not built — a filtered
 * summary already fits; don't ship a cursor nobody will call.
 *
 * `status` filters the status the row returns. `hasCard` means the
 * principal cardId is PTY-alive (`isCardAlive`) — not merely present in
 * the cards table (a closed card can leave a stale card_id).
 */

export type ListTasksView = "summary" | "full";

/** Serialized task shape produced by message-bus `serializeTask`. */
export type ListedTask = {
  id: string;
  prompt: string;
  provider: string | null;
  /** O que o BANCO diz (pendente até um julgamento ser escrito). Nunca é
   * `running` por processo vivo — `running` não é coluna autoritativa
   * (task b41ac547). */
  status: string;
  /** O SEGUNDO FATO (task b41ac547): o `cardId` principal está com PTY vivo
   * AGORA. Mesmo nome/meaning da projeção da Fila em `src/main/index.ts`.
   * `false` cobre cardId null, card fechado e PTY morto — e não afirma
   * trabalho: o app não tem esse sinal. */
  cardAlive: boolean;
  cardId: string | null;
  boardId: string | null;
  cwd: string | null;
  purpose: string | null;
  review: string | null;
  territory: string[] | null;
  /** Gates declarados: string ou `{cmd, exclusive:"machine"}` (task ff24b36d). */
  gates: import("./gate-declaration").GateSpec[] | null;
  allowCommit: boolean | null;
  reportSchema: string[] | null;
  result: unknown;
  deps: unknown;
  retryCount: number;
  attemptedProviders: unknown;
  maxRetries: number;
  fallbackProviders: unknown;
  order: number | null;
  suggestedOrder: number | null;
  createdAt: number;
  updatedAt: number;
  divergedStatus: string | null;
  divergedActor: string | null;
  requestedStatus: string | null;
  requestedReason: string | null;
  requestedBy: string | null;
  requestedAt: number | null;
  sprintId: string | null;
  transitions?: unknown;
  cards?: unknown;
  verdicts?: unknown;
  /** Fase DERIVADA (task 6266d3e7) — ver task-phase-decision.ts. Preenchida
   * pelo bus antes de projetar; o filtro `phase` e o summary a usam. */
  phase?: string;
  /** Primeira linha do prompt (título curto) — só no summary. */
  title?: string;
  /** Resumo do gateRun medido pelo app (task 6266d3e7): ok e N/M verdes. */
  gateRun?: GateRunSummary | null;
};

/** Resumo do `result_json.gateRun` para leitura em lista (sem o stdout). */
export type GateRunSummary = { ok: boolean; passed: number; total: number; failedCommand: string | null };

/** Extrai o resumo do gateRun do `result_json` de uma task. PURA e defensiva:
 * linha antiga / JSON podre / sem `commands` → `null` (ausência é dado). */
export function gateRunSummaryFromResult(result: unknown): GateRunSummary | null {
  if (typeof result !== "object" || result === null) return null;
  const g = (result as Record<string, unknown>).gateRun;
  if (typeof g !== "object" || g === null) return null;
  const commands = (g as Record<string, unknown>).commands;
  if (!Array.isArray(commands)) return null;
  let passed = 0;
  let failedCommand: string | null = null;
  for (const c of commands) {
    if (typeof c !== "object" || c === null) continue;
    const exit = (c as Record<string, unknown>).exitCode;
    if (exit === 0) passed++;
    else if (failedCommand === null) {
      const cmd = (c as Record<string, unknown>).command;
      failedCommand = typeof cmd === "string" ? cmd : "?";
    }
  }
  return { ok: (g as Record<string, unknown>).ok === true, passed, total: commands.length, failedCommand };
}

/** Primeira linha não-vazia do prompt, truncada — o "título" da task no summary. */
export function taskTitle(prompt: string | null | undefined): string {
  const line = (prompt ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

export type ListTasksQuery = {
  /** One status or several (`pending,running`). Omit = every status. */
  status?: string | string[];
  /** Epoch-ms lower bound on `updatedAt`. Omit = no time window. */
  since?: number;
  /**
   * true  = principal cardId is PTY-alive
   * false = no live principal card
   * Omit = either.
   */
  hasCard?: boolean;
  /** One phase or several (task 6266d3e7). */
  phase?: string | string[];
  sprintId?: string;
  boardId?: string;
  cardId?: string;
  /** Task ids or PREFIXES (>= 8) — kept as prefixes, matched by startsWith. */
  ids?: string[];
  limit?: number;
  cursor?: number;
  /** `summary` drops prompt+result; `full` is the heavy shape. Default summary. */
  view?: ListTasksView;
};

export type ListTasksQueryError = { ok: false; error: string };
export type ListTasksQueryOk = {
  ok: true;
  statusSet?: Set<string>;
  since?: number;
  hasCard?: boolean;
  phaseSet?: Set<string>;
  sprintId?: string;
  boardId?: string;
  cardId?: string;
  ids?: string[];
  limit?: number;
  cursor?: number;
  view: ListTasksView;
};

/** Validate/normalize the wire fields. Unknown `view` is refused (no silent
 * fallback — that would look like the filter "worked" while burning context). */
export function parseListTasksQuery(raw: {
  status?: unknown;
  since?: unknown;
  hasCard?: unknown;
  view?: unknown;
  phase?: unknown;
  sprintId?: unknown;
  boardId?: unknown;
  cardId?: unknown;
  ids?: unknown;
  limit?: unknown;
  cursor?: unknown;
}): ListTasksQueryError | ListTasksQueryOk {
  let statusSet: Set<string> | undefined;
  if (raw.status !== undefined && raw.status !== null) {
    const list = Array.isArray(raw.status) ? raw.status : [raw.status];
    if (list.length === 0) return { ok: false, error: "status filter is empty — pass one or more statuses, or omit the filter" };
    for (const s of list) {
      if (typeof s !== "string" || s.length === 0) {
        return { ok: false, error: `status filter entries must be non-empty strings, got ${JSON.stringify(s)}` };
      }
    }
    statusSet = new Set(list as string[]);
  }

  let phaseSet: Set<string> | undefined;
  if (raw.phase !== undefined && raw.phase !== null) {
    const list = Array.isArray(raw.phase) ? raw.phase : [raw.phase];
    if (list.length === 0) return { ok: false, error: "phase filter is empty — pass one or more phases, or omit the filter" };
    for (const p of list) {
      if (typeof p !== "string" || p.length === 0) {
        return { ok: false, error: `phase filter entries must be non-empty strings, got ${JSON.stringify(p)}` };
      }
    }
    phaseSet = new Set(list as string[]);
  }

  let since: number | undefined;
  if (raw.since !== undefined && raw.since !== null) {
    if (typeof raw.since !== "number" || !Number.isFinite(raw.since)) {
      return { ok: false, error: `since must be a finite epoch-ms number, got ${JSON.stringify(raw.since)}` };
    }
    since = raw.since;
  }

  let hasCard: boolean | undefined;
  if (raw.hasCard !== undefined && raw.hasCard !== null) {
    if (typeof raw.hasCard !== "boolean") {
      return { ok: false, error: `hasCard must be boolean, got ${JSON.stringify(raw.hasCard)}` };
    }
    hasCard = raw.hasCard;
  }

  const str = (v: unknown, name: string): string | undefined | { error: string } => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || v.trim().length === 0) return { error: `${name} must be a non-empty string, got ${JSON.stringify(v)}` };
    return v.trim();
  };
  const sprintId = str(raw.sprintId, "sprintId");
  if (sprintId && typeof sprintId === "object") return { ok: false, error: (sprintId as { error: string }).error };
  const boardId = str(raw.boardId, "boardId");
  if (boardId && typeof boardId === "object") return { ok: false, error: (boardId as { error: string }).error };
  const cardId = str(raw.cardId, "cardId");
  if (cardId && typeof cardId === "object") return { ok: false, error: (cardId as { error: string }).error };

  let ids: string[] | undefined;
  if (raw.ids !== undefined && raw.ids !== null) {
    if (!Array.isArray(raw.ids) || raw.ids.length === 0) return { ok: false, error: "ids must be a non-empty array of task ids or prefixes" };
    for (const id of raw.ids) {
      if (typeof id !== "string" || id.trim().length === 0) return { ok: false, error: `ids entries must be non-empty strings, got ${JSON.stringify(id)}` };
    }
    ids = (raw.ids as string[]).map((s) => s.trim());
  }

  let limit: number | undefined;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit <= 0) return { ok: false, error: `limit must be a positive integer, got ${JSON.stringify(raw.limit)}` };
    limit = raw.limit;
  }
  let cursor: number | undefined;
  if (raw.cursor !== undefined && raw.cursor !== null) {
    if (typeof raw.cursor !== "number" || !Number.isInteger(raw.cursor) || raw.cursor < 0) return { ok: false, error: `cursor must be a non-negative integer, got ${JSON.stringify(raw.cursor)}` };
    cursor = raw.cursor;
  }

  let view: ListTasksView = "summary";
  if (raw.view !== undefined && raw.view !== null) {
    if (raw.view !== "summary" && raw.view !== "full") {
      return { ok: false, error: `view must be "summary" or "full", got ${JSON.stringify(raw.view)}` };
    }
    view = raw.view;
  }

  return {
    ok: true,
    statusSet,
    since,
    hasCard,
    phaseSet,
    ...(sprintId ? { sprintId } : {}),
    ...(boardId ? { boardId } : {}),
    ...(cardId ? { cardId } : {}),
    ...(ids ? { ids } : {}),
    ...(limit ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    view,
  };
}

export function filterListedTasks(
  tasks: ListedTask[],
  query: ListTasksQueryOk,
  aliveCardIds: ReadonlySet<string>,
): ListedTask[] {
  return tasks.filter((t) => {
    if (query.statusSet && !query.statusSet.has(t.status)) return false;
    if (query.phaseSet && !(t.phase !== undefined && query.phaseSet.has(t.phase))) return false;
    if (query.sprintId !== undefined && t.sprintId !== query.sprintId) return false;
    if (query.boardId !== undefined && t.boardId !== query.boardId) return false;
    if (query.cardId !== undefined && t.cardId !== query.cardId) return false;
    if (query.ids !== undefined && !query.ids.some((p) => t.id === p || t.id.startsWith(p))) return false;
    if (query.since !== undefined && t.updatedAt < query.since) return false;
    if (query.hasCard !== undefined) {
      const alive = t.cardId != null && aliveCardIds.has(t.cardId);
      if (query.hasCard !== alive) return false;
    }
    return true;
  });
}

/** O shape do `view:"summary"` (task 6266d3e7): a ALLOWLIST que o orquestrador
 * varre, não "o full menos prompt/result". Medido: o "full menos prompt" de 120
 * tasks ainda dava ~79 KB; esta allowlist fica 1 ordem de grandeza abaixo. */
export type ListedTaskSummary = {
  id: string;
  title: string;
  status: string;
  phase?: string;
  cardId: string | null;
  deps: unknown;
  updatedAt: number;
  gateRun: GateRunSummary | null;
};

/** `summary` = a allowlist acima (default desde a task 6266d3e7); `full` = a
 * linha inteira. */
export function projectListedTask(task: ListedTask, view: ListTasksView): ListedTask | ListedTaskSummary {
  if (view === "full") return task;
  return {
    id: task.id,
    title: task.title ?? taskTitle(task.prompt),
    status: task.status,
    ...(task.phase !== undefined ? { phase: task.phase } : {}),
    cardId: task.cardId,
    deps: task.deps,
    updatedAt: task.updatedAt,
    gateRun: task.gateRun ?? null,
  };
}
