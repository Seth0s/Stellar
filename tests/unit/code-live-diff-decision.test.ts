import { describe, expect, it } from "vitest";
import {
  LIVE_DIFF_MAX_LINES,
  decideBaselineAfterAccept,
  decideFreshHunks,
  decideGhostFolded,
  decideHunkJump,
  decideLineChanges,
  decideLiveDiff,
  decideMarkdownBlockDiff,
  splitMarkdownBlocks,
} from "../../src/renderer/src/code-live-diff-decision";

const lines = (...l: string[]) => l.join("\n");

describe("decideLiveDiff", () => {
  it("equal texts give an empty diff", () => {
    const d = decideLiveDiff("a\nb\n", "a\nb\n");
    expect(d).toEqual({ hunks: [], words: new Map(), added: 0, removed: 0 });
  });

  it("an inserted block is one hunk with no ghost rows", () => {
    const d = decideLiveDiff(lines("a", "b", "c"), lines("a", "x", "y", "b", "c"))!;
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ fromLine: 2, toLine: 3, added: 2, removed: 0, anchorLine: 2 });
    expect(d.hunks[0]!.ghosts).toEqual([]);
    expect(d.added).toBe(2);
  });

  it("a pure removal anchors the ghost rows on the next current line", () => {
    const d = decideLiveDiff(lines("a", "b", "c", "d"), lines("a", "d"))!;
    const h = d.hunks[0]!;
    expect(h).toMatchObject({ fromLine: 2, toLine: 1, anchorLine: 2, oldFrom: 2, added: 0, removed: 2 });
    expect(h.ghosts.map((g) => [g.oldLine, g.text])).toEqual([
      [2, "b"],
      [3, "c"],
    ]);
  });

  it("a removal at the end anchors past the last line", () => {
    const d = decideLiveDiff(lines("a", "b", "c"), lines("a"))!;
    expect(d.hunks[0]).toMatchObject({ anchorLine: 2, removed: 2 });
  });

  it("a changed row pairs ghost and added row and marks the changed word", () => {
    const d = decideLiveDiff(lines("for (x of q.items) {", "y"), lines("for (x of q.pending()) {", "y"))!;
    const h = d.hunks[0]!;
    expect(h).toMatchObject({ added: 1, removed: 1 });
    const [from, to] = h.ghosts[0]!.word!;
    expect(h.ghosts[0]!.text.slice(from, to)).toBe("items");
    const range = d.words.get(1)!;
    expect("for (x of q.pending()) {".slice(range[0], range[1])).toBe("pending()");
  });

  it("a fully rewritten row gets no word range", () => {
    const d = decideLiveDiff("abc", "xyz")!;
    expect(d.hunks[0]!.ghosts[0]!.word).toBeNull();
    expect(d.words.size).toBe(0);
  });

  it("separate edits are separate hunks, in order", () => {
    const d = decideLiveDiff(lines("1", "2", "3", "4", "5", "6"), lines("1", "X", "3", "4", "5", "Y"))!;
    expect(d.hunks.map((h) => h.fromLine)).toEqual([2, 6]);
  });

  it("CRLF in the baseline does not mark every line", () => {
    expect(decideLiveDiff("a\r\nb\r\n", "a\nb\n")!.hunks).toEqual([]);
  });

  it("stays off for a very large file", () => {
    const big = Array.from({ length: LIVE_DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    expect(decideLiveDiff(big, big)).toBeNull();
  });

  it("falls back to one hunk when the middle is too big for the table", () => {
    const a = Array.from({ length: 1600 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 1600 }, (_, i) => `b${i}`).join("\n");
    const d = decideLiveDiff(a, b)!;
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ added: 1600, removed: 1600 });
  });
});

describe("decideFreshHunks", () => {
  it("returns only hunks whose content is new", () => {
    const before = decideLiveDiff("a\nb\nc", "a\nB\nc");
    const after = decideLiveDiff("a\nb\nc", "z\na\nB\nc\nD");
    const fresh = decideFreshHunks(before, after);
    const ids = after!.hunks.map((h) => h.id);
    expect(fresh.size).toBe(2);
    expect(ids.filter((id) => fresh.has(id))).toHaveLength(2);
  });

  it("a hunk that only moved does not pulse again", () => {
    const before = decideLiveDiff("a\nb\nc", "a\nB\nc");
    const after = decideLiveDiff("x\na\nb\nc", "x\nz\na\nB\nc");
    expect(decideFreshHunks(before, after).size).toBe(1);
  });

  it("no diff gives nothing fresh", () => {
    expect(decideFreshHunks(null, null).size).toBe(0);
  });
});

describe("decideBaselineAfterAccept", () => {
  it("accepting the only hunk makes the baseline equal the current text", () => {
    const base = lines("a", "b", "c");
    const cur = lines("a", "X", "Y", "c");
    const hunk = decideLiveDiff(base, cur)!.hunks[0]!;
    expect(decideBaselineAfterAccept(base, cur, hunk)).toBe(cur);
  });

  it("accepting one hunk leaves the other marked", () => {
    const base = lines("1", "2", "3", "4", "5", "6");
    const cur = lines("1", "X", "3", "4", "5", "Y");
    const first = decideLiveDiff(base, cur)!.hunks[0]!;
    const next = decideBaselineAfterAccept(base, cur, first);
    expect(next).toBe(lines("1", "X", "3", "4", "5", "6"));
    expect(decideLiveDiff(next, cur)!.hunks.map((h) => h.fromLine)).toEqual([6]);
  });

  it("accepting a pure removal drops the rows from the baseline", () => {
    const base = lines("a", "b", "c");
    const cur = lines("a", "c");
    const hunk = decideLiveDiff(base, cur)!.hunks[0]!;
    expect(decideBaselineAfterAccept(base, cur, hunk)).toBe(cur);
  });
});

describe("decideGhostFolded / decideHunkJump", () => {
  it("folds a removal of four rows or more until it is expanded", () => {
    expect(decideGhostFolded(3, false)).toBe(false);
    expect(decideGhostFolded(4, false)).toBe(true);
    expect(decideGhostFolded(9, true)).toBe(false);
  });

  it("jumps to the next hunk and wraps", () => {
    const d = decideLiveDiff(lines("1", "2", "3", "4", "5", "6"), lines("1", "X", "3", "4", "5", "Y"))!;
    expect(decideHunkJump(d, 1, 1)!.fromLine).toBe(2);
    expect(decideHunkJump(d, 2, 1)!.fromLine).toBe(6);
    expect(decideHunkJump(d, 6, 1)!.fromLine).toBe(2);
    expect(decideHunkJump(d, 6, -1)!.fromLine).toBe(2);
    expect(decideHunkJump(d, 2, -1)!.fromLine).toBe(6);
    expect(decideHunkJump(null, 1, 1)).toBeNull();
  });
});

describe("markdown blocks", () => {
  it("keeps a fenced block whole across blank lines", () => {
    expect(splitMarkdownBlocks("a\n\n```\nx\n\ny\n```\n\nb")).toEqual(["a", "```\nx\n\ny\n```", "b"]);
  });

  it("marks a replaced paragraph as del then add and a new one as add", () => {
    const base = "# T\n\nold text\n\nkeep";
    const cur = "# T\n\nnew text\n\nkeep\n\nextra";
    const { blocks, changed } = decideMarkdownBlockDiff(base, cur);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["ctx", "# T"],
      ["del", "old text"],
      ["add", "new text"],
      ["ctx", "keep"],
      ["add", "extra"],
    ]);
    expect(changed).toBe(2);
  });

  it("identical text has no changed block", () => {
    expect(decideMarkdownBlockDiff("a\n\nb", "a\n\nb").changed).toBe(0);
  });
});

describe("decideLineChanges", () => {
  const apply = (text: string, changes: Array<{ from: number; to?: number; insert?: string }>) => {
    let out = text;
    // Offsets refer to the old text, so apply from the end.
    for (const c of [...changes].sort((p, q) => q.from - p.from)) {
      out = out.slice(0, c.from) + (c.insert ?? "") + out.slice(c.to ?? c.from);
    }
    return out;
  };
  const cases: Array<[string, string]> = [
    ["a\nb\nc", "a\nX\nc"],
    ["a\nb\nc", "a\nb\nc\nd\ne"],
    ["a\nb\nc", "z\na\nb\nc"],
    ["a\nb\nc", "a"],
    ["a\nb\nc", "c"],
    ["a\nb\nc", "b"],
    ["a\nb\nc", ""],
    ["", "a\nb"],
    ["1\n2\n3\n4\n5\n6\n7", "1\nX\nY\n3\n4\n6\n7\nZ"],
    ["same\n", "same\n"],
  ];
  for (const [a, b] of cases) {
    it(`turns ${JSON.stringify(a)} into ${JSON.stringify(b)}`, () => {
      expect(apply(a, decideLineChanges(a, b))).toBe(b);
    });
  }

  it("makes one edit per changed block, not one over the whole span", () => {
    expect(decideLineChanges("1\n2\n3\n4\n5\n6", "1\nX\n3\n4\n5\nY")).toHaveLength(2);
  });
});
