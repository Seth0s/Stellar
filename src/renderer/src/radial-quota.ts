import type { ProviderUsageStats } from "../../main/provider-usage";
import { decideProviderUsage } from "./provider-usage-decision";

/**
 * Short quota line under a provider node in the radial arc — same source as
 * the usage bar (`decideProviderUsage` / `window.providerUsage.get`), compressed
 * to the prototype's one-line shape ("77% semana", "sem cota", …).
 */
export type RadialQuotaView = {
  text: string;
  /** Warm (measured) vs warn (unavailable / exhausted). */
  tone: "ok" | "warn" | "muted";
  /** When true the node is dimmed (prototype `.dim`). */
  dim: boolean;
};

/** Prototype labels fit ~14 characters; longer reasons must not spill. */
export const RADIAL_QUOTA_MAX_CHARS = 14;

export function truncateRadialQuota(text: string, max = RADIAL_QUOTA_MAX_CHARS): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

export function formatRadialQuota(input: {
  providerId: string;
  stats: ProviderUsageStats | undefined;
  nowMs: number;
  /** When set (parity fixture), wins over live stats. */
  override?: { text: string; tone: RadialQuotaView["tone"]; dim: boolean } | null;
}): RadialQuotaView {
  if (input.override) {
    return {
      text: truncateRadialQuota(input.override.text),
      tone: input.override.tone,
      dim: input.override.dim,
    };
  }

  const { providerId, stats, nowMs } = input;

  // Shell has no quota surface in the prototype.
  if (providerId === "bash") {
    return { text: "", tone: "muted", dim: false };
  }

  const view = decideProviderUsage({ stats, nowMs });
  if (view.kind === "measured" && view.bars.length > 0) {
    const bar = view.bars[0]!;
    const windowLabel =
      bar.key === "week" ? "semana" : bar.key === "session" ? "sessão" : bar.key === "credits" ? "créditos" : bar.key;
    return {
      text: truncateRadialQuota(`${bar.percent}% ${windowLabel}`),
      tone: bar.percent >= 90 ? "warn" : "ok",
      dim: false,
    };
  }

  if (view.kind === "unavailable") {
    const reason = (view.reason ?? "").trim();
    const lower = reason.toLowerCase();
    if (lower.includes("crédito") || lower.includes("credit")) {
      return { text: "sem crédito", tone: "warn", dim: true };
    }
    // Prototype short line for Antigravity — never dump a long readiness phrase.
    if (providerId === "antigravity") {
      if (lower.includes("gemini") || lower === "só gemini" || reason === "só Gemini") {
        return { text: "só Gemini", tone: "ok", dim: false };
      }
      return { text: truncateRadialQuota(reason || "sem cota"), tone: reason ? "ok" : "warn", dim: !reason };
    }
    return { text: "sem cota", tone: "warn", dim: true };
  }

  return { text: "sem cota", tone: "warn", dim: true };
}
