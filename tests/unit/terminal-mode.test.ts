import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  createTerminalModes,
  hasNonDefaultModes,
  modesReplayPrefix,
  trackTerminalModes,
  type TerminalModes,
} from "../../src/main/terminal-mode";
import { appendScrollback, createScrollback, readScrollbackWithModes } from "../../src/main/session-scrollback";

/**
 * The modes a TUI sets are tracked from its raw output so a replay from a ring cut
 * at the front can put a fresh xterm back in them.
 */
const ESC = "\u001b";
const set = (n: number | string) => `${ESC}[?${n}h`;
const reset = (n: number | string) => `${ESC}[?${n}l`;
const track = (text: string, from: TerminalModes = createTerminalModes()) => trackTerminalModes(from, text);

describe("trackTerminalModes", () => {
  it("a fresh terminal is in no tracked mode and replays with an empty prefix", () => {
    expect(hasNonDefaultModes(createTerminalModes())).toBe(false);
    expect(modesReplayPrefix(createTerminalModes())).toBe("");
  });

  it("alternate screen: 1049, 1047 and 47 set it, and their reset clears it", () => {
    for (const n of [1049, 1047, 47]) {
      expect(track(set(n)).altScreen).toBe(true);
      expect(track(set(n) + reset(n)).altScreen).toBe(false);
    }
  });

  it("cursor visibility: ?25l hides it, ?25h shows it again (the default is visible)", () => {
    expect(track(reset(25)).cursorHidden).toBe(true);
    expect(track(reset(25) + set(25)).cursorHidden).toBe(false);
    expect(track("").cursorHidden).toBe(false);
  });

  it("mouse tracking modes, their encodings, focus reports, bracketed paste and application cursor keys", () => {
    const m = track([set(1), set(9), set(1000), set(1002), set(1003), set(1004), set(1005), set(1006), set(1015), set(2004)].join(""));
    expect(m).toMatchObject({
      appCursorKeys: true,
      mouseX10: true,
      mouseNormal: true,
      mouseButton: true,
      mouseAny: true,
      focusReports: true,
      mouseUtf8: true,
      mouseSgr: true,
      mouseUrxvt: true,
      bracketedPaste: true,
    });
    const off = track([reset(1002), reset(1006), reset(2004)].join(""), m);
    expect(off).toMatchObject({ mouseButton: false, mouseSgr: false, bracketedPaste: false, mouseNormal: true });
  });

  it("several parameters in one sequence: ?1000;1006;2004h", () => {
    expect(track(`${ESC}[?1000;1006;2004h`)).toMatchObject({ mouseNormal: true, mouseSgr: true, bracketedPaste: true });
    expect(track(`${ESC}[?1000;1006;2004h${ESC}[?1000;2004l`)).toMatchObject({ mouseNormal: false, mouseSgr: true, bracketedPaste: false });
  });

  it("the LAST word wins and surrounding text is ignored", () => {
    expect(track(`hello ${set(1049)} world ${reset(1049)} again ${set(1049)} tail`).altScreen).toBe(true);
  });

  it("non-private CSI and unknown private modes change nothing", () => {
    expect(hasNonDefaultModes(track(`${ESC}[1049h${ESC}[31m${ESC}[2J${ESC}[?7h${ESC}[?9999h`))).toBe(false);
  });

  it("a sequence split across two chunks is joined, at any split point", () => {
    const seq = set(1049);
    for (let i = 1; i < seq.length; i++) {
      const m = track(seq.slice(i), track(seq.slice(0, i)));
      expect(m.altScreen, `split at ${i}`).toBe(true);
    }
  });

  it("an unfinished tail is carried, and does not leak into the next unrelated chunk", () => {
    const m = track("text" + ESC + "[?10");
    expect(m.pending).toBe(ESC + "[?10");
    expect(track("plain text with no escape", m).pending).toBe("");
    // the carried "ESC[?10" + "49h" is the alternate screen; "ESC[?10" + "x" is not.
    expect(track("49h", m).altScreen).toBe(true);
    expect(track("xyz", m).altScreen).toBe(false);
  });

  it("never mutates the state it is given", () => {
    const before = createTerminalModes();
    track(set(1049) + set(2004), before);
    expect(before).toEqual(createTerminalModes());
  });
});

describe("modesReplayPrefix", () => {
  it("enters the alternate screen first, so what follows lands in it", () => {
    const prefix = modesReplayPrefix(track(set(2004) + reset(25) + set(1049) + set(1006)));
    expect(prefix.startsWith(set(1049))).toBe(true);
    expect(prefix).toContain(set(2004));
    expect(prefix).toContain(set(1006));
    expect(prefix).toContain(reset(25));
  });

  it("replaying the prefix into a REAL xterm puts it in the same modes", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const modes = track([set(1049), set(1), set(1002), set(1006), set(1004), set(2004)].join(""));
    await new Promise<void>((resolve) => term.write(modesReplayPrefix(modes), resolve));
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.applicationCursorKeysMode).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe("drag");
    expect(term.modes.sendFocusMode).toBe(true);
    expect(term.modes.bracketedPasteMode).toBe(true);
    term.dispose();
  });
});

describe("the invariant: a replay from the cut ends in the modes the program left", () => {
  // A program's output: it enters the alternate screen and turns modes on, then repaints
  // for a long time, and may leave the alternate screen and come back.
  const TUI_ENTER = set(1049) + reset(25) + set(1002) + set(1006) + set(2004) + set(1);
  const repaint = (n: number) => Array.from({ length: n }, (_, i) => `${ESC}[${(i % 20) + 1};1HREPAINT${i}`).join("");

  function ringOf(chunks: string[], maxBytes: number) {
    let s = createScrollback();
    for (const c of chunks) s = appendScrollback(s, c, maxBytes);
    return s;
  }
  const finalModes = (text: string) => ({ ...track(text), pending: "" });

  it.each([
    ["entry dropped by the cut", [TUI_ENTER, repaint(400), repaint(400)]],
    ["entry and exit both dropped, then re-entered", [TUI_ENTER, repaint(100), reset(1049) + reset(2004), "shell> ", set(1049) + set(2004), repaint(400)]],
    ["exit retained, entry dropped", [TUI_ENTER, repaint(400), reset(1049) + set(25) + reset(1002) + reset(1006) + reset(2004) + reset(1), "$ "]],
  ])("%s", (_name, chunks) => {
    const full = chunks.join("");
    for (const cap of [200, 1000, 4000]) {
      const ring = ringOf(chunks, cap);
      const replay = readScrollbackWithModes(ring);
      expect(finalModes(replay), `cap ${cap}`).toEqual(finalModes(full));
    }
  });

  it("a ring that was never cut replays byte for byte as before", () => {
    const ring = ringOf([TUI_ENTER, repaint(5)], 1_000_000);
    expect(ring.droppedBytes).toBe(0);
    expect(readScrollbackWithModes(ring)).toBe(TUI_ENTER + repaint(5));
  });

  it("a REAL xterm replaying prefix + retained bytes ends in the alternate buffer with the modes on", async () => {
    const chunks = [TUI_ENTER, repaint(300), repaint(300)];
    const ring = ringOf(chunks, 3000);
    expect(ring.droppedBytes).toBeGreaterThan(0);
    const term = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(readScrollbackWithModes(ring), resolve));
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.mouseTrackingMode).toBe("drag");
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(term.modes.applicationCursorKeysMode).toBe(true);
    term.dispose();

    // The old replay (no prefix) for contrast: the normal buffer, every mode off.
    const old = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
    await new Promise<void>((resolve) => old.write(ring.chunks.join(""), resolve));
    expect(old.buffer.active.type).toBe("normal");
    expect(old.modes.mouseTrackingMode).toBe("none");
    old.dispose();
  });
});
