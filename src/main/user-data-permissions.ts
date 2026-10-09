import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PROFILE_BACKUP_PREFIX = "profiles-migration-backup-";

const PRIVATE_USER_DATA_FILES = [
  "agent-canvas.db",
  "agent-canvas.db-wal",
  "agent-canvas.db-shm",
  "secrets.json",
  "secrets.json.tmp",
  "profiles.json",
  "profiles.json.tmp",
  "profiles-migration.backup.json",
  "profiles-migration.backup.json.tmp",
  ".profiles-migration-in-progress",
  ".profiles-migration-in-progress.tmp",
  "providers.json",
  "providers.schema.json",
  "remote-devices.json",
  "spawn-profiles.json",
  "update-prefs.json",
  "local-identity.json",
  "locale.json",
] as const;

function statIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function applyMode(path: string, mode: number, expected: "file" | "directory" | "either" = "either"): boolean {
  const stat = statIfPresent(path);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`refusing to harden a symbolic link: ${path}`);
  if (expected === "file" && !stat.isFile()) throw new Error(`expected a regular file: ${path}`);
  if (expected === "directory" && !stat.isDirectory()) throw new Error(`expected a directory: ${path}`);
  chmodSync(path, mode);
  return true;
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  applyMode(path, PRIVATE_DIRECTORY_MODE, "directory");
}

export function writePrivateFile(path: string, contents: string): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  applyMode(temporaryPath, PRIVATE_FILE_MODE, "file");
  renameSync(temporaryPath, path);
}

function directoryEntries(path: string) {
  return readdirSync(path, { withFileTypes: true });
}

export function hardenPrivateTree(path: string): void {
  const stat = statIfPresent(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`refusing to harden a symbolic link: ${path}`);
  if (stat.isDirectory()) {
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    for (const entry of directoryEntries(path)) hardenPrivateTree(join(path, entry.name));
    return;
  }
  if (stat.isFile()) chmodSync(path, PRIVATE_FILE_MODE);
}

function hardenBoardContextFiles(path: string): void {
  for (const entry of directoryEntries(path)) {
    const fullPath = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to harden a symbolic link: ${fullPath}`);
    if (entry.isFile()) applyMode(fullPath, PRIVATE_FILE_MODE, "file");
  }
}

export function sanitizeUserDataPermissions(input: {
  baseUserDataDir: string;
  userDataDir: string;
  legacyUserDataDir?: string | null;
}): void {
  const baseUserDataDir = resolve(input.baseUserDataDir);
  const userDataDir = resolve(input.userDataDir);
  const profilesDir = join(baseUserDataDir, "profiles");
  const boardContextDir = join(baseUserDataDir, "board-context");

  ensurePrivateDirectory(baseUserDataDir);
  ensurePrivateDirectory(userDataDir);
  ensurePrivateDirectory(profilesDir);
  ensurePrivateDirectory(boardContextDir);

  const profileDirs: string[] = [];
  for (const entry of directoryEntries(profilesDir)) {
    const path = join(profilesDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to harden a symbolic link: ${path}`);
    if (!entry.isDirectory()) continue;
    ensurePrivateDirectory(path);
    profileDirs.push(path);
  }

  const backupDirs: string[] = [];
  for (const entry of directoryEntries(baseUserDataDir)) {
    if (!entry.name.startsWith(PROFILE_BACKUP_PREFIX)) continue;
    const path = join(baseUserDataDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to harden a symbolic link: ${path}`);
    if (!entry.isDirectory()) continue;
    hardenPrivateTree(path);
    backupDirs.push(path);
  }

  const legacyUserDataDir = input.legacyUserDataDir ? resolve(input.legacyUserDataDir) : null;
  if (legacyUserDataDir) applyMode(legacyUserDataDir, PRIVATE_DIRECTORY_MODE, "directory");

  const sensitiveRoots = new Set([baseUserDataDir, userDataDir, ...profileDirs]);
  if (legacyUserDataDir) sensitiveRoots.add(legacyUserDataDir);
  for (const backupDir of backupDirs) sensitiveRoots.add(backupDir);
  for (const root of sensitiveRoots) {
    for (const name of PRIVATE_USER_DATA_FILES) {
      applyMode(join(root, name), PRIVATE_FILE_MODE, "file");
    }
  }
  hardenBoardContextFiles(boardContextDir);
}
