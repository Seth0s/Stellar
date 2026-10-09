import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  sanitizeUserDataPermissions,
  writePrivateFile,
} from "../../src/main/user-data-permissions";

const temporaryRoots: string[] = [];

function createTemporaryRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "stellar-private-data-"));
  temporaryRoots.push(path);
  return path;
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("user data permissions", () => {
  it("creates private directories and files", () => {
    const root = createTemporaryRoot();
    const file = join(root, "profiles", "profile-a", "secrets.json");

    writePrivateFile(file, "{}\n");

    expect(modeOf(join(root, "profiles"))).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(join(root, "profiles", "profile-a"))).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(file)).toBe(PRIVATE_FILE_MODE);
  });

  it("sanitizes existing profile, board context, backup, and legacy data", () => {
    const root = createTemporaryRoot();
    const baseUserDataDir = join(root, "stellar");
    const userDataDir = join(baseUserDataDir, "profiles", "profile-a");
    const backupDir = join(baseUserDataDir, "profiles-migration-backup-123", "board-assets");
    const boardContextDir = join(baseUserDataDir, "board-context");
    const legacyUserDataDir = join(root, "agent-canvas");
    mkdirSync(userDataDir, { recursive: true, mode: 0o755 });
    mkdirSync(backupDir, { recursive: true, mode: 0o755 });
    mkdirSync(boardContextDir, { recursive: true, mode: 0o755 });
    mkdirSync(legacyUserDataDir, { recursive: true, mode: 0o755 });
    const profileDb = join(userDataDir, "agent-canvas.db");
    const backupAsset = join(backupDir, "artifact.bin");
    const boardContext = join(boardContextDir, "board-a.json");
    const legacyDb = join(legacyUserDataDir, "agent-canvas.db");
    writeFileSync(profileDb, "profile", { mode: 0o644 });
    writeFileSync(backupAsset, "backup", { mode: 0o644 });
    writeFileSync(boardContext, "{}", { mode: 0o644 });
    writeFileSync(legacyDb, "legacy", { mode: 0o644 });
    chmodSync(baseUserDataDir, 0o755);
    chmodSync(userDataDir, 0o755);
    chmodSync(backupDir, 0o755);
    chmodSync(join(baseUserDataDir, "profiles-migration-backup-123"), 0o755);
    chmodSync(boardContextDir, 0o755);
    chmodSync(legacyUserDataDir, 0o755);

    sanitizeUserDataPermissions({ baseUserDataDir, userDataDir, legacyUserDataDir });

    expect(modeOf(baseUserDataDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(userDataDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(join(baseUserDataDir, "profiles"))).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(join(baseUserDataDir, "profiles-migration-backup-123"))).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(backupDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(boardContextDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(legacyUserDataDir)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(modeOf(profileDb)).toBe(PRIVATE_FILE_MODE);
    expect(modeOf(backupAsset)).toBe(PRIVATE_FILE_MODE);
    expect(modeOf(boardContext)).toBe(PRIVATE_FILE_MODE);
    expect(modeOf(legacyDb)).toBe(PRIVATE_FILE_MODE);
  });
});
