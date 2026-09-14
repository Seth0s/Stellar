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
  status: string;
  cardId: string | null;
  boardId: string | null;
  cwd: string | null;
  purpose: string | null;
  review: string | null;
  territory: string[] | null;
  gates: string[] | null;
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
};

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
  /** `summary` drops prompt+result; `full` is today's shape. Default full. */
  view?: ListTasksView;
};

export type ListTasksQueryError = { ok: false; error: string };
export type ListTasksQueryOk = { ok: true; statusSet?: Set<string>; since?: number; hasCard?: boolean; view: ListTasksView };

/** Validate/normalize the wire fields. Unknown `view` is refused (no silent
 * fallback to full — that would look like the filter "worked" while still
 * burning context). */
export function parseListTasksQuery(raw: {
  status?: unknown;
  since?: unknown;
  hasCard?: unknown;
  view?: unknown;
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

  let view: ListTasksView = "full";
  if (raw.view !== undefined && raw.view !== null) {
    if (raw.view !== "summary" && raw.view !== "full") {
      return { ok: false, error: `view must be "summary" or "full", got ${JSON.stringify(raw.view)}` };
    }
    view = raw.view;
  }

  return { ok: true, statusSet, since, hasCard, view };
}

export function filterListedTasks(
  tasks: ListedTask[],
  query: ListTasksQueryOk,
  aliveCardIds: ReadonlySet<string>,
): ListedTask[] {
  return tasks.filter((t) => {
    if (query.statusSet && !query.statusSet.has(t.status)) return false;
    if (query.since !== undefined && t.updatedAt < query.since) return false;
    if (query.hasCard !== undefined) {
      const alive = t.cardId != null && aliveCardIds.has(t.cardId);
      if (query.hasCard !== alive) return false;
    }
    return true;
  });
}

/** `summary` keeps the scan fields the orchestrator actually selects
 * (id/status/card/board/provider/purpose/deps/order/timestamps/…) and
 * drops prompt+result — measured as ~75% of the firehose on the live DB. */
export function projectListedTask(task: ListedTask, view: ListTasksView): ListedTask | Omit<ListedTask, "prompt" | "result"> {
  if (view === "full") return task;
  const { prompt: _p, result: _r, ...rest } = task;
  return rest;
}
