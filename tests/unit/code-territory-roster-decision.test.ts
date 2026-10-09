import { describe, expect, it } from "vitest";
import {
  decideAgentDotByPath,
  decideTerritoryRoster,
} from "../../src/renderer/src/code-territory-roster-decision";
import { pathInTerritory } from "../../src/renderer/src/code-territory-warn-decision";

describe("decideTerritoryRoster", () => {
  it("keeps only live implementers with declared territory", () => {
    const roster = decideTerritoryRoster([
      {
        id: "t1",
        status: "pending",
        cardAlive: true,
        territory: ["src/renderer/src/useTerminal.ts"],
        cards: [{ cardId: "c1", role: "implementer", label: "IMPL", orphan: false }],
      },
      {
        id: "t2",
        status: "done",
        cardAlive: false,
        territory: ["src/main"],
        cards: [{ cardId: "c2", role: "implementer", label: "OLD", orphan: false }],
      },
    ]);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.cardId).toBe("c1");
    expect(roster[0]?.running).toBe(true);
  });

  it("maps agent dots only for running territory hits", () => {
    const agents = decideTerritoryRoster([
      {
        id: "t1",
        status: "pending",
        cardAlive: true,
        territory: ["src/renderer/**"],
        cards: [{ cardId: "c1", role: "implementer", label: "IMPL", orphan: false }],
      },
    ]);
    const dots = decideAgentDotByPath(
      agents,
      [{ cardId: "c1", color: "#f0883e" }],
      ["src/renderer/src/useTerminal.ts", "docs/ORCHESTRATION.md"],
      pathInTerritory,
    );
    expect(dots["src/renderer/src/useTerminal.ts"]).toBe("#f0883e");
    expect(dots["docs/ORCHESTRATION.md"]).toBeUndefined();
  });
});
