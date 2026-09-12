import { describe, it, expect } from "vitest";
import {
  COALESCE_MAX,
  createCoalesceState,
  noteWatchEvent,
  takeCoalescedFlush,
} from "../../src/main/file-watcher-coalesce";

// Same shape as pty-registry.ts: first event arms, further events hold,
// COUNT hitting COALESCE_MAX flushes immediately. A npm install / git
// checkout that fires thousands of inotify events must not become
// thousands of IPCs — that's the care the FilesCard task named.
describe("noteWatchEvent", () => {
  it("arms the timer on the first event and holds on the next ones", () => {
    const state = createCoalesceState();
    expect(noteWatchEvent(state, "src/a.ts")).toBe("arm");
    expect(noteWatchEvent(state, "src/b.ts")).toBe("hold");
    expect(noteWatchEvent(state, "src/c.ts")).toBe("hold");
    expect(state.pending).toBe(3);
    expect([...state.paths]).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("flushes immediately once COALESCE_MAX events have accumulated, even mid-burst", () => {
    const state = createCoalesceState();
    expect(noteWatchEvent(state, "first")).toBe("arm");
    for (let i = 1; i < COALESCE_MAX - 1; i++) {
      expect(noteWatchEvent(state, `f${i}`)).toBe("hold");
    }
    expect(noteWatchEvent(state, "overflow")).toBe("flush");
    expect(state.pending).toBe(COALESCE_MAX);
  });

  it("dedupes the same path so a file written in a tight loop is still one entry", () => {
    const state = createCoalesceState();
    noteWatchEvent(state, "src/a.ts");
    noteWatchEvent(state, "src/a.ts");
    noteWatchEvent(state, "src/a.ts");
    expect(state.paths.size).toBe(1);
    expect(state.pending).toBe(3);
  });
});

describe("takeCoalescedFlush", () => {
  it("hands back the accumulated paths and resets so the next burst starts clean", () => {
    const state = createCoalesceState();
    noteWatchEvent(state, "a");
    noteWatchEvent(state, "b");
    const flushed = takeCoalescedFlush(state);
    expect(flushed.pending).toBe(2);
    expect(flushed.paths.sort()).toEqual(["a", "b"]);
    expect(state.pending).toBe(0);
    expect(state.paths.size).toBe(0);
    expect(state.timerArmed).toBe(false);
    expect(noteWatchEvent(state, "c")).toBe("arm");
  });
});
