import { describe, it, expect } from "vitest";
import {
  AGENT_SCROLLBACK_DISCOVERY_TIP,
  BASH_CARD_DISCOVERY_TIP,
  REPORT_DISCOVERY_UNREACHABLE_TIP,
  decideBashCardDiscovery,
} from "../../src/main/bash-discovery-decision";
import {
  deriveReportDiscovery,
  type ProviderCapacity,
} from "../../src/main/providers";

describe("decideBashCardDiscovery (capacity-derived §0 + §2.1 points 3–4)", () => {
  it("bash card: nested-agent tip, report discovery not_applicable, identity known gap", () => {
    expect(decideBashCardDiscovery({ providerId: "bash" })).toEqual({
      scrollbackTip: BASH_CARD_DISCOVERY_TIP,
      spawnBlock: null,
      reportDiscovery: "not_applicable",
      nestedAgentAutoDiscovery: "none",
      nestedIdentity: "known_gap",
    });
  });

  it("providers with system-prompt flag: no scrollback tip (hint already injected)", () => {
    for (const providerId of ["claude", "codex"]) {
      expect(decideBashCardDiscovery({ providerId })).toEqual({
        scrollbackTip: null,
        spawnBlock: null,
        reportDiscovery: "system_prompt",
        nestedAgentAutoDiscovery: "full",
        nestedIdentity: "card_is_self",
      });
    }
  });

  it("providers without system-prompt flag: scrollback tip derived (not MCP-alone)", () => {
    for (const providerId of ["cursor", "antigravity", "opencode"]) {
      expect(decideBashCardDiscovery({ providerId })).toEqual({
        scrollbackTip: AGENT_SCROLLBACK_DISCOVERY_TIP,
        spawnBlock: null,
        reportDiscovery: "scrollback",
        nestedAgentAutoDiscovery: "full",
        nestedIdentity: "card_is_self",
      });
    }
  });

  it("unknown provider: spawnBlock (refuse), never silent hole", () => {
    expect(decideBashCardDiscovery({ providerId: "not-a-provider" })).toEqual({
      scrollbackTip: null,
      spawnBlock: REPORT_DISCOVERY_UNREACHABLE_TIP,
      reportDiscovery: "unreachable",
      nestedAgentAutoDiscovery: "none",
      nestedIdentity: "known_gap",
    });
  });

  it("agent scrollback tip teaches acbridge report, never a URL", () => {
    expect(AGENT_SCROLLBACK_DISCOVERY_TIP).toContain("acbridge report");
    expect(AGENT_SCROLLBACK_DISCOVERY_TIP).toContain("stellar");
    expect(AGENT_SCROLLBACK_DISCOVERY_TIP).not.toMatch(/https?:\/\//);
  });

  it("bash tip mentions acbridge and MCP gap, never a URL", () => {
    expect(BASH_CARD_DISCOVERY_TIP).toContain("acbridge");
    expect(BASH_CARD_DISCOVERY_TIP).toContain("MCP");
    expect(BASH_CARD_DISCOVERY_TIP).toContain("known gap");
    expect(BASH_CARD_DISCOVERY_TIP).not.toMatch(/https?:\/\//);
  });
});

describe("deriveReportDiscovery", () => {
  it("flag → system_prompt; no flag + acbridge → scrollback; neither → unreachable", () => {
    const withFlag: ProviderCapacity = {
      role: "agent",
      systemPrompt: { mechanism: "append-system-prompt" },
      mcp: { mechanism: "none" },
      acbridgeOnPath: true,
    };
    expect(deriveReportDiscovery(withFlag)).toBe("system_prompt");

    const scrollback: ProviderCapacity = {
      role: "agent",
      systemPrompt: { mechanism: "none" },
      mcp: { mechanism: "global-config" },
      acbridgeOnPath: true,
    };
    expect(deriveReportDiscovery(scrollback)).toBe("scrollback");

    const unreachable: ProviderCapacity = {
      role: "agent",
      systemPrompt: { mechanism: "none" },
      mcp: { mechanism: "global-config" },
      acbridgeOnPath: false,
    };
    expect(deriveReportDiscovery(unreachable)).toBe("unreachable");
  });

  it("does NOT treat MCP alone as sufficient report discovery", () => {
    // The capacity that reopened the cursor silent-report hole if trusted.
    const mcpOnlyLooking: ProviderCapacity = {
      role: "agent",
      systemPrompt: { mechanism: "none" },
      mcp: { mechanism: "global-config" },
      acbridgeOnPath: true,
    };
    expect(deriveReportDiscovery(mcpOnlyLooking)).toBe("scrollback");
    expect(deriveReportDiscovery(mcpOnlyLooking)).not.toBe("system_prompt");
  });
});
