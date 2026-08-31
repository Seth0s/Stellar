import { watch, type FSWatcher } from "node:fs";
import { resolve, sep } from "node:path";
import { BrowserWindow } from "electron";

type WatchEntry = {
  refCount: number;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
  lastChangedPath?: string;
};

const watchers = new Map<string, WatchEntry>();

// Directories to ignore in recursive watch events
const IGNORE_SUBSTRINGS = [
  `${sep}node_modules${sep}`,
  `${sep}.git${sep}`,
  `${sep}dist${sep}`,
  `${sep}target${sep}`,
  `${sep}.verify-tmp${sep}`,
  `${sep}build${sep}`,
  `${sep}out${sep}`,
  `${sep}.cache${sep}`,
];

function shouldIgnore(filename: string | null): boolean {
  if (!filename) return false;
  const normalized = sep + filename + sep;
  for (const pattern of IGNORE_SUBSTRINGS) {
    if (normalized.includes(pattern)) return true;
  }
  // Check start of relative filename
  if (
    filename.startsWith("node_modules") ||
    filename.startsWith(".git") ||
    filename.startsWith("dist") ||
    filename.startsWith("target") ||
    filename.startsWith(".verify-tmp") ||
    filename.startsWith("build") ||
    filename.startsWith("out") ||
    filename.startsWith(".cache")
  ) {
    return true;
  }
  return false;
}

export function startWatching(root: string): void {
  const normRoot = resolve(root);
  const existing = watchers.get(normRoot);
  if (existing) {
    existing.refCount++;
    return;
  }

  try {
    const watcher = watch(normRoot, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnore(filename)) return;

      const entry = watchers.get(normRoot);
      if (!entry) return;

      entry.lastChangedPath = filename || undefined;

      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
      }

      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        const changedPath = entry.lastChangedPath;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send("fs:changed", { root: normRoot, path: changedPath });
          }
        }
      }, 150);
    });

    watcher.on("error", (err) => {
      console.warn(`[file-watcher] Error watching ${normRoot}:`, err);
    });

    watchers.set(normRoot, {
      refCount: 1,
      watcher,
      debounceTimer: null,
    });
  } catch (err) {
    console.warn(`[file-watcher] Failed to start watch for ${normRoot}:`, err);
  }
}

export function stopWatching(root: string): void {
  const normRoot = resolve(root);
  const existing = watchers.get(normRoot);
  if (!existing) return;

  existing.refCount--;
  if (existing.refCount <= 0) {
    if (existing.debounceTimer) {
      clearTimeout(existing.debounceTimer);
    }
    try {
      existing.watcher.close();
    } catch {
      // Ignore already closed watcher
    }
    watchers.delete(normRoot);
  }
}

export function stopAllWatchers(): void {
  for (const entry of watchers.values()) {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    try {
      entry.watcher.close();
    } catch {
      // Ignore
    }
  }
  watchers.clear();
}
