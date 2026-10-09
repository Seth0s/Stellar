/**
 * Parse unified-diff hunk headers for one path into inclusive 1-based
 * line ranges on the NEW (working-tree) side. No authorship claim — the
 * caller pairs ranges with a declared card/task.
 */

export type DiffLineRange = { fromLine: number; toLine: number };

const HUNK = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
const FILE_HEADER = /^\+\+\+\s+(?:b\/)?(.+)$/;

/**
 * Extract added-side ranges for `filePath` from a multi-file unified patch.
 * Paths are compared after stripping a leading `a/`/`b/` or `./`.
 */
export function decideDiffHunkRangesForFile(patch: string, filePath: string): DiffLineRange[] {
  if (!patch || !filePath) return [];
  const want = normalizePath(filePath);
  const ranges: DiffLineRange[] = [];
  let inFile = false;
  for (const raw of patch.split("\n")) {
    const fileHit = raw.match(FILE_HEADER);
    if (fileHit) {
      inFile = normalizePath(fileHit[1]!) === want;
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      inFile = false;
      continue;
    }
    if (!inFile) continue;
    const m = raw.match(HUNK);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isFinite(start) || start < 1 || count <= 0) continue;
    ranges.push({ fromLine: start, toLine: start + count - 1 });
  }
  return ranges;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^[ab]\//, "");
}
