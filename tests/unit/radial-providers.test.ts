import { describe, it, expect } from "vitest";
import { deriveRadialProviderItems } from "../../src/renderer/src/radial-providers";

describe("deriveRadialProviderItems", () => {
  const PROVIDERS = ["bash", "claude", "codex", "cursor", "antigravity", "opencode"];

  it("marks every provider installed when nothing is reported missing", () => {
    expect(deriveRadialProviderItems(PROVIDERS, [])).toEqual(PROVIDERS.map((id) => ({ id, installed: true })));
  });

  it("marks reported-missing providers as not installed", () => {
    const result = deriveRadialProviderItems(PROVIDERS, [{ id: "codex" }, { id: "cursor" }]);
    expect(result).toEqual([
      { id: "bash", installed: true },
      { id: "claude", installed: true },
      { id: "codex", installed: false },
      { id: "cursor", installed: false },
      { id: "antigravity", installed: true },
      { id: "opencode", installed: true },
    ]);
  });

  it("has no bash special-case — it reads installed straight off the missing set", () => {
    // In practice main/providers.ts's checkAgentAvailability never reports
    // bash as missing (it's excluded up front, not an installable CLI), so
    // this never happens live — the derivation itself just doesn't hardcode
    // that assumption; it trusts whatever `missing` says.
    const result = deriveRadialProviderItems(PROVIDERS, [{ id: "bash" }]);
    expect(result.find((p) => p.id === "bash")).toEqual({ id: "bash", installed: false });
  });

  it("preserves the input provider order", () => {
    const reordered = ["opencode", "bash", "claude"];
    expect(deriveRadialProviderItems(reordered, []).map((p) => p.id)).toEqual(reordered);
  });
});
