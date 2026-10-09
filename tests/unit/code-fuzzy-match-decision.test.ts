import { describe, expect, it } from "vitest";
import { decideFuzzyFileHits } from "../../src/renderer/src/code-fuzzy-match-decision";

describe("decideFuzzyFileHits", () => {
  const candidates = [
    { path: "src/renderer/src/useTerminal.ts", name: "useTerminal.ts" },
    { path: "src/main/message-bus.ts", name: "message-bus.ts" },
    { path: "tests/unit/code-fuzzy-match-decision.test.ts", name: "code-fuzzy-match-decision.test.ts" },
  ];

  it("returns empty for blank query", () => {
    expect(decideFuzzyFileHits("  ", candidates)).toEqual([]);
  });

  it("ranks substring name hits first", () => {
    const hits = decideFuzzyFileHits("useTerminal", candidates);
    expect(hits[0]?.path).toBe("src/renderer/src/useTerminal.ts");
  });

  it("matches fuzzy subsequence", () => {
    const hits = decideFuzzyFileHits("uterm", candidates);
    expect(hits.some((h) => h.path.includes("useTerminal"))).toBe(true);
  });
});
