import { describe, expect, it } from "vitest";
import {
  decideTerritoryEditWarn,
  pathInTerritory,
} from "../../src/renderer/src/code-territory-warn-decision";

describe("pathInTerritory", () => {
  it("matches exact, prefix, and simple globs", () => {
    expect(pathInTerritory("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathInTerritory("src/a/b.ts", "src/a")).toBe(true);
    expect(pathInTerritory("src/a/b.ts", "src/a/**")).toBe(true);
    expect(pathInTerritory("useTerminal.ts", "useTerminal.ts")).toBe(true);
    expect(pathInTerritory("terminal-render.ts", "terminal-render*.ts")).toBe(true);
    expect(pathInTerritory("other.ts", "useTerminal.ts")).toBe(false);
  });
});

describe("decideTerritoryEditWarn", () => {
  it("allows when no running agent covers the path", () => {
    expect(
      decideTerritoryEditWarn("src/x.ts", [
        { cardId: "1", label: "idle", territory: ["src/x.ts"], running: false },
        { cardId: "2", label: "other", territory: ["docs/**"], running: true },
      ]),
    ).toEqual({ action: "allow" });
  });

  it("warns naming every running agent that covers the file", () => {
    expect(
      decideTerritoryEditWarn("useTerminal.ts", [
        { cardId: "a", label: "IMPL · Claude", territory: ["useTerminal.ts", "terminal-render*.ts"], running: true },
        { cardId: "b", label: "REVISOR", territory: ["message-bus.ts"], running: true },
      ]),
    ).toEqual({
      action: "warn",
      agents: [{ cardId: "a", label: "IMPL · Claude" }],
    });
  });
});
