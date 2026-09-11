import { watch, type FSWatcher, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { BrowserWindow } from "electron";

type WatchEntry = {
  refCount: number;
  // One non-recursive fs.watch per directory we actually watch, keyed by
  // absolute path. DESIGN-BACKLOG.md §0 ("Abrir o explorador de arquivos
  // quase derruba o app"): `watch(root, { recursive: true })` on Linux
  // walks the ENTIRE tree and registers an inotify watch per directory
  // synchronously before returning — measured 6.3s against the user's
  // real `/home/lucas/Workplace/Projects` cwd (49727 dirs). This entry
  // shape replaces that with our own walk that prunes `node_modules`/
  // `.git`/etc BEFORE registering anything, so the ignored subtrees
  // never get an inotify watch at all (down to ~304ms, ~9648 dirs
  // actually watched — measured via `startWatching` itself, same root).
  dirWatchers: Map<string, FSWatcher>;
  debounceTimer: NodeJS.Timeout | null;
  lastChangedPath?: string;
  // Set by stopWatching/stopAllWatchers. The tree walk in watchDirRecursive
  // is async (yields on every readdir), so a stop can land while a walk
  // for the same root is still in flight; this flag makes any watcher
  // registered after that point get closed immediately instead of leaking
  // past the entry's own removal from `watchers`.
  disposed: boolean;
};

const watchers = new Map<string, WatchEntry>();

// Directory names pruned from the watch tree entirely: never descended
// into, never registered with inotify. Single source of truth for both
// the entry-time prune decision (`isIgnoredDirName`, exact match — see
// its own doc comment for why) and the event-time IPC filter
// (`shouldIgnore`, prefix/substring match, unchanged from before this
// fix) below. Two independently-maintained ignore lists is exactly the
// kind of drift this repo already paid for once (the shortcuts overlay
// that fell out of sync with the real registry) — don't repeat it here.
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
const IGNORE_SUBSTRINGS = IGNORE_DIR_NAMES.map((name) => `${sep}${name}${sep}`);

/**
 * Entry-time prune decision: should a directory with this NAME be skipped
 * when walking the tree to decide what to watch? Pure and exact-match on
 * purpose — unlike `shouldIgnore` below (which only filters which already-
 * fired events get forwarded over IPC, so a loose prefix match there just
 * means one extra swallowed event), being loose HERE would stop us from
 * ever watching a real directory like `distribution/` just because it
 * starts with "dist". Exported for its own unit test.
 */
export function isIgnoredDirName(name: string): boolean {
  return IGNORE_DIR_NAME_SET.has(name);
}

// Event-time IPC filter — unchanged behavior from before this fix, just
// reading from the shared IGNORE_DIR_NAMES list instead of a hardcoded
// duplicate. `filename` is root-relative (stitched together in
// handleDirEvent below from the per-directory watch's own dir-relative
// filename, since plain `fs.watch` without `recursive` only ever reports
// a name relative to the watched directory itself).
function shouldIgnore(filename: string | null): boolean {
  if (!filename) return false;
  const normalized = sep + filename + sep;
  for (const pattern of IGNORE_SUBSTRINGS) {
    if (normalized.includes(pattern)) return true;
  }
  for (const name of IGNORE_DIR_NAMES) {
    if (filename.startsWith(name)) return true;
  }
  return false;
}

function scheduleChangeNotify(entry: WatchEntry, rootAbs: string, relPath: string | undefined): void {
  entry.lastChangedPath = relPath;
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
  }
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    const changedPath = entry.lastChangedPath;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("fs:changed", { root: rootAbs, path: changedPath });
      }
    }
  }, 150);
}

function handleDirEvent(entry: WatchEntry, rootAbs: string, dirAbs: string, filename: string | null): void {
  const relDir = relative(rootAbs, dirAbs);
  const relPath = filename ? (relDir ? `${relDir}${sep}${filename}` : filename) : relDir || undefined;

  if (!shouldIgnore(relPath ?? null)) {
    scheduleChangeNotify(entry, rootAbs, relPath);
  }

  // Best-effort: a plain (non-recursive) watch on `dirAbs` never picks up
  // grandchildren on its own, so a freshly created subdirectory needs its
  // own watch registered explicitly — otherwise files added inside it
  // later would go unnoticed. Skipped for ignored names so a `git clone`
  // or `npm install` landing a fresh `node_modules`/`.git` right under a
  // watched directory doesn't undo the pruning this fix exists for.
  if (filename && !entry.disposed && !isIgnoredDirName(filename) && !entry.dirWatchers.has(join(dirAbs, filename))) {
    const childAbs = join(dirAbs, filename);
    stat(childAbs)
      .then((s) => {
        if (s.isDirectory()) return watchDirRecursive(entry, rootAbs, childAbs);
        return undefined;
      })
      .catch(() => {
        // Gone already (rename event for a delete, or a race) — nothing to watch.
      });
  }
}

async function watchDirRecursive(entry: WatchEntry, rootAbs: string, dirAbs: string): Promise<void> {
  if (entry.disposed || entry.dirWatchers.has(dirAbs)) return;

  let watcher: FSWatcher;
  try {
    watcher = watch(dirAbs, { recursive: false }, (_eventType, filename) => {
      handleDirEvent(entry, rootAbs, dirAbs, filename);
    });
  } catch {
    return; // e.g. permission denied, or removed between readdir and watch
  }

  if (entry.disposed) {
    try {
      watcher.close();
    } catch {
      // Ignore already closed watcher
    }
    return;
  }

  watcher.on("error", () => {
    // Directory most likely removed out from under us. Drop our
    // reference so a later create at the same path can re-register
    // cleanly instead of finding a stale entry in the map.
    entry.dirWatchers.delete(dirAbs);
  });
  entry.dirWatchers.set(dirAbs, watcher);

  let children: Dirent[];
  try {
    children = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  if (entry.disposed) return;

  const subdirs = children.filter((c) => c.isDirectory() && !isIgnoredDirName(c.name));
  await Promise.all(subdirs.map((c) => watchDirRecursive(entry, rootAbs, join(dirAbs, c.name))));
}

export async function startWatching(root: string): Promise<void> {
  const normRoot = resolve(root);
  const existing = watchers.get(normRoot);
  if (existing) {
    existing.refCount++;
    return;
  }

  const entry: WatchEntry = {
    refCount: 1,
    dirWatchers: new Map(),
    debounceTimer: null,
    disposed: false,
  };
  // Set before the (async) walk starts so a concurrent startWatching call
  // for the same root sees this entry and just bumps refCount, same as
  // the synchronous version did.
  watchers.set(normRoot, entry);

  try {
    await watchDirRecursive(entry, normRoot, normRoot);
  } catch (err) {
    console.warn(`[file-watcher] Failed to start watch for ${normRoot}:`, err);
  }

  if (entry.dirWatchers.size === 0) {
    // Root itself couldn't be watched at all (removed, permission denied,
    // bad path) — don't leave a dead, ref-counted entry around forever.
    watchers.delete(normRoot);
  }
}

export function stopWatching(root: string): void {
  const normRoot = resolve(root);
  const existing = watchers.get(normRoot);
  if (!existing) return;

  existing.refCount--;
  if (existing.refCount <= 0) {
    existing.disposed = true;
    if (existing.debounceTimer) {
      clearTimeout(existing.debounceTimer);
    }
    for (const watcher of existing.dirWatchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore already closed watcher
      }
    }
    watchers.delete(normRoot);
  }
}

export function stopAllWatchers(): void {
  for (const entry of watchers.values()) {
    entry.disposed = true;
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    for (const watcher of entry.dirWatchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore
      }
    }
  }
  watchers.clear();
}
