import { describe, it, expect } from "vitest";
import { providerHasRealTurnSignal, TURN_END_PATTERNS } from "../../src/renderer/src/terminal-turn-signal";

describe("providerHasRealTurnSignal — what can close a turn today", () => {
  it("claude has a real Stop hook, not a regex", () => {
    expect(providerHasRealTurnSignal("claude")).toBe(true);
    expect(TURN_END_PATTERNS.claude).toBeUndefined();
  });

  it("codex closes on the photographed 'Worked for …s' line", () => {
    expect(providerHasRealTurnSignal("codex")).toBe(true);
    expect(TURN_END_PATTERNS.codex?.test("Worked for 1m 06s")).toBe(true);
  });

  it("cursor has start vocabulary in providers.ts, but no end marker here", () => {
    expect(providerHasRealTurnSignal("cursor")).toBe(false);
    expect(TURN_END_PATTERNS.cursor).toBeUndefined();
  });

  it("antigravity, opencode and bash also close only by silence / exit / interrupt", () => {
    for (const id of ["antigravity", "opencode", "bash"]) {
      expect(providerHasRealTurnSignal(id)).toBe(false);
    }
  });
});
