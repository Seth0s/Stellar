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
  updated_at: number;
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
  /** Groups sessions under "Projects › {project} › {session}" (item 1) —
   * "" means ungrouped, rendered as its own bucket in the UI rather than
   * treated as an error. Free text, not a filesystem path. */
  project: string;
  created_at: number;
  updated_at: number;
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

  const boardCount = (db.prepare("SELECT COUNT(*) as n FROM boards").get() as { n: number }).n;
  if (boardCount === 0) {
    const now = Date.now();
    db.prepare("INSERT INTO boards (id, name, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      DEFAULT_BOARD_ID,
      "Board 1",
      "",
      now,
      now,
    );
  }

  const listStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, updated_at FROM cards WHERE board_id = ?",
  );
  // Used only by acbridge's `list` command (main/message-bus.ts) — that
  // protocol has no notion of boards, and restricting it to the caller's
  // own board would need the caller's board_id threaded through a wire
  // format that doesn't carry it today. Same "list every terminal card"
  // behavior this already had before boards existed.
  const listAllStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, updated_at FROM cards",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, updated_at)
    VALUES (@id, @board_id, @kind, @provider, @cwd, @x, @y, @w, @h, @resume_id, @model, @system_prompt, @group_id, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, kind = excluded.kind, provider = excluded.provider, cwd = excluded.cwd,
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      resume_id = excluded.resume_id, model = excluded.model, system_prompt = excluded.system_prompt,
      group_id = excluded.group_id,
      updated_at = excluded.updated_at
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
    "SELECT id, name, project, created_at, updated_at FROM boards ORDER BY created_at ASC",
  );
  const upsertBoardStmt = db.prepare(`
    INSERT INTO boards (id, name, project, created_at, updated_at)
    VALUES (@id, @name, @project, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, project = excluded.project, updated_at = excluded.updated_at
  `);
  const deleteBoardStmt = db.prepare("DELETE FROM boards WHERE id = ?");

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
    upsertCard: (card: CardRow) => upsertStmt.run(card),
    deleteCard: (id: string) => deleteStmt.run(id),
    listConnectors: (boardId: string): ConnectorRow[] => listConnectorsStmt.all(boardId) as ConnectorRow[],
    upsertConnector: (row: ConnectorRow) => upsertConnectorStmt.run(row),
    deleteConnector: (id: string) => deleteConnectorStmt.run(id),
    deleteConnectorsForCard: (cardId: string) => deleteConnectorsForCardStmt.run(cardId, cardId),
    listBoards: (): BoardRow[] => listBoardsStmt.all() as BoardRow[],
    upsertBoard: (board: BoardRow) => upsertBoardStmt.run(board),
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
