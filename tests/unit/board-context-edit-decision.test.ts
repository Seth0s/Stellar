import { describe, it, expect } from "vitest";
import {
  applyGateToolPaths,
  applyRulesText,
  entriesFromRulesText,
  rulesTextFromEntries,
} from "../../src/main/board-context-edit-decision";
import type { BoardContext } from "../../src/main/board-context";

describe("board-context-edit-decision", () => {
  it("round-trips rules text with list markers stripped", () => {
    const entries = entriesFromRulesText("- one\n* two\nthree\n\n", 1, "human");
    expect(entries.map((e) => e.text)).toEqual(["one", "two", "three"]);
    expect(rulesTextFromEntries(entries)).toBe("one\ntwo\nthree");
  });

  it("applyRulesText replaces rules and keeps traps/paths", () => {
    const prev: BoardContext = {
      rules: [{ text: "old", at: 0 }],
      traps: [{ text: "trap", at: 0 }],
      gateToolPaths: ["/tools"],
    };
    const next = applyRulesText(prev, "new rule", 9);
    expect(next.rules).toEqual([{ text: "new rule", at: 9, addedBy: "human" }]);
    expect(next.traps).toEqual(prev.traps);
    expect(next.gateToolPaths).toEqual(["/tools"]);
  });

  it("applyGateToolPaths de-duplicates and drops empty list", () => {
    const base: BoardContext = { rules: [], traps: [], gateToolPaths: ["/a"] };
    expect(applyGateToolPaths(base, [" /b ", "/b", ""]).gateToolPaths).toEqual(["/b"]);
    expect(applyGateToolPaths(base, ["", "  "]).gateToolPaths).toBeUndefined();
  });
});
