import Database from "better-sqlite3";
import { join } from "node:path";

export type CardRow = {
  id: string;
  board_id: string;
  kind: string;
  provider: string;
  cwd: string;
  x: number;
  y: number;
  w: number;
  h: number;
  resume_id: string | null;
  model: string | null;
  system_prompt: string | null;
  group_id: string | null;
  /** User-set display name (item: header rename), null = fall back to a
   * kind-specific default (provider id, "arquivos", etc). Deliberately its
   * own column instead of overloading `provider`/`cwd` the way every other
   * per-kind field does — those are already stretched thin (see App.tsx's
   * toRow/fromRow), and every kind needs this one the same way. */
  label: string | null;
  updated_at: number;
  /** DESIGN-BACKLOG.md item 12, Fase C — chat message history. A real
   * dedicated column, not another squeeze into `cwd`/`resume_id`: Fase B
   * put the JSON blob in `cwd` (following stroke's precedent), which
   * worked while chat had no real project root of its own to store —
   * Fase C's file tools need `cwd` back for its normal meaning (the
   * kind's actual root path, same as files/changes/terminal), so the
   * messages needed a column of their own instead. `fromRow` (App.tsx)
   * falls back to parsing a legacy Fase-B row's `cwd` as the messages
   * blob when this column is empty, so an existing chat card from before
   * this migration doesn't lose its history. */
  messages_json: string | null;
  /** DESIGN-BACKLOG.md item 30 — closing a `chat`-kind card archives it
   * (this set to a real timestamp) instead of deleting the row, so its
   * `messages_json` history survives for the sessions sidebar to list
   * and reopen later. `null` = live, showing on its board — every OTHER
   * kind (terminal/browser/files/…) never sets this at all, closing them
   * is still a real `deleteCard` exactly as before; only chat's history
   * is worth keeping around after the card itself is gone. */
  archived_at: number | null;
};

export type ConnectorRow = {
  id: string;
  board_id: string;
  from_card_id: string;
  to_card_id: string;
  updated_at: number;
  /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 4 — `null`
   * (every connector before this, and any the human draws via the UI
   * today) means purely decorative, no semantic — never silently
   * reinterpreted as a hard gate. `'depends'`/`'context'` is meaning an
   * orchestrating agent attaches on purpose via `set_connector_kind`.
   * DELIBERATELY not consumed by item 60 peça 3's task-auto-dispatch
   * engine, and never will be by design, not oversight (flagged live by
   * a reviewing agent as a potential ambiguity, resolved by this note):
   * this links CARDS, which may or may not have a task at all; a task's
   * real dependency graph is `tasks.deps_json` (task ids), which exists
   * and is meaningful even for a task with no card yet. Two different
   * granularities, kept deliberately separate rather than merged into
   * one fragile dual-source-of-truth graph — `kind` here stays whatever
   * an orchestrator wants it to mean for ITS OWN reading, nothing in
   * this app ever dispatches off it. */
  kind: string | null;
};

export type BoardRow = {
  id: string;
  name: string;
  /** Display label for "Projects › {project} › {session}" grouping (item
   * 1) — "" means ungrouped. Derived automatically from `cwd`'s basename
   * at create/edit time (see useBoardStore.ts), not independently typed. */
  project: string;
  /** The session's real working directory (item 1 revisited — "não
   * persiste o caminho correto") — an absolute path under some workspace,
   * picked via PathPicker.tsx's tree. Seeds every terminal/files/changes
   * card spawned into this board (see useBoardStore.ts's seedCards and
   * App.tsx's activeBoardCwd). "" for a board that predates this column;
   * callers fall back to DEFAULT_CWD. */
  cwd: string;
  created_at: number;
  updated_at: number;
  /** Home's "último acesso" (DESIGN-BACKLOG.md item 14) — set on every
   * successful open (create or switch), NOT on metadata edits (rename/
   * project change), which is what `updated_at` already tracks. `null`
   * for a board created before this column existed. */
  last_accessed_at: number | null;
  /** DESIGN-BACKLOG.md item 59 — opt-in, per-board, never inherited by
   * duplicating a board or creating one from a template (every creation
   * path explicitly sets this `false`, it's never copied from another
   * board's row). Only a human flips this via the session UI — no
   * MCP/acbridge command ever touches it, on purpose: an agent must never
   * be able to grant itself the ability to spawn other agents without
   * asking. When `true`, `spawn_agent` requests from a card ON THIS BOARD
   * auto-approve instead of showing `AgentAskModal` (see message-bus.ts's
   * `spawn_agent` handler) — every other board, and every other
   * consent-gated action (open_url, spawn_card), is unaffected. */
  autonomous: boolean;
  /** DESIGN-BACKLOG.md item 60, peça 2 — per-board override of
   * message-bus.ts's DEFAULT_CONCURRENCY_CAP. `null` means "use the
   * default", not "zero" — a board that predates this column, or that
   * never had the cap touched, must not suddenly refuse every spawn. */
  concurrency_cap: number | null;
};

export type BoardCounts = { agents: number; active: number };

/** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 3 — a task's
 * identity is deliberately its own id, not a card's: `card_id` is
 * nullable/stale-able on purpose (closing the card, or the app
 * restarting, must never lose the task's record — only the live process
 * behind it). `deps_json`/`result_json` are opaque JSON blobs, same
 * convention as `cards.messages_json` — parsed at the message-bus/MCP
 * boundary, not here. */
export type TaskRow = {
  id: string;
  prompt: string | null;
  provider: string | null;
  status: string;
  card_id: string | null;
  /** DESIGN-BACKLOG.md item 60, peça 3 — set once at `create_task` (from
   * an explicit `boardId`, else inferred from `cardId`'s board), never
   * re-derived afterward — unlike `card_id`, this outlives the card
   * closing. `null` means the task was created with neither, and is
   * therefore never a candidate for auto-dispatch (the engine has no
   * board to check for autonomous mode) — pure external-orchestrator
   * bookkeeping only, same as before this column existed. */
  board_id: string | null;
  result_json: string | null;
  deps_json: string | null;
  /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 5 — started
   * as bare bookkeeping for an external orchestrator's own retry loop;
   * item 60 peça 4 added a REAL internal auto-retry on top, but only
   * inside an autonomous board (`board_id` set + `isBoardAutonomous`) —
   * outside that, still pure bookkeeping, unchanged. `retry_count` and
   * `attempted_providers_json` (JSON array, in order tried) exist either
   * way, so an external orchestrator that doesn't opt into autonomous
   * mode keeps working exactly as before. */
  retry_count: number;
  attempted_providers_json: string | null;
  /** DESIGN-BACKLOG.md item 60, peça 4 — set once at `create_task`,
   * never changed after. `null` means "use the app-wide default"
   * (`DEFAULT_MAX_RETRIES` in message-bus.ts), same convention as
   * `boards.concurrency_cap`. Auto-retry (peça 4) stops once
   * `retry_count` reaches this — the task stays `failed` for good,
   * no infinite retry loop. */
  max_retries: number | null;
  /** DESIGN-BACKLOG.md item 60, peça 4 follow-up — reassignment on
   * retry, the multi-provider thesis the audit actually argued for
   * (item 60's first pass only retried the SAME provider every time,
   * flagged live by a reviewing agent as not really delivering on that
   * thesis). Set once at `create_task`, in the order to try — never
   * guessed by the app itself, since "what's an acceptable substitute
   * provider" is domain-specific, not something to hardcode. `null`/
   * empty means "keep retrying the original provider", the old
   * behavior, unchanged when this is omitted. */
  fallback_providers_json: string | null;
  created_at: number;
  updated_at: number;
};

const DEFAULT_BOARD_ID = "default";

function migrate(db: Database.Database) {
  for (const col of [
    "resume_id TEXT",
    "model TEXT",
    "system_prompt TEXT",
    "kind TEXT NOT NULL DEFAULT 'terminal'",
    `board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}'`,
    "group_id TEXT",
    "label TEXT",
    "messages_json TEXT",
    "archived_at INTEGER",
  ]) {
    try {
      db.exec(`ALTER TABLE cards ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  try {
    db.exec(`ALTER TABLE connectors ADD COLUMN board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}'`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE connectors ADD COLUMN kind TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  for (const col of ["retry_count INTEGER NOT NULL DEFAULT 0", "attempted_providers_json TEXT"]) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN project TEXT NOT NULL DEFAULT ''`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN last_accessed_at INTEGER`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN cwd TEXT NOT NULL DEFAULT ''`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN concurrency_cap INTEGER`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN board_id TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN max_retries INTEGER`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN fallback_providers_json TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
}

export function openStore(userDataDir: string) {
  const db = new Database(join(userDataDir, "agent-canvas.db"));
  // Pre-release audit P3 — no journal mode was ever set (SQLite's
  // rollback-journal default), meaning every writer briefly locks
  // readers out. WAL lets the renderer's frequent reads (board/card
  // lists, chat history) proceed concurrently with the frequent small
  // writes (card position drags, chat message appends) this app does
  // constantly. Set once, up front, before anything reads/writes.
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}',
      kind TEXT NOT NULL DEFAULT 'terminal',
      provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
      resume_id TEXT,
      model TEXT,
      system_prompt TEXT,
      group_id TEXT,
      label TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}',
      from_card_id TEXT NOT NULL,
      to_card_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      kind TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT,
      provider TEXT,
      status TEXT NOT NULL,
      card_id TEXT,
      result_json TEXT,
      deps_json TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      attempted_providers_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Must run after every CREATE TABLE IF NOT EXISTS above (cards,
  // connectors, AND boards — it now ALTERs all three): on a brand-new
  // database running it any earlier throws "no such table" for whichever
  // table isn't created yet — confirmed live before with cards/connectors,
  // same class of bug would hit boards.project otherwise.
  migrate(db);

  // Pre-release audit P3 — the columns every hot query filters by
  // (board-scoped lists, connector lookups by either endpoint, task
  // scheduling) had no index at all, forcing a full table scan as either
  // table grows. `IF NOT EXISTS` — safe to run on every `openStore`, same
  // idempotent posture as the `CREATE TABLE IF NOT EXISTS` calls above.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cards_board_id ON cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_connectors_board_id ON connectors(board_id);
    CREATE INDEX IF NOT EXISTS idx_connectors_from_card_id ON connectors(from_card_id);
    CREATE INDEX IF NOT EXISTS idx_connectors_to_card_id ON connectors(to_card_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_board_id ON tasks(board_id);
  `);

  // Used to auto-INSERT a "Board 1" here when none existed — that was
  // right back when the app always booted straight into a board (there
  // had to be one to load). DESIGN-BACKLOG.md item 8 changed that: the
  // app now boots to Home, and zero boards is a legitimate, intentional
  // first-run state (Home's own empty-state screen), not a gap to paper
  // over. `DEFAULT_BOARD_ID` itself stays — the cards/connectors schema
  // migration above still needs it as the fallback `board_id` for rows
  // that predate multi-board support.

  // Item 30 — `AND archived_at IS NULL`: an archived chat's row stays in
  // the table (its `messages_json` is the whole point), but must never
  // reappear as a live card on the board it used to live on.
  const listStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE board_id = ? AND archived_at IS NULL",
  );
  // Used only by acbridge's `list` command (main/message-bus.ts) — that
  // protocol has no notion of boards, and restricting it to the caller's
  // own board would need the caller's board_id threaded through a wire
  // format that doesn't carry it today. Same "list every terminal card"
  // behavior this already had before boards existed. Archived chats
  // excluded here too — acbridge/MCP `list_cards` is about live, real
  // cards an agent could send/spawn to, not history.
  const listAllStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE archived_at IS NULL",
  );
  // DESIGN-BACKLOG.md item 59 — a single card lookup, needed to find
  // which board a `spawn_agent` requester's card belongs to (so the
  // autonomous-mode check can be board-scoped, not global).
  const getCardStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE id = ?",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json, archived_at)
    VALUES (@id, @board_id, @kind, @provider, @cwd, @x, @y, @w, @h, @resume_id, @model, @system_prompt, @group_id, @label, @updated_at, @messages_json, @archived_at)
    ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, kind = excluded.kind, provider = excluded.provider, cwd = excluded.cwd,
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      resume_id = excluded.resume_id, model = excluded.model, system_prompt = excluded.system_prompt,
      group_id = excluded.group_id, label = excluded.label,
      updated_at = excluded.updated_at, messages_json = excluded.messages_json, archived_at = excluded.archived_at
  `);
  const deleteStmt = db.prepare("DELETE FROM cards WHERE id = ?");
  const deleteCardsForBoardStmt = db.prepare("DELETE FROM cards WHERE board_id = ?");
  // Item 30 — the sessions sidebar's data source: every chat-kind row,
  // archived or not (an open chat is still a legitimate "session" to
  // jump back to from the sidebar, not just closed ones), newest first.
  // Pre-release audit B9 — flagged as a possible omission because this
  // is the only one of the three `cards` queries here without an
  // `archived_at IS NULL` filter. Confirmed intentional, not a bug: the
  // sidebar's whole point is browsing history INCLUDING archived
  // sessions (ChatCard.tsx renders an "arquivada" badge and lets a click
  // re-open one via `unarchiveCard` right below) — filtering them out
  // here would make that feature unreachable.
  const listChatSessionsStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE kind = 'chat' ORDER BY updated_at DESC",
  );
  const archiveCardStmt = db.prepare("UPDATE cards SET archived_at = ? WHERE id = ?");
  const unarchiveCardStmt = db.prepare("UPDATE cards SET archived_at = NULL WHERE id = ?");

  const listConnectorsStmt = db.prepare(
    "SELECT id, board_id, from_card_id, to_card_id, updated_at, kind FROM connectors WHERE board_id = ?",
  );
  // Item 58, roteiro peça 4 — same "no board scoping" convention as
  // `listAllStmt`/acbridge's `list`: an orchestrating agent reading the
  // DAG has no reason to know which board a connector lives on.
  const listAllConnectorsStmt = db.prepare("SELECT id, board_id, from_card_id, to_card_id, updated_at, kind FROM connectors");
  const upsertConnectorStmt = db.prepare(`
    INSERT INTO connectors (id, board_id, from_card_id, to_card_id, updated_at, kind)
    VALUES (@id, @board_id, @from_card_id, @to_card_id, @updated_at, @kind)
    ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, from_card_id = excluded.from_card_id, to_card_id = excluded.to_card_id,
      updated_at = excluded.updated_at, kind = excluded.kind
  `);
  const deleteConnectorStmt = db.prepare("DELETE FROM connectors WHERE id = ?");
  const deleteConnectorsForCardStmt = db.prepare(
    "DELETE FROM connectors WHERE from_card_id = ? OR to_card_id = ?",
  );
  const deleteConnectorsForBoardStmt = db.prepare("DELETE FROM connectors WHERE board_id = ?");
  const setConnectorKindStmt = db.prepare("UPDATE connectors SET kind = ?, updated_at = ? WHERE id = ?");

  const listBoardsStmt = db.prepare(
    "SELECT id, name, project, cwd, created_at, updated_at, last_accessed_at, autonomous, concurrency_cap FROM boards ORDER BY created_at ASC",
  );
  const getBoardStmt = db.prepare(
    "SELECT id, name, project, cwd, created_at, updated_at, last_accessed_at, autonomous, concurrency_cap FROM boards WHERE id = ?",
  );
  const upsertBoardStmt = db.prepare(`
    INSERT INTO boards (id, name, project, cwd, created_at, updated_at, last_accessed_at, autonomous, concurrency_cap)
    VALUES (@id, @name, @project, @cwd, @created_at, @updated_at, @last_accessed_at, @autonomous, @concurrency_cap)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, project = excluded.project, cwd = excluded.cwd,
      updated_at = excluded.updated_at, autonomous = excluded.autonomous, concurrency_cap = excluded.concurrency_cap
  `);
  const deleteBoardStmt = db.prepare("DELETE FROM boards WHERE id = ?");
  const touchBoardStmt = db.prepare("UPDATE boards SET last_accessed_at = ? WHERE id = ?");
  // DESIGN-BACKLOG.md item 59 — a dedicated single-purpose statement,
  // deliberately separate from the general `upsertBoard` a rename/cwd
  // edit already goes through: this is the one write path a human's
  // explicit toggle click uses, and only that path (see AGENTS.md's
  // architecture entry — no MCP/acbridge cmd ever calls it).
  const setBoardAutonomousStmt = db.prepare("UPDATE boards SET autonomous = ?, updated_at = ? WHERE id = ?");
  // DESIGN-BACKLOG.md item 60, peça 2 — same dedicated-statement pattern:
  // the input field next to the autonomous checkbox fires this directly,
  // not routed through the general board-edit save.
  const setBoardConcurrencyCapStmt = db.prepare("UPDATE boards SET concurrency_cap = ?, updated_at = ? WHERE id = ?");

  // Structural counts for the session-list popover (item 1). Both
  // "agents" and "active" exclude plain bash terminals (provider = 'bash')
  // — DESIGN-BACKLOG.md item 43: the topbar's own label is "N agente(s)",
  // and a bash card isn't an agent, so it must never inflate that count.
  // "active" is a STATIC proxy, not a live PTY signal: a non-loaded
  // board's processes aren't running at all (switching boards kills them,
  // see AGENTS.md), so there's no live state to report for anything but
  // the currently-open board — the best honest signal here is "structurally
  // a real agent card", identical to "agents" for a non-loaded board. The
  // renderer overrides this with real spawnError/exitCode-derived status
  // for whichever board is actually loaded (App.tsx's liveStatus).
  const cardCountsStmt = db.prepare(`
    SELECT board_id,
      SUM(CASE WHEN provider != 'bash' THEN 1 ELSE 0 END) as agents,
      SUM(CASE WHEN provider != 'bash' THEN 1 ELSE 0 END) as active
    FROM cards WHERE kind = 'terminal' GROUP BY board_id
  `);

  // Ids are a single global sequence across every board (a PTY id in the
  // main-process registry, and a connector's from/to reference, both need
  // to stay unique app-wide, not just within one board) — this seeds that
  // counter without fetching every board's full rows on boot.
  const maxIdStmt = db.prepare(`
    SELECT MAX(v) as m FROM (
      SELECT CAST(id AS INTEGER) as v FROM cards
      UNION ALL SELECT CAST(id AS INTEGER) FROM connectors
      UNION ALL SELECT CAST(id AS INTEGER) FROM boards
    )
  `);

  const listTasksStmt = db.prepare(
    "SELECT id, prompt, provider, status, card_id, board_id, result_json, deps_json, retry_count, attempted_providers_json, max_retries, fallback_providers_json, created_at, updated_at FROM tasks ORDER BY created_at ASC",
  );
  const getTaskStmt = db.prepare(
    "SELECT id, prompt, provider, status, card_id, board_id, result_json, deps_json, retry_count, attempted_providers_json, max_retries, fallback_providers_json, created_at, updated_at FROM tasks WHERE id = ?",
  );
  const upsertTaskStmt = db.prepare(`
    INSERT INTO tasks (id, prompt, provider, status, card_id, board_id, result_json, deps_json, retry_count, attempted_providers_json, max_retries, fallback_providers_json, created_at, updated_at)
    VALUES (@id, @prompt, @provider, @status, @card_id, @board_id, @result_json, @deps_json, @retry_count, @attempted_providers_json, @max_retries, @fallback_providers_json, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      prompt = excluded.prompt, provider = excluded.provider, status = excluded.status,
      card_id = excluded.card_id, board_id = excluded.board_id, result_json = excluded.result_json, deps_json = excluded.deps_json,
      retry_count = excluded.retry_count, attempted_providers_json = excluded.attempted_providers_json,
      max_retries = excluded.max_retries, fallback_providers_json = excluded.fallback_providers_json, updated_at = excluded.updated_at
  `);

  return {
    listCards: (boardId: string): CardRow[] => listStmt.all(boardId) as CardRow[],
    listAllCards: (): CardRow[] => listAllStmt.all() as CardRow[],
    // `messages_json` defaulted defensively — better-sqlite3's named-param
    // binding throws if a bound `@column` is simply absent as an object
    // key (not just `undefined`/`null`), and this IPC channel is a public
    // contract callers besides App.tsx's own `toRow` legitimately use
    // directly (every non-chat card kind, and every pre-Fase-C caller,
    // never had a reason to know this key exists at all) — a caller that
    // doesn't set it shouldn't crash the whole card save over an optional
    // field only "chat" kind cards ever populate.
    upsertCard: (card: CardRow) => upsertStmt.run({ ...card, messages_json: card.messages_json ?? null, archived_at: card.archived_at ?? null }),
    deleteCard: (id: string) => deleteStmt.run(id),
    listChatSessions: (): CardRow[] => listChatSessionsStmt.all() as CardRow[],
    archiveCard: (id: string, at: number) => archiveCardStmt.run(at, id),
    unarchiveCard: (id: string) => unarchiveCardStmt.run(id),
    listConnectors: (boardId: string): ConnectorRow[] => listConnectorsStmt.all(boardId) as ConnectorRow[],
    listAllConnectors: (): ConnectorRow[] => listAllConnectorsStmt.all() as ConnectorRow[],
    upsertConnector: (row: ConnectorRow) => upsertConnectorStmt.run({ ...row, kind: row.kind ?? null }),
    deleteConnector: (id: string) => deleteConnectorStmt.run(id),
    /** Returns whether a row actually existed to update. */
    setConnectorKind: (id: string, kind: string | null): boolean => setConnectorKindStmt.run(kind, Date.now(), id).changes > 0,
    deleteConnectorsForCard: (cardId: string) => deleteConnectorsForCardStmt.run(cardId, cardId),
    // `autonomous` is stored as SQLite's usual 0/1 INTEGER (no native
    // boolean type) — converted to/from a real `boolean` here so nothing
    // downstream (MCP JSON responses included) ever sees a raw 0/1.
    listBoards: (): BoardRow[] => (listBoardsStmt.all() as Array<Omit<BoardRow, "autonomous"> & { autonomous: number }>).map((b) => ({ ...b, autonomous: !!b.autonomous })),
    getBoard: (id: string): BoardRow | undefined => {
      const row = getBoardStmt.get(id) as (Omit<BoardRow, "autonomous"> & { autonomous: number }) | undefined;
      return row ? { ...row, autonomous: !!row.autonomous } : undefined;
    },
    upsertBoard: (board: BoardRow) => upsertBoardStmt.run({ ...board, autonomous: board.autonomous ? 1 : 0, concurrency_cap: board.concurrency_cap ?? null }),
    touchBoard: (id: string, at: number) => touchBoardStmt.run(at, id),
    setBoardAutonomous: (id: string, autonomous: boolean) => setBoardAutonomousStmt.run(autonomous ? 1 : 0, Date.now(), id),
    setBoardConcurrencyCap: (id: string, cap: number | null) => setBoardConcurrencyCapStmt.run(cap, Date.now(), id),
    getCard: (id: string): CardRow | undefined => getCardStmt.get(id) as CardRow | undefined,
    cardCounts: (): Record<string, BoardCounts> => {
      const rows = cardCountsStmt.all() as { board_id: string; agents: number; active: number }[];
      return Object.fromEntries(rows.map((r) => [r.board_id, { agents: r.agents, active: r.active }]));
    },
    deleteBoard: (id: string) => {
      deleteConnectorsForBoardStmt.run(id);
      deleteCardsForBoardStmt.run(id);
      deleteBoardStmt.run(id);
    },
    nextIdSeed: (): number => (maxIdStmt.get() as { m: number | null }).m ?? 0,
    listTasks: (): TaskRow[] => listTasksStmt.all() as TaskRow[],
    getTask: (id: string): TaskRow | undefined => getTaskStmt.get(id) as TaskRow | undefined,
    upsertTask: (task: TaskRow) => upsertTaskStmt.run(task),
    close: () => db.close(),
  };
}
