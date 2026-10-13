import { describe, expect, it } from "vitest";
import { decideProviderQuota } from "../../src/renderer/src/provider-quota-decision";
import type { ProviderUsageStats } from "../../src/main/provider-usage";

const nowMs = 1_800_000_000_000;
const stats = (segments: { key: string; percent: number; resetsAtMs?: number }[]): ProviderUsageStats => ({
  provider: "mock",
  supported: true,
  source: "http",
  segments,
});

describe("decideProviderQuota", () => {
  it("permits a measured quota below 100%", () => {
    expect(decideProviderQuota({ stats: stats([{ key: "week", percent: 72, resetsAtMs: nowMs + 1_000 }]), nowMs })).toEqual({ kind: "available" });
  });

  it("warns for exhaustion and carries the next reset time", () => {
    expect(decideProviderQuota({ stats: stats([{ key: "session", percent: 100, resetsAtMs: nowMs + 1_000 }]), nowMs })).toEqual({
      kind: "warning",
      state: "exhausted",
      resetsAtMs: nowMs + 1_000,
    });
  });

  it("warns without blocking when quota is unknown", () => {
    expect(decideProviderQuota({ stats: undefined, nowMs })).toEqual({ kind: "warning", state: "unknown", resetsAtMs: null });
    expect(decideProviderQuota({ stats: { provider: "mock", supported: false, reason: "unknown" }, nowMs })).toEqual({ kind: "warning", state: "unknown", resetsAtMs: null });
  });

  it("does not reuse an exhausted window whose reset is in the past", () => {
    expect(decideProviderQuota({ stats: stats([{ key: "session", percent: 100, resetsAtMs: nowMs - 1 }]), nowMs })).toEqual({
      kind: "warning",
      state: "unknown",
      resetsAtMs: null,
    });
  });

  it("blocks an uninstalled or explicitly not-ready provider with its reason", () => {
    const usage = stats([{ key: "week", percent: 10 }]);
    expect(decideProviderQuota({ stats: usage, nowMs, installed: false, unavailableReason: "Install the CLI" })).toEqual({
      kind: "blocked",
      reason: "Install the CLI",
    });
    expect(decideProviderQuota({ stats: usage, nowMs, readiness: "not-ready", unavailableReason: "Sign in" })).toEqual({
      kind: "blocked",
      reason: "Sign in",
    });
  });

  it("does not treat an expired window as exhaustion when a current window has quota", () => {
    expect(decideProviderQuota({
      stats: stats([
        { key: "session", percent: 100, resetsAtMs: nowMs - 1 },
        { key: "week", percent: 40, resetsAtMs: nowMs + 1_000 },
      ]),
      nowMs,
    })).toEqual({ kind: "available" });
  });
});
