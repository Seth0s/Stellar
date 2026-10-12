/**
 * Live diff of an open file against its baseline (the text it had when the
 * tab opened, or at the last "accept"). Pure: the card feeds two strings and
 * draws what comes back. No authorship here — the caller pairs hunks with a
 * card only when the app has evidence for it.
 */

export type LiveDiffGhostRow = {
  /** 1-based line number in the baseline. */
  oldLine: number;
  text: string;
  /** Half-open `[from, to)` char range of the part that changed, when the
   * row pairs 1:1 with an added row. */
  word: [number, number] | null;
};

export type LiveDiffHunk = {
  /** Stable while the hunk's content stays the same. */
  id: string;
  /** Added/changed range in the current text (inclusive). `toLine` is
   * `fromLine - 1` for a pure removal. */
  fromLine: number;
  toLine: number;
  /** Current line the ghost rows are drawn before; `lineCount + 1` = the end. */
  anchorLine: number;
  /** 1-based baseline line where the removed range starts. */
  oldFrom: number;
  added: number;
  removed: number;
  ghosts: LiveDiffGhostRow[];
};

export type LiveDiff = {
  hunks: LiveDiffHunk[];
  /** Current line → half-open char range that changed inside a paired row. */
  words: Map<number, [number, number]>;
  added: number;
  removed: number;
};

/** Above this many lines on either side the live diff stays off. */
export const LIVE_DIFF_MAX_LINES = 8000;
/** The LCS table is `n * m` cells; past this a middle section is one hunk. */
const LCS_MAX_CELLS = 2_000_000;
/** A removal this long or longer starts folded. */
export const LIVE_DIFF_FOLD_AT = 4;

type Op = { kind: "eq" | "del" | "add"; a: number; b: number };

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Edit script between two sequences: equal / delete from `a` / add from `b`. */
export function diffSequences(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: "eq", a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || n * m > LCS_MAX_CELLS) {
    for (let i = 0; i < n; i++) ops.push({ kind: "del", a: start + i, b: start });
    for (let j = 0; j < m; j++) ops.push({ kind: "add", a: endA, b: start + j });
  } else {
    // lcs[i][j] = LCS length of a[start+i..] and b[start+j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ kind: "eq", a: start + i, b: start + j });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        ops.push({ kind: "del", a: start + i, b: start + j });
        i++;
      } else {
        ops.push({ kind: "add", a: start + i, b: start + j });
        j++;
      }
    }
    while (i < n) ops.push({ kind: "del", a: start + i++, b: start + m });
    while (j < m) ops.push({ kind: "add", a: start + n, b: start + j++ });
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ kind: "eq", a: endA + k, b: endB + k });
  return ops;
}

/** The slice of `from` and `to` that differs once the shared head and tail
 * are trimmed; `null` when nothing is shared (the whole row changed). */
function changedRange(from: string, to: string): { from: [number, number]; to: [number, number] } | null {
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;
  let tail = 0;
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  )
    tail++;
  if (head === 0 && tail === 0) return null;
  return { from: [head, from.length - tail], to: [head, to.length - tail] };
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * `null` = the live diff is off for this file (too large). Equal texts give
 * an empty diff. Line endings are normalized first, since the editor hands
 * back `\n` whatever the file used.
 */
export function decideLiveDiff(base: string, current: string): LiveDiff | null {
  const a = normalize(base).split("\n");
  const b = normalize(current).split("\n");
  if (a.length > LIVE_DIFF_MAX_LINES || b.length > LIVE_DIFF_MAX_LINES) return null;
  const ops = diffSequences(a, b);
  const hunks: LiveDiffHunk[] = [];
  const words = new Map<number, [number, number]>();
  let added = 0;
  let removed = 0;
  for (let k = 0; k < ops.length; ) {
    if (ops[k]!.kind === "eq") {
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    let next = k;
    while (next < ops.length && ops[next]!.kind !== "eq") {
      const op = ops[next]!;
      if (op.kind === "del") dels.push(op.a);
      else adds.push(op.b);
      next++;
    }
    const ghosts: LiveDiffGhostRow[] = dels.map((idx) => ({ oldLine: idx + 1, text: a[idx]!, word: null }));
    if (dels.length === adds.length) {
      for (let r = 0; r < dels.length; r++) {
        const range = changedRange(a[dels[r]!]!, b[adds[r]!]!);
        if (!range) continue;
        ghosts[r]!.word = range.from;
        if (range.to[1] > range.to[0]) words.set(adds[r]! + 1, range.to);
      }
    }
    const first = ops[k]!;
    const fromLine = adds.length > 0 ? adds[0]! + 1 : first.b + 1;
    const toLine = adds.length > 0 ? adds[adds.length - 1]! + 1 : fromLine - 1;
    const oldFrom = dels.length > 0 ? dels[0]! + 1 : first.a + 1;
    hunks.push({
      id: `${fromLine}:${hash(`${dels.map((i) => a[i]).join("\n")}\u0000${adds.map((i) => b[i]).join("\n")}`)}`,
      fromLine,
      toLine,
      anchorLine: fromLine,
      oldFrom,
      added: adds.length,
      removed: dels.length,
      ghosts,
    });
    added += adds.length;
    removed += dels.length;
    k = next;
  }
  return { hunks, words, added, removed };
}

/**
 * Hunks of `next` whose content was not already a hunk of `prev` — the ones
 * a live write just produced. Keyed by content so a hunk that only moved
 * (lines added above it) does not pulse again.
 */
export function decideFreshHunks(prev: LiveDiff | null, next: LiveDiff | null): Set<string> {
  const out = new Set<string>();
  if (!next) return out;
  const seen = new Set((prev?.hunks ?? []).map((h) => h.id.slice(h.id.indexOf(":") + 1)));
  for (const h of next.hunks) {
    if (!seen.has(h.id.slice(h.id.indexOf(":") + 1))) out.add(h.id);
  }
  return out;
}

/** The baseline with `hunk` accepted: its removed rows replaced by its added rows. */
export function decideBaselineAfterAccept(base: string, current: string, hunk: LiveDiffHunk): string {
  const a = normalize(base).split("\n");
  const b = normalize(current).split("\n");
  const head = a.slice(0, hunk.oldFrom - 1);
  const tail = a.slice(hunk.oldFrom - 1 + hunk.removed);
  return [...head, ...b.slice(hunk.fromLine - 1, hunk.toLine), ...tail].join("\n");
}

/** Whether a removal of `rows` starts folded. */
export function decideGhostFolded(rows: number, expanded: boolean): boolean {
  return rows >= LIVE_DIFF_FOLD_AT && !expanded;
}

/** Next/previous hunk start relative to `line`, wrapping around. */
export function decideHunkJump(diff: LiveDiff | null, line: number, dir: 1 | -1): LiveDiffHunk | null {
  if (!diff || diff.hunks.length === 0) return null;
  const hunks = diff.hunks;
  if (dir === 1) return hunks.find((h) => h.anchorLine > line) ?? hunks[0]!;
  for (let i = hunks.length - 1; i >= 0; i--) if (hunks[i]!.anchorLine < line) return hunks[i]!;
  return hunks[hunks.length - 1]!;
}

/** Markdown block diff for the reading view. */
export type MarkdownBlockKind = "ctx" | "add" | "del";
export type MarkdownBlock = { kind: MarkdownBlockKind; text: string; hunkId: string | null };

/** Splits on blank lines, keeping fenced code (which may hold blank lines) whole. */
export function splitMarkdownBlocks(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (cur.length > 0) out.push(cur.join("\n"));
    cur = [];
  };
  for (const line of normalize(text).split("\n")) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence === null && f) fence = f[1]![0]!;
    else if (fence !== null && f && f[1]![0] === fence) fence = null;
    if (fence === null && line.trim() === "" && !f) flush();
    else cur.push(line);
  }
  flush();
  return out;
}

export function decideMarkdownBlockDiff(base: string, current: string): { blocks: MarkdownBlock[]; changed: number } {
  const a = splitMarkdownBlocks(base);
  const b = splitMarkdownBlocks(current);
  const ops = diffSequences(a, b);
  const blocks: MarkdownBlock[] = [];
  let changed = 0;
  for (let k = 0; k < ops.length; ) {
    const op = ops[k]!;
    if (op.kind === "eq") {
      blocks.push({ kind: "ctx", text: b[op.b]!, hunkId: null });
      k++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    let next = k;
    while (next < ops.length && ops[next]!.kind !== "eq") {
      const o = ops[next]!;
      if (o.kind === "del") dels.push(a[o.a]!);
      else adds.push(b[o.b]!);
      next++;
    }
    const id = `md:${hash(`${dels.join("\n\n")}\u0000${adds.join("\n\n")}`)}`;
    for (const text of dels) blocks.push({ kind: "del", text, hunkId: id });
    for (const text of adds) blocks.push({ kind: "add", text, hunkId: id });
    changed += Math.max(dels.length, adds.length);
    k = next;
  }
  return { blocks, changed };
}

/** A replace over the old text: `[from, to)` becomes `insert`. */
export type TextChange = { from: number; to?: number; insert?: string };

/**
 * Per-hunk edits turning `a` into `b`. One edit per changed block keeps
 * CodeMirror's scroll anchor and cursor mapping working; a single replace
 * spanning the viewport would throw the scroll position away.
 */
export function decideLineChanges(a: string, b: string): TextChange[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of al) {
    starts.push(at);
    at += line.length + 1;
  }
  const endOf = (i: number) => starts[i]! + al[i]!.length;
  const ops = diffSequences(al, bl);
  const changes: TextChange[] = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k]!.kind === "eq") {
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: string[] = [];
    const firstA = ops[k]!.a;
    while (k < ops.length && ops[k]!.kind !== "eq") {
      const op = ops[k]!;
      if (op.kind === "del") dels.push(op.a);
      else adds.push(bl[op.b]!);
      k++;
    }
    if (dels.length > 0 && adds.length > 0) {
      changes.push({ from: starts[dels[0]!]!, to: endOf(dels[dels.length - 1]!), insert: adds.join("\n") });
    } else if (dels.length > 0) {
      const d0 = dels[0]!;
      const d1 = dels[dels.length - 1]!;
      if (d0 > 0) changes.push({ from: starts[d0]! - 1, to: endOf(d1) });
      else changes.push({ from: 0, to: Math.min(endOf(d1) + 1, a.length) });
    } else if (firstA < al.length) {
      changes.push({ from: starts[firstA]!, insert: `${adds.join("\n")}\n` });
    } else {
      changes.push({ from: a.length, insert: `\n${adds.join("\n")}` });
    }
  }
  return changes;
}
