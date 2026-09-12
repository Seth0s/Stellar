import { describe, it, expect } from "vitest";
import {
  BASH_CARD_DISCOVERY_TIP,
  decideBashCardDiscovery,
} from "../../src/main/bash-discovery-decision";

describe("decideBashCardDiscovery (§2.1 points 3–4)", () => {
  it("bash card: one-shot human tip, no nested auto-discovery, identity is a known gap", () => {
    expect(decideBashCardDiscovery({ providerId: "bash" })).toEqual({
      scrollbackTip: BASH_CARD_DISCOVERY_TIP,
      nestedAgentAutoDiscovery: "none",
      nestedIdentity: "known_gap",
    });
  });

  it("provider cards: no bash tip; top-level process is the card itself", () => {
    for (const providerId of ["claude", "codex", "cursor", "antigravity", "opencode"]) {
      expect(decideBashCardDiscovery({ providerId })).toEqual({
        scrollbackTip: null,
        nestedAgentAutoDiscovery: "full",
        nestedIdentity: "card_is_self",
      });
    }
  });

  it("tip mentions acbridge and MCP gap, never a URL (URL sighting must not chip it)", () => {
    expect(BASH_CARD_DISCOVERY_TIP).toContain("acbridge");
    expect(BASH_CARD_DISCOVERY_TIP).toContain("MCP");
    expect(BASH_CARD_DISCOVERY_TIP).toContain("known gap");
    expect(BASH_CARD_DISCOVERY_TIP).not.toMatch(/https?:\/\//);
  });
});
