import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  DB_BASENAME,
  MIGRATION_IN_PROGRESS,
  MIGRATION_MARKER,
  applyUserDataMigration,
  decideUserDataMigration,
  legacyUserDataDir,
  readMigrationFsSnapshot,
  readMigrationMarker,
  type MigrationFsSnapshot,
} from "../../src/main/user-data-migration";

function snap(partial: Partial<MigrationFsSnapshot>): MigrationFsSnapshot {
  return {
    legacyHasDb: false,
    legacyInstanceLive: false,
    newHasDb: false,
    newHasMarker: false,
    newHasInProgress: false,
    ...partial,
  };
}

describe("decideUserDataMigration (pure)", () => {
  it("skip when already migrated (marker present, legacy may still exist)", () => {
    expect(
      decideUserDataMigration(
        snap({ newHasMarker: true, legacyHasDb: true, newHasDb: true }),
      ),
    ).toEqual({ action: "skip", reason: "already-migrated" });
  });

  it("skip when no legacy DB (fresh install)", () => {
    expect(decideUserDataMigration(snap({}))).toEqual({
      action: "skip",
      reason: "no-legacy-data",
    });
  });

  it("migrate when legacy DB exists and new dir is empty of DB/marker", () => {
    expect(decideUserDataMigration(snap({ legacyHasDb: true }))).toEqual({
      action: "migrate",
    });
  });

  it("abort when legacy instance is live", () => {
    expect(
      decideUserDataMigration(snap({ legacyHasDb: true, legacyInstanceLive: true })),
    ).toEqual({ action: "abort", reason: "legacy-instance-live" });
  });

  it("abort on partial interrupted migration", () => {
    expect(
      decideUserDataMigration(snap({ legacyHasDb: true, newHasInProgress: true })),
    ).toEqual({ action: "abort", reason: "partial-interrupted" });
  });

  it("abort when new already has a DB without marker (target conflict)", () => {
    expect(
      decideUserDataMigration(snap({ legacyHasDb: true, newHasDb: true })),
    ).toEqual({ action: "abort", reason: "target-conflict" });
  });

  it("marker wins over in-progress / conflict signals", () => {
    expect(
      decideUserDataMigration(
        snap({
          newHasMarker: true,
          newHasInProgress: true,
          newHasDb: true,
          legacyHasDb: true,
          legacyInstanceLive: true,
        }),
      ),
    ).toEqual({ action: "skip", reason: "already-migrated" });
  });

  it("in-progress wins over migrate even without legacy live", () => {
    expect(
      decideUserDataMigration(snap({ newHasInProgress: true, legacyHasDb: false })),
    ).toEqual({ action: "abort", reason: "partial-interrupted" });
  });
});

describe("legacyUserDataDir", () => {
  it("resolves sibling under the same Electron userData parent", () => {
    expect(legacyUserDataDir("/home/x/.config/stellar")).toBe("/home/x/.config/agent-canvas");
    expect(legacyUserDataDir("/Users/x/Library/Application Support/stellar")).toBe(
      "/Users/x/Library/Application Support/agent-canvas",
    );
  });
});

describe("applyUserDataMigration (selective copy + WAL trio)", () => {
  let root: string;
  let legacy: string;
  let next: string;

  beforeEach(() => {
    root = join(tmpdir(), `stellar-mig-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    legacy = join(root, "agent-canvas");
    next = join(root, "stellar");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(legacy, "board-assets", "b1"), { recursive: true });
    const dbPath = join(legacy, DB_BASENAME);
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY); INSERT INTO boards VALUES ('alive');`);
    db.close();
    writeFileSync(join(legacy, "secrets.json"), '{"k":1}', "utf8");
    writeFileSync(join(legacy, "locale.json"), '{"locale":"pt-BR"}', "utf8");
    writeFileSync(join(legacy, "remote-devices.json"), "[]", "utf8");
    writeFileSync(join(legacy, "board-assets", "b1", "x.bin"), "asset", "utf8");
    // Noise that must NOT be copied (Chromium cache stand-in).
    mkdirSync(join(legacy, "Cache"), { recursive: true });
    writeFileSync(join(legacy, "Cache", "huge"), "x".repeat(1024), "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("copies DB trio + secrets/locale/remote-devices/board-assets; leaves Cache and legacy intact", () => {
    const result = applyUserDataMigration(legacy, next);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.copied).toEqual(
      expect.arrayContaining([
        "agent-canvas.db",
        "secrets.json",
        "locale.json",
        "remote-devices.json",
        "board-assets",
      ]),
    );
    expect(existsSync(join(next, "Cache"))).toBe(false);
    expect(existsSync(join(legacy, DB_BASENAME))).toBe(true);
    expect(existsSync(join(legacy, "Cache", "huge"))).toBe(true);
    expect(existsSync(join(next, MIGRATION_MARKER))).toBe(true);
    expect(existsSync(join(next, MIGRATION_IN_PROGRESS))).toBe(false);

    const marker = readMigrationMarker(next);
    expect(marker?.from).toBe(legacy);
    expect(marker?.mode).toBe("copy-essentials");

    const dest = new Database(join(next, DB_BASENAME), { readonly: true });
    const row = dest.prepare("SELECT id FROM boards").get() as { id: string };
    dest.close();
    expect(row.id).toBe("alive");
  });

  it("leaves in-progress marker when copy fails mid-flight", () => {
    // Remove the DB so the post-copy integrity check throws after other
    // essentials were copied — in-progress must remain, marker must not.
    rmSync(join(legacy, DB_BASENAME));
    rmSync(join(legacy, `${DB_BASENAME}-wal`), { force: true });
    rmSync(join(legacy, `${DB_BASENAME}-shm`), { force: true });

    const result = applyUserDataMigration(legacy, next);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/legacy DB missing/);
    expect(existsSync(join(next, MIGRATION_IN_PROGRESS))).toBe(true);
    expect(existsSync(join(next, MIGRATION_MARKER))).toBe(false);
  });

  it("readMigrationFsSnapshot + decide round-trip after successful apply", () => {
    expect(applyUserDataMigration(legacy, next).ok).toBe(true);
    const decision = decideUserDataMigration(readMigrationFsSnapshot(legacy, next, false));
    expect(decision).toEqual({ action: "skip", reason: "already-migrated" });
  });

  it("preserves rows that only exist in WAL (no checkpoint)", () => {
    // SQLite deletes -wal on the last clean close. Hold a second connection
    // open so the WAL stays on disk while we insert and copy the trio.
    const keeper = new Database(join(legacy, DB_BASENAME));
    keeper.pragma("journal_mode = WAL");
    keeper.pragma("wal_autocheckpoint = 0");

    const writer = new Database(join(legacy, DB_BASENAME));
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec(`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, body TEXT);
                 INSERT INTO reports (body) VALUES ('wal-only-row');`);
    writer.close();

    expect(existsSync(join(legacy, `${DB_BASENAME}-wal`))).toBe(true);
    const walSize = readFileSync(join(legacy, `${DB_BASENAME}-wal`)).byteLength;
    expect(walSize).toBeGreaterThan(0);

    expect(applyUserDataMigration(legacy, next).ok).toBe(true);
    keeper.close();

    const dest = new Database(join(next, DB_BASENAME));
    const n = (dest.prepare("SELECT COUNT(*) AS n FROM reports WHERE body = ?").get("wal-only-row") as {
      n: number;
    }).n;
    dest.close();
    expect(n).toBe(1);
    // Dest -wal may vanish after this clean close (SQLite checkpoints); the
    // proof that the trio carried the bytes is the row count above.
  });
});
