/**
 * Layout helpers for the detail modal's observed-diff block — the file list
 * the gate output belongs to. Pure: no React, no I/O.
 *
 * The list can be long (a real window showed 163 files). Grouping by folder
 * only past a threshold keeps the common case flat and scannable, and the
 * folder label lets the row drop to the file name, so the path truncates far
 * less often.
 */

import type { TaskDiffFileView } from "./task-diff-presentation";

/** At or above this many files the folder labels earn their own line. */
export const DIFF_GROUP_THRESHOLD = 20;

/** A row: the file plus the name to show when its folder is a group label. */
export type DiffRow = TaskDiffFileView & { name: string };

export type DiffGroup = { folder: string; rows: DiffRow[] };

function baseName(path: string): { folder: string; name: string } {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? { folder: path.slice(0, idx), name: path.slice(idx + 1) } : { folder: "", name: path };
}

/**
 * Group the files by folder when there are `threshold` or more; `null` means
 * "render the flat list". Group order follows first appearance, and each
 * folder keeps its rows in the original order — the caller never re-sorts.
 */
export function groupDiffFiles(
  files: readonly TaskDiffFileView[],
  threshold: number = DIFF_GROUP_THRESHOLD,
): DiffGroup[] | null {
  if (files.length < threshold) return null;
  const byFolder = new Map<string, DiffRow[]>();
  for (const file of files) {
    const { folder, name } = baseName(file.path);
    const rows = byFolder.get(folder) ?? [];
    rows.push({ ...file, name });
    byFolder.set(folder, rows);
  }
  return [...byFolder.entries()].map(([folder, rows]) => ({ folder, rows }));
}
