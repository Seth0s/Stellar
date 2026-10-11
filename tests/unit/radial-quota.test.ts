import { describe, it, expect } from "vitest";
import { formatRadialQuota, truncateRadialQuota } from "../../src/renderer/src/radial-quota";
import type { ProviderUsageStats } from "../../src/main/provider-usage";

describe("truncateRadialQuota", () => {
  it("keeps short labels intact", () => {
    expect(truncateRadialQuota("77% semana")).toBe("77% semana");
    expect(truncateRadialQuota("só Gemini")).toBe("só Gemini");
  });

  it("ellipsizes long readiness phrases", () => {
    const long = "instalado, mas não está pronto — rode: agy auth login";
    expect(truncateRadialQuota(long).length).toBeLessThanOrEqual(14);
    expect(truncateRadialQuota(long).endsWith("…")).toBe(true);
  });
});

describe("formatRadialQuota", () => {
  it("returns empty muted text for bash", () => {
    expect(formatRadialQuota({ providerId: "bash", stats: undefined, nowMs: 0 })).toEqual({
      text: "",
      tone: "muted",
      dim: false,
    });
  });

  it("formats a measured week segment as percent + window", () => {
    const stats: ProviderUsageStats = {
      provider: "claude",
      supported: true,
      source: "local-cache",
      segments: [{ key: "week", percent: 77 }],
      capturedAtMs: 1,
    };
    expect(formatRadialQuota({ providerId: "claude", stats, nowMs: 1 })).toEqual({
      text: "77% semana",
      tone: "ok",
      dim: false,
    });
  });

  it("marks unavailable quota as dim warn", () => {
    const stats: ProviderUsageStats = {
      provider: "commandcode",
      supported: false,
      reason: "sem cota",
    };
    expect(formatRadialQuota({ providerId: "commandcode", stats, nowMs: 0 })).toEqual({
      text: "sem cota",
      tone: "warn",
      dim: true,
    });
  });

  it("surfaces credit exhaustion wording", () => {
    const stats: ProviderUsageStats = {
      provider: "codex",
      supported: false,
      reason: "sem crédito",
    };
    expect(formatRadialQuota({ providerId: "codex", stats, nowMs: 0 }).text).toBe("sem crédito");
  });

  it("keeps Antigravity on the short prototype line", () => {
    const stats: ProviderUsageStats = {
      provider: "antigravity",
      supported: false,
      reason: "só Gemini",
    };
    expect(formatRadialQuota({ providerId: "antigravity", stats, nowMs: 0 })).toEqual({
      text: "só Gemini",
      tone: "ok",
      dim: false,
    });
  });

  it("never dumps a long Antigravity readiness phrase into the arc", () => {
    const stats: ProviderUsageStats = {
      provider: "antigravity",
      supported: false,
      reason: "instalado, mas não está pronto — rode: agy auth login && agy doctor",
    };
    const view = formatRadialQuota({ providerId: "antigravity", stats, nowMs: 0 });
    expect(view.text.length).toBeLessThanOrEqual(14);
    expect(view.text.includes("rode:")).toBe(false);
  });

  it("honours a fixture override", () => {
    expect(
      formatRadialQuota({
        providerId: "claude",
        stats: undefined,
        nowMs: 0,
        override: { text: "77% semana", tone: "ok", dim: false },
      }).text,
    ).toBe("77% semana");
  });
});
