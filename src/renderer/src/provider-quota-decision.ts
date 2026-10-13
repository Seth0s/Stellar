import type { ProviderUsageStats } from "../../main/provider-usage";

export type ProviderQuotaDecision =
  | { kind: "available" }
  | { kind: "warning"; state: "unknown" | "exhausted"; resetsAtMs: number | null }
  | { kind: "blocked"; reason: string };

/** A quota signal is advisory: unknown and exhausted providers remain selectable. */
export function decideProviderQuota(input: {
  stats: ProviderUsageStats | undefined;
  nowMs: number;
  installed?: boolean;
  readiness?: string;
  unavailableReason?: string | null;
}): ProviderQuotaDecision {
  const { stats, nowMs } = input;
  if (input.installed === false || input.readiness === "not-ready") {
    return { kind: "blocked", reason: input.unavailableReason ?? "Provider unavailable" };
  }
  if (!stats?.supported || !stats.segments?.length) return { kind: "warning", state: "unknown", resetsAtMs: null };

  const currentWindows = stats.segments.filter((segment) => segment.resetsAtMs === undefined || segment.resetsAtMs > nowMs);
  if (currentWindows.length === 0) return { kind: "warning", state: "unknown", resetsAtMs: null };

  const exhausted = currentWindows.filter((segment) => Number.isFinite(segment.percent) && segment.percent >= 100);
  if (exhausted.length === 0) return { kind: "available" };

  const resets = exhausted.map((segment) => segment.resetsAtMs).filter((value): value is number => value !== undefined);
  return { kind: "warning", state: "exhausted", resetsAtMs: resets.length ? Math.min(...resets) : null };
}
