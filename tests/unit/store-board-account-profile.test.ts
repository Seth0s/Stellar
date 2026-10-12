import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore, type BoardRow } from "../../src/main/store";

/**
 * The owner of an account session lives in the local database: a nullable
 * column on `boards` (NULL = a local session). Against a REAL database on disk:
 *  a) a database from before the column gets it added, every old board NULL;
 *  b) the owner is persisted: close and reopen;
 *  c) moving sessions is all-or-nothing, skips ids that do not exist, and
 *     NULL moves a session back to local;
 *  d) a rename (the generic upsert) never resets the owner.
 */

function makeBoard(id: string, name: string, owner?: string | null): BoardRow {
  return {
    id,
    name,
    project: "",
    cwd: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    last_accessed_at: null,
    autonomous: false,
    concurrency_cap: null,
    orchestrator_card_id: null,
    ...(owner !== undefined ? { account_profile_id: owner } : {}),
  };
}

describe("store: owner of an account session", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const freshDir = () => (dir = mkdtempSync(join(tmpdir(), "stellar-board-owner-")));

  it("a) an older database gets the column; its boards read NULL (local), no backfill", () => {
    const d = freshDir();
    // A database as the app left it before this column existed.
    const old = new Database(join(d, "agent-canvas.db"));
    old.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    old.prepare("INSERT INTO boards (id, name, created_at, updated_at) VALUES ('1', 'Antigo', 1, 1)").run();
    old.close();

    const store = openStore(d);
    const row = store.getBoard("1")!;
    expect(row.account_profile_id).toBeNull();
    expect(store.listBoards().map((b) => b.account_profile_id)).toEqual([null]);
    store.close();
    // Opening again is a no-op for the migration.
    expect(() => openStore(d).close()).not.toThrow();
  });

  it("b) the owner is data: it survives closing and reopening the database", () => {
    const d = freshDir();
    const store = openStore(d);
    store.upsertBoard(makeBoard("1", "Local"));
    store.upsertBoard(makeBoard("2", "Da conta"));
    expect(store.setBoardAccountProfile(["2"], "profile-pro")).toBe(1);
    store.close();

    const reopened = openStore(d);
    expect(reopened.getBoard("1")!.account_profile_id).toBeNull();
    expect(reopened.getBoard("2")!.account_profile_id).toBe("profile-pro");
    expect(reopened.listBoards().map((b) => [b.id, b.account_profile_id])).toEqual([
      ["1", null],
      ["2", "profile-pro"],
    ]);
    reopened.close();
  });

  it("c) moving sessions: skips ids that do not exist; null brings one back to local", () => {
    const d = freshDir();
    const store = openStore(d);
    store.upsertBoard(makeBoard("1", "A"));
    store.upsertBoard(makeBoard("2", "B"));
    expect(store.setBoardAccountProfile(["1", "2", "ghost"], "profile-team")).toBe(2);
    expect(store.listBoards().map((b) => b.account_profile_id)).toEqual(["profile-team", "profile-team"]);
    expect(store.setBoardAccountProfile(["1"], null)).toBe(1);
    expect(store.listBoards().map((b) => b.account_profile_id)).toEqual([null, "profile-team"]);
    expect(store.setBoardAccountProfile([], "x")).toBe(0);
    store.close();
  });

  it("d) a rename does not reset the owner; a new row carries the owner it was given", () => {
    const d = freshDir();
    const store = openStore(d);
    store.upsertBoard(makeBoard("1", "Antes", "profile-pro"));
    expect(store.getBoard("1")!.account_profile_id).toBe("profile-pro");
    // The UI edits a name with a hand-built row that carries no owner.
    store.upsertBoard({ ...makeBoard("1", "Depois"), updated_at: Date.now() + 1 });
    const row = store.getBoard("1")!;
    expect(row.name).toBe("Depois");
    expect(row.account_profile_id).toBe("profile-pro");
    store.close();
  });
});
