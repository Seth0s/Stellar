import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { replayGeometry } from "../../src/renderer/src/terminal-replay";

/**
 * A reattached xterm must replay the main ring at the PTY's size. The ring is raw,
 * cursor-addressed output; at the 80x24 default every address clamps to column 80.
 */
const FALLBACK = { cols: 80, rows: 24 };

describe("replayGeometry", () => {
  it("uses the geometry the main process returned with the ring", () => {
    expect(replayGeometry({ cols: 148, rows: 41 }, FALLBACK)).toEqual({ cols: 148, rows: 41 });
  });
  it("falls back when there is no replay or no geometry (never a guess)", () => {
    expect(replayGeometry(null, FALLBACK)).toEqual(FALLBACK);
    expect(replayGeometry(undefined, FALLBACK)).toEqual(FALLBACK);
    expect(replayGeometry({}, FALLBACK)).toEqual(FALLBACK);
    expect(replayGeometry({ cols: 148 }, FALLBACK)).toEqual(FALLBACK);
  });
  it("treats non-integers, zero, negatives and absurd sizes as absent", () => {
    for (const bad of [0, 1, -5, 1.5, 100000, Number.NaN, Number.POSITIVE_INFINITY, "148", null]) {
      expect(replayGeometry({ cols: bad, rows: 24 }, FALLBACK)).toEqual(FALLBACK);
    }
    expect(replayGeometry({ cols: 148, rows: 0 }, FALLBACK)).toEqual(FALLBACK);
    expect(replayGeometry({ cols: 148, rows: 100000 }, FALLBACK)).toEqual(FALLBACK);
  });
});

function lineOf(term: Terminal, needle: string): { text: string; col: number } | null {
  const buf = term.buffer.active;
  for (let y = 0; y < buf.length; y++) {
    const text = buf.getLine(y)?.translateToString(true) ?? "";
    const col = text.indexOf(needle);
    if (col !== -1) return { text, col };
  }
  return null;
}
const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

describe("why the geometry matters (the premise, on a real xterm)", () => {
  // A TUI row addressed to column 134: ESC[134G then the marker.
  const RING = "\x1b[31mhistory\x1b[0m\r\n\x1b[134GBOX000500\r\n";

  it("replayed at the PTY's 148 columns, the marker sits at column 134", async () => {
    const term = new Terminal({ cols: 148, rows: 41, allowProposedApi: true });
    await write(term, RING);
    expect(lineOf(term, "BOX000500")?.col).toBe(133);
    term.dispose();
  });

  it("replayed at the 80x24 default, the same address is clamped to the last column and the marker wraps — the deformation", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await write(term, RING);
    // No row carries the whole marker at column 134 any more: it starts in column 80
    // and spills onto the next row.
    expect(lineOf(term, "BOX000500")).toBeNull();
    expect(lineOf(term, "B")?.col).toBe(79);
    term.dispose();
  });
});
