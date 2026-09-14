/**
 * Runtime identity migration: `agent-canvas` → `stellar`.
 *
 * Measured 2026-09-14: `app.setName` owns `app.getPath("userData")`, the
 * single-instance lock key, and (via that path) where the DB and socket
 * live. Renaming without migration opens an empty Stellar and orphans
 * boards/cards/tasks/reports under `~/.config/agent-canvas/`.
 *
 * Decisions (this change):
 *
 * (a) Automatic on first boot. Manual is easy to forget and the empty
 *     board is irreversible-looking; auto with a pure decision + marker
 *     + selective copy is gentler and still inspectable.
 *
 * (b) Reversible. We COPY essentials into the new dir and leave the
 *     legacy directory untouched. Marker records source path + entries.
 *     Reverse = restore `setName("agent-canvas")` (or point at the old
 *     dir) — old bytes are still there. Deleting `~/.config/stellar`
 *     alone also returns you to a world where only the legacy dir exists.
 *
 * (c) Legacy dir stays intact. Never delete without explicit owner OK.
 *     Selective copy (~few MB: DB trio, secrets, locale, remote-devices,
 *     board-assets) — not the ~970 MB Chromium cache.
 *
 * (d) Guard: if the legacy sock still accepts connections, ABORT. The
 *     new lock key does not serialize against an old `agent-canvas`
 *     process; dual writers on copied-then-diverging DBs is worse than
 *     a refused start.
 *
 * (e) Keep on-disk basenames `agent-canvas.db` / `agent-canvas.sock`
 *     inside the new userData. Fixtures that name those files stay true;
 *     renaming them would bloat the diff for no state win. `AGENT_CANVAS_*`
 *     env vars are intentionally untouched.
 *
 * WAL: copy `.db` + `.db-wal` + `.db-shm` together. Do NOT open/checkpoint
 * the source — checkpoint needs a quiet writer and a solo `.db` copy drops
 * uncheckpointed transactions. Legacy must be idle (see (d)).
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import net from "node:net";

export const LEGACY_APP_NAME = "agent-canvas";
export const APP_NAME = "stellar";

/** Filenames inside userData — kept across the identity change (see (e)). */
export const DB_BASENAME = "agent-canvas.db";
export const SOCK_BASENAME = "agent-canvas.sock";

export const MIGRATION_MARKER = ".migrated-from-agent-canvas";
export const MIGRATION_IN_PROGRESS = ".migration-in-progress";

/** Essentials only — never Chromium Cache / Code Cache / GPUCache / etc. */
export const MIGRATE_ENTRIES = [
  "agent-canvas.db",
  "agent-canvas.db-wal",
  "agent-canvas.db-shm",
  "secrets.json",
  "locale.json",
  "remote-devices.json",
  "board-assets",
] as const;

export type MigrationFsSnapshot = {
  legacyHasDb: boolean;
  legacyInstanceLive: boolean;
  newHasDb: boolean;
  newHasMarker: boolean;
  newHasInProgress: boolean;
};

export type MigrationDecision =
  | { action: "skip"; reason: "already-migrated" | "no-legacy-data" }
  | { action: "migrate" }
  | {
      action: "abort";
      reason: "legacy-instance-live" | "partial-interrupted" | "target-conflict";
    };

/**
 * Pure gate for the first-boot migration. No I/O — callers assemble the
 * snapshot (existsSync + sock probe) and apply the result.
 */
export function decideUserDataMigration(snap: MigrationFsSnapshot): MigrationDecision {
  if (snap.newHasMarker) return { action: "skip", reason: "already-migrated" };
  if (snap.newHasInProgress) return { action: "abort", reason: "partial-interrupted" };
  if (snap.legacyInstanceLive && snap.legacyHasDb) {
    return { action: "abort", reason: "legacy-instance-live" };
  }
  if (!snap.legacyHasDb) return { action: "skip", reason: "no-legacy-data" };
  // New DB without a marker means a half-baked or foreign profile — do
  // not overwrite and do not pretend we migrated.
  if (snap.newHasDb) return { action: "abort", reason: "target-conflict" };
  return { action: "migrate" };
}

/** Parent of Electron userData is where sibling app names live (Linux
 * `~/.config`, macOS Application Support, Windows %APPDATA%). */
export function legacyUserDataDir(newUserDataDir: string, legacyName: string = LEGACY_APP_NAME): string {
  return join(dirname(newUserDataDir), legacyName);
}

export function readMigrationFsSnapshot(
  legacyDir: string,
  newDir: string,
  legacyInstanceLive: boolean,
): MigrationFsSnapshot {
  return {
    legacyHasDb: existsSync(join(legacyDir, DB_BASENAME)),
    legacyInstanceLive,
    newHasDb: existsSync(join(newDir, DB_BASENAME)),
    newHasMarker: existsSync(join(newDir, MIGRATION_MARKER)),
    newHasInProgress: existsSync(join(newDir, MIGRATION_IN_PROGRESS)),
  };
}

/** True when something accepts connections on the legacy sock (old app up). */
export function probeLegacyInstanceLive(legacySockPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(legacySockPath)) {
      resolve(false);
      return;
    }
    const socket = net.connect(legacySockPath);
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

export type MigrationMarker = {
  from: string;
  at: string;
  entries: string[];
  /** Copy, not move — legacy dir left intact for reverse. */
  mode: "copy-essentials";
};

export type MigrationApplyResult =
  | { ok: true; copied: string[]; marker: MigrationMarker }
  | { ok: false; error: string };

/**
 * Selective copy. Leaves `legacyDir` untouched. Writes an in-progress
 * marker first; promotes to the durable marker on success; on failure
 * leaves in-progress so the next boot aborts instead of double-copying.
 */
export function applyUserDataMigration(legacyDir: string, newDir: string): MigrationApplyResult {
  mkdirSync(newDir, { recursive: true });
  const inProgressPath = join(newDir, MIGRATION_IN_PROGRESS);
  const markerPath = join(newDir, MIGRATION_MARKER);
  writeFileSync(
    inProgressPath,
    JSON.stringify({ from: legacyDir, startedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );

  const copied: string[] = [];
  try {
    for (const entry of MIGRATE_ENTRIES) {
      const src = join(legacyDir, entry);
      if (!existsSync(src)) continue;
      const dest = join(newDir, entry);
      // DB trio must land as a unit; copyFile is fine while legacy is idle.
      if (entry === "board-assets") {
        cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
      } else {
        copyFileSync(src, dest);
      }
      copied.push(entry);
    }

    if (!copied.includes(DB_BASENAME)) {
      throw new Error(`legacy DB missing at ${join(legacyDir, DB_BASENAME)}`);
    }

    const marker: MigrationMarker = {
      from: legacyDir,
      at: new Date().toISOString(),
      entries: copied,
      mode: "copy-essentials",
    };
    // Atomic-ish: write temp then rename over the final marker path.
    const tmpMarker = `${markerPath}.tmp`;
    writeFileSync(tmpMarker, JSON.stringify(marker, null, 2), "utf8");
    renameSync(tmpMarker, markerPath);
    rmSync(inProgressPath, { force: true });
    return { ok: true, copied, marker };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function readMigrationMarker(newDir: string): MigrationMarker | null {
  const path = join(newDir, MIGRATION_MARKER);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MigrationMarker;
  } catch {
    return null;
  }
}
