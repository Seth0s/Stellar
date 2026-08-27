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
};

export type ConnectorRow = {
  id: string;
  board_id: string;
  from_card_id: string;
  to_card_id: string;
  updated_at: number;
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
};

export type BoardCounts = { agents: number; active: number };

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
}

export function openStore(userDataDir: string) {
  const db = new Database(join(userDataDir, "agent-canvas.db"));
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
      updated_at INTEGER NOT NULL
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

  // Must run after every CREATE TABLE IF NOT EXISTS above (cards,
  // connectors, AND boards — it now ALTERs all three): on a brand-new
  // database running it any earlier throws "no such table" for whichever
  // table isn't created yet — confirmed live before with cards/connectors,
  // same class of bug would hit boards.project otherwise.
  migrate(db);

  // Used to auto-INSERT a "Board 1" here when none existed — that was
  // right back when the app always booted straight into a board (there
  // had to be one to load). DESIGN-BACKLOG.md item 8 changed that: the
  // app now boots to Home, and zero boards is a legitimate, intentional
  // first-run state (Home's own empty-state screen), not a gap to paper
  // over. `DEFAULT_BOARD_ID` itself stays — the cards/connectors schema
  // migration above still needs it as the fallback `board_id` for rows
  // that predate multi-board support.

  const listStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json FROM cards WHERE board_id = ?",
  );
  // Used only by acbridge's `list` command (main/message-bus.ts) — that
  // protocol has no notion of boards, and restricting it to the caller's
  // own board would need the caller's board_id threaded through a wire
  // format that doesn't carry it today. Same "list every terminal card"
  // behavior this already had before boards existed.
  const listAllStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json FROM cards",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json)
    VALUES (@id, @board_id, @kind, @provider, @cwd, @x, @y, @w, @h, @resume_id, @model, @system_prompt, @group_id, @label, @updated_at, @messages_json)
    ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, kind = excluded.kind, provider = excluded.provider, cwd = excluded.cwd,
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      resume_id = excluded.resume_id, model = excluded.model, system_prompt = excluded.system_prompt,
      group_id = excluded.group_id, label = excluded.label,
      updated_at = excluded.updated_at, messages_json = excluded.messages_json
  `);
  const deleteStmt = db.prepare("DELETE FROM cards WHERE id = ?");
  const deleteCardsForBoardStmt = db.prepare("DELETE FROM cards WHERE board_id = ?");

  const listConnectorsStmt = db.prepare(
    "SELECT id, board_id, from_card_id, to_card_id, updated_at FROM connectors WHERE board_id = ?",
  );
  const upsertConnectorStmt = db.prepare(`
    INSERT INTO connectors (id, board_id, from_card_id, to_card_id, updated_at)
    VALUES (@id, @board_id, @from_card_id, @to_card_id, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, from_card_id = excluded.from_card_id, to_card_id = excluded.to_card_id,
      updated_at = excluded.updated_at
  `);
  const deleteConnectorStmt = db.prepare("DELETE FROM connectors WHERE id = ?");
  const deleteConnectorsForCardStmt = db.prepare(
    "DELETE FROM connectors WHERE from_card_id = ? OR to_card_id = ?",
  );
  const deleteConnectorsForBoardStmt = db.prepare("DELETE FROM connectors WHERE board_id = ?");

  const listBoardsStmt = db.prepare(
    "SELECT id, name, project, cwd, created_at, updated_at, last_accessed_at FROM boards ORDER BY created_at ASC",
  );
  const upsertBoardStmt = db.prepare(`
    INSERT INTO boards (id, name, project, cwd, created_at, updated_at, last_accessed_at)
    VALUES (@id, @name, @project, @cwd, @created_at, @updated_at, @last_accessed_at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, project = excluded.project, cwd = excluded.cwd, updated_at = excluded.updated_at
  `);
  const deleteBoardStmt = db.prepare("DELETE FROM boards WHERE id = ?");
  const touchBoardStmt = db.prepare("UPDATE boards SET last_accessed_at = ? WHERE id = ?");

  // Structural counts for the session-list popover (item 1) — "agents" is
  // every terminal-kind card; "active" is a STATIC proxy (provider != bash,
  // i.e. an actually-configured agent vs. a plain shell), not a live PTY
  // signal: a non-loaded board's processes aren't running at all (switching
  // boards kills them, see AGENTS.md), so there's no live state to report
  // for anything but the currently-open board. The renderer overrides this
  // with real spawnError/exitCode-derived status for whichever board is
  // actually loaded (App.tsx's liveStatus).
  const cardCountsStmt = db.prepare(`
    SELECT board_id,
      COUNT(*) as agents,
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
    upsertCard: (card: CardRow) => upsertStmt.run({ ...card, messages_json: card.messages_json ?? null }),
    deleteCard: (id: string) => deleteStmt.run(id),
    listConnectors: (boardId: string): ConnectorRow[] => listConnectorsStmt.all(boardId) as ConnectorRow[],
    upsertConnector: (row: ConnectorRow) => upsertConnectorStmt.run(row),
    deleteConnector: (id: string) => deleteConnectorStmt.run(id),
    deleteConnectorsForCard: (cardId: string) => deleteConnectorsForCardStmt.run(cardId, cardId),
    listBoards: (): BoardRow[] => listBoardsStmt.all() as BoardRow[],
    upsertBoard: (board: BoardRow) => upsertBoardStmt.run(board),
    touchBoard: (id: string, at: number) => touchBoardStmt.run(at, id),
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
    close: () => db.close(),
  };
}
