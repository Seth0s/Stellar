import { describe, it, expect } from "vitest";
import {
  decideSpawnReason,
  describeMissingSpawnReason,
  deriveSpawnDepth,
} from "../../src/main/spawn-record-decision";

describe("spawn-record-decision", () => {
  it("refuses agent spawn without reason, naming the field", () => {
    const d = decideSpawnReason({ requesterId: "card-1", reason: undefined });
    expect(d).toEqual({ action: "refuse", error: describeMissingSpawnReason() });
    expect(d.action === "refuse" && d.error).toMatch(/reason/);
  });

  it("refuses whitespace-only reason for an agent", () => {
    const d = decideSpawnReason({ requesterId: "card-1", reason: "   " });
    expect(d.action).toBe("refuse");
  });

  it("accepts agent spawn with trimmed reason", () => {
    const d = decideSpawnReason({ requesterId: "card-1", reason: "  measure x  " });
    expect(d).toEqual({ action: "accept", reason: "measure x", origin: "agent" });
  });

  it("accepts empty-requester (system) without reason", () => {
    const d = decideSpawnReason({ requesterId: "", reason: undefined });
    expect(d).toEqual({ action: "accept", reason: null, origin: "system" });
  });

  it("deriveSpawnDepth walks the chain and stops at human root", () => {
    const rows: Record<string, { from_card_id: string | null }> = {
      a1: { from_card_id: "root" },
      a2: { from_card_id: "a1" },
      a3: { from_card_id: "a2" },
      root: { from_card_id: null },
    };
    const parentOf = (id: string) => rows[id];
    expect(deriveSpawnDepth("a3", parentOf)).toBe(3);
    expect(deriveSpawnDepth("root", parentOf)).toBe(0);
  });
});
