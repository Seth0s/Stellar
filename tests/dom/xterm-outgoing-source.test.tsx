/**
 * Empirical lock for the third "any byte lights the bar" incarnation:
 * xterm `onData` is not a keystroke. Writing DSR / CPR queries makes
 * the emulator reply on `onData` with no `onKey`. The activity bar
 * must use that public split (`xtermOutgoingOpensTurn`), never the
 * payload (a content heuristic would miss the next reply sequence).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Terminal } from "@xterm/xterm";
import { xtermOutgoingOpensTurn, originForXtermData } from "@renderer/terminal-activity-decision";

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

async function openTerm() {
  const host = document.createElement("div");
  host.style.width = "400px";
  host.style.height = "200px";
  document.body.appendChild(host);
  const term = new Terminal({ cols: 40, rows: 10 });
  const data: string[] = [];
  const keys: string[] = [];
  term.onData((d) => data.push(d));
  term.onKey(({ key }) => keys.push(key));
  term.open(host);
  await new Promise((r) => setTimeout(r, 20));
  return {
    term,
    data,
    keys,
    cleanup: () => {
      term.dispose();
      host.remove();
    },
  };
}

function isAutomaticReply(chunk: string): boolean {
  // Observed xterm replies, not the classifier — the classifier is
  // `onKey` vs `onData`, locked by the tests below.
  return /^\x1b\[\d+(;\d+)?[nR]$/.test(chunk) || /^\x1b\[\?\d+[;0-9]*c$/.test(chunk);
}

describe("xterm outgoing source — onData não é tecla", () => {
  it("DSR (CSI 5n) e CPR (CSI 6n) emitem onData e não onKey", async () => {
    const { term, data, keys, cleanup } = await openTerm();
    term.write("\x1b[5n");
    term.write("\x1b[6n");
    await new Promise((r) => setTimeout(r, 30));

    expect(keys).toEqual([]);
    expect(data.length).toBeGreaterThan(0);
    expect(data.some(isAutomaticReply)).toBe(true);
    expect(xtermOutgoingOpensTurn("auto")).toBe(false);
    // Gate classifier: no onKey ⇒ every chunk is "auto", never "human".
    for (const chunk of data) {
      expect(originForXtermData(false)).toBe("auto");
      void chunk;
    }
    cleanup();
  });

  it("tecla real emite onKey; isso é o que abre o turno", async () => {
    const { term, keys, cleanup } = await openTerm();
    const ta = term.textarea;
    expect(ta).toBeTruthy();
    ta!.focus();
    ta!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        keyCode: 65,
        which: 65,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(keys.length).toBeGreaterThan(0);
    expect(xtermOutgoingOpensTurn("key")).toBe(true);
    expect(originForXtermData(true)).toBe("human");
    cleanup();
  });

  it("porteiro: latch onKey→onData é human; onData sozinho é auto", async () => {
    const { term, cleanup } = await openTerm();
    const origins: Array<"human" | "auto"> = [];
    let pending = false;
    term.onKey(() => {
      pending = true;
    });
    term.onData(() => {
      origins.push(originForXtermData(pending));
      pending = false;
    });
    term.write("\x1b[6n");
    await new Promise((r) => setTimeout(r, 30));
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.every((o) => o === "auto")).toBe(true);

    origins.length = 0;
    const ta = term.textarea!;
    ta.focus();
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        keyCode: 88,
        which: 88,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(origins.some((o) => o === "human")).toBe(true);
    cleanup();
  });
});
