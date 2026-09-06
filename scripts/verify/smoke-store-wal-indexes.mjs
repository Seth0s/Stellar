// Pre-release audit P3 — `store.ts` never set a journal mode (SQLite's
// rollback-journal default, which briefly locks readers out on every
// write) and had no index at all on the columns its own hot queries
// filter by (`cards.board_id`, `connectors.board_id`/`from_card_id`/
// `to_card_id`, `tasks.board_id`) — every one of them forced a full
// table scan as the table grows. Fixed with `PRAGMA journal_mode = WAL`
// (set once, right after opening) and `CREATE INDEX IF NOT EXISTS` for
// each of those five columns.
//
// This is explicitly a non-functional item (the audit's own verification
// note: no behavior changes, only the query plan). Verifies live by
// opening the REAL `.db` file a real app session created — not a
// synthetic schema — with a second, direct `better-sqlite3` connection
// (the same library store.ts itself uses) and running real
// `PRAGMA`/`EXPLAIN QUERY PLAN` statements against it.
import Database from "better-sqlite3";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-store-wal-indexes-${CDP_PORT}`, import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Store WAL Indexes Teste");
  await new Promise((r) => setTimeout(r, 500));
  page.close();
} finally {
  await stopApp(app); // fully closed — no concurrent writer while we inspect the file directly
}

const db = new Database(`${USER_DATA_DIR}/agent-canvas.db`, { readonly: true });
try {
  check("the real db file is in WAL mode", db.pragma("journal_mode", { simple: true }), "wal");

  function planUsesIndex(sql, indexName) {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => row.detail)
      .join(" | ");
    return plan.includes(indexName);
  }

  check(
    "cards filtered by board_id uses idx_cards_board_id, not a full scan",
    planUsesIndex("SELECT * FROM cards WHERE board_id = 'x'", "idx_cards_board_id"),
    true,
  );
  check(
    "connectors filtered by board_id uses idx_connectors_board_id",
    planUsesIndex("SELECT * FROM connectors WHERE board_id = 'x'", "idx_connectors_board_id"),
    true,
  );
  check(
    "connectors filtered by from_card_id uses idx_connectors_from_card_id",
    planUsesIndex("SELECT * FROM connectors WHERE from_card_id = 'x'", "idx_connectors_from_card_id"),
    true,
  );
  check(
    "connectors filtered by to_card_id uses idx_connectors_to_card_id",
    planUsesIndex("SELECT * FROM connectors WHERE to_card_id = 'x'", "idx_connectors_to_card_id"),
    true,
  );
  check(
    "tasks filtered by board_id uses idx_tasks_board_id",
    planUsesIndex("SELECT * FROM tasks WHERE board_id = 'x'", "idx_tasks_board_id"),
    true,
  );
} finally {
  db.close();
}
finish();
