import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELAUNCH_TRACE_FILE,
  appendRelaunchTrace,
  formatRelaunchTraceLine,
  startedBySwitch,
  trimTrace,
} from "../../src/main/profile-relaunch-trace";

const input = { step: "booted" as const, pid: 10, ppid: 1, profileId: "p1", nowMs: Date.UTC(2026, 0, 2, 3, 4, 5) };

describe("relaunch trace", () => {
  it("writes one JSON line with the step, the pids, the profile and an ISO clock", () => {
    expect(JSON.parse(formatRelaunchTraceLine(input))).toEqual({ at: "2026-01-02T03:04:05.000Z", step: "booted", pid: 10, ppid: 1, profile: "p1" });
  });

  it("only a process started by a switch (--profile=) traces", () => {
    expect(startedBySwitch(["--profile=abc"])).toBe(true);
    expect(startedBySwitch(["--profile", "abc"])).toBe(true);
    expect(startedBySwitch(["--no-sandbox"])).toBe(false);
  });

  it("appends in order and keeps only the newest half past the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "relaunch-trace-"));
    try {
      appendRelaunchTrace(dir, { ...input, step: "switching" });
      appendRelaunchTrace(dir, { ...input, step: "booted" });
      appendRelaunchTrace(dir, { ...input, step: "window" });
      const steps = readFileSync(join(dir, RELAUNCH_TRACE_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l).step);
      expect(steps).toEqual(["switching", "booted", "window"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const text = ["a", "b", "c", "d"].map((s) => s.repeat(40)).join("\n") + "\n";
    const trimmed = trimTrace(text, 100);
    expect(trimmed.trim().split("\n")).toEqual(["c".repeat(40), "d".repeat(40)]);
    expect(trimTrace("short\n", 100)).toBe("short\n");
  });

  it("never throws, even when the directory does not exist", () => {
    expect(() => appendRelaunchTrace("/nonexistent/dir/for/trace", input)).not.toThrow();
  });
});
