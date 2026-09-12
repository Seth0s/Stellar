import { watch, type FSWatcher } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { BrowserWindow } from "electron";
import {
  COALESCE_MS,
  createCoalesceState,
  noteWatchEvent,
  takeCoalescedFlush,
  type CoalesceState,
} from "./file-watcher-coalesce";

/**
 * One non-recursive `fs.watch` per directory the FilesCard is actually
 * showing — the root listing plus each expanded folder. DESIGN-BACKLOG.md
 * §0 ("Abrir o explorador de arquivos quase derruba o app"):
 * `watch(root, { recursive: true })` on Linux walks the entire tree and
 * registers an inotify watch per directory before returning (measured
 * 6.3s / 49727 dirs against `/home/lucas/Workplace/Projects`). A later
 * prune-at-walk still left ~9648 watches on that same cwd. The FilesCard
 * only lists children of expanded dirs, so watching the rest is cost
 * with no UI to update — and `node_modules` / `.git` / `out` / `dist`
 * are refused even if someone expands them.
 *
 * Clients (one FilesCard mount = one clientId) share a root entry; the
 * watched set is the union of their expanded dirs. Unmount drops that
 * client and, when it was the last, closes every watcher for the root.
 */

type Client = {
  dirs: Set<string>;
};

type WatchEntry = {
  clients: Map<string, Client>;
  dirWatchers: Map<string, FSWatcher>;
  coalesce: CoalesceState;
  flushTimer: NodeJS.Timeout | null;
  disposed: boolean;
};

const watchers = new Map<string, WatchEntry>();

const IGNORE_DIR_NAMES = [
  "node_modules",
  ".git",
  "dist",
  "target",
  ".verify-tmp",
  "build",
  "out",
  ".cache",
];
const IGNORE_DIR_NAME_SET = new Set(IGNORE_DIR_NAMES);

/**
 * Entry-time prune: should a directory with this NAME be skipped?
 * Exact match on purpose — a prefix check would refuse a real
 * `distribution/` because it starts with `dist`. Exported for its
 * own unit test.
 */
export function isIgnoredDirName(name: string): boolean {
  return IGNORE_DIR_NAME_SET.has(name);
}

/** True if any path segment is an ignored directory name. */
export function pathHasIgnoredSegment(relPath: string): boolean {
  if (!relPath) return false;
  return relPath.split(/[/\\]/).some((part) => part.length > 0 && isIgnoredDirName(part));
}

function toPosixRel(rel: string): string {
  return rel.split(sep).join("/");
}

function clientDirSet(dirs: string[]): Set<string> {
  const next = new Set<string>([""]);
  for (const raw of dirs) {
    const rel = toPosixRel(raw).replace(/^\/+|\/+$/g, "");
    if (pathHasIgnoredSegment(rel)) continue;
    next.add(rel);
  }
  return next;
}

function unionClientDirs(entry: WatchEntry): Set<string> {
  const union = new Set<string>([""]);
  for (const client of entry.clients.values()) {
    for (const dir of client.dirs) {
      if (!pathHasIgnoredSegment(dir)) union.add(dir);
    }
  }
  return union;
}

function getOrCreateEntry(normRoot: string): WatchEntry {
  const existing = watchers.get(normRoot);
  if (existing && !existing.disposed) return existing;
  const entry: WatchEntry = {
    clients: new Map(),
    dirWatchers: new Map(),
    coalesce: createCoalesceState(),
    flushTimer: null,
    disposed: false,
  };
  watchers.set(normRoot, entry);
  return entry;
}

function flushEntry(entry: WatchEntry, rootAbs: string): void {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  const { paths } = takeCoalescedFlush(entry.coalesce);
  if (entry.disposed) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("fs:changed", { root: rootAbs, path: paths[paths.length - 1], paths });
    }
  }
}

function scheduleChangeNotify(entry: WatchEntry, rootAbs: string, relPath: string | undefined): void {
  const action = noteWatchEvent(entry.coalesce, relPath);
  if (action === "flush") {
    flushEntry(entry, rootAbs);
    return;
  }
  if (action === "arm") {
    entry.flushTimer = setTimeout(() => flushEntry(entry, rootAbs), COALESCE_MS);
  }
}

function handleDirEvent(entry: WatchEntry, rootAbs: string, dirAbs: string, filename: string | null): void {
  const relDir = toPosixRel(relative(rootAbs, dirAbs));
  const relPath = filename ? (relDir ? `${relDir}/${filename}` : filename) : relDir || undefined;

  // A new child directory is NOT auto-watched. The card only sees it
  // after expand, and `setWatchedDirs` registers the watch then. Auto-
  // descending here would undo the "only what is shown" budget — a
  // `git checkout` creating a tree of folders under an expanded dir
  // would re-grow the watch set toward the old walk-everything cost.
  if (relPath && pathHasIgnoredSegment(relPath)) return;
  scheduleChangeNotify(entry, rootAbs, relPath);
}

function closeDirWatcher(entry: WatchEntry, abs: string): void {
  const watcher = entry.dirWatchers.get(abs);
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    // already closed
  }
  entry.dirWatchers.delete(abs);
}

function watchOneDir(entry: WatchEntry, rootAbs: string, dirAbs: string): void {
  if (entry.disposed || entry.dirWatchers.has(dirAbs)) return;
  let watcher: FSWatcher;
  try {
    watcher = watch(dirAbs, { recursive: false }, (_eventType, filename) => {
      handleDirEvent(entry, rootAbs, dirAbs, filename);
    });
  } catch {
    return;
  }
  if (entry.disposed) {
    try {
      watcher.close();
    } catch {
      // already closed
    }
    return;
  }
  watcher.on("error", () => {
    entry.dirWatchers.delete(dirAbs);
  });
  entry.dirWatchers.set(dirAbs, watcher);
}

function syncDirWatchers(entry: WatchEntry, rootAbs: string): void {
  const wantedAbs = new Set<string>();
  for (const rel of unionClientDirs(entry)) {
    wantedAbs.add(rel ? join(rootAbs, rel) : rootAbs);
  }
  for (const abs of [...entry.dirWatchers.keys()]) {
    if (!wantedAbs.has(abs)) closeDirWatcher(entry, abs);
  }
  for (const abs of wantedAbs) {
    watchOneDir(entry, rootAbs, abs);
  }
}

function disposeEntry(entry: WatchEntry): void {
  entry.disposed = true;
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  for (const abs of [...entry.dirWatchers.keys()]) {
    closeDirWatcher(entry, abs);
  }
  entry.clients.clear();
}

export async function startWatching(root: string, clientId: string): Promise<void> {
  const normRoot = resolve(root);
  const entry = getOrCreateEntry(normRoot);
  if (!entry.clients.has(clientId)) {
    entry.clients.set(clientId, { dirs: new Set([""]) });
  }
  syncDirWatchers(entry, normRoot);
}

export function setWatchedDirs(root: string, clientId: string, dirs: string[]): void {
  const normRoot = resolve(root);
  const entry = getOrCreateEntry(normRoot);
  entry.clients.set(clientId, { dirs: clientDirSet(dirs) });
  syncDirWatchers(entry, normRoot);
}

export function stopWatching(root: string, clientId: string): void {
  const normRoot = resolve(root);
  const entry = watchers.get(normRoot);
  if (!entry) return;
  entry.clients.delete(clientId);
  if (entry.clients.size === 0) {
    disposeEntry(entry);
    watchers.delete(normRoot);
    return;
  }
  syncDirWatchers(entry, normRoot);
}

export function stopAllWatchers(): void {
  for (const [root, entry] of watchers) {
    disposeEntry(entry);
    watchers.delete(root);
  }
}

export type WatchStats = {
  roots: number;
  clients: number;
  dirWatchers: number;
};

export function getWatchStats(): WatchStats {
  let clients = 0;
  let dirWatchers = 0;
  for (const entry of watchers.values()) {
    clients += entry.clients.size;
    dirWatchers += entry.dirWatchers.size;
  }
  return { roots: watchers.size, clients, dirWatchers };
}
