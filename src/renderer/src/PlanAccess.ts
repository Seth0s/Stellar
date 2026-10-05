/**
 * PLANS IN THE RENDERER — the pure decisions the screens read, no I/O.
 *
 * The plan and rights come from the main process (`GET /v1/me`). This module
 * turns that data into ONE answer per feature: usable, needs an upgrade, or
 * expired (read-only). Keeping it pure lets the free / pro / team and the
 * grace / archived states be table-tested without a DOM.
 */

import type { CloudPlanInfo, PlanFeatureInfo, PlanRightInfo } from "../../preload/index";

export type PlanSource = "account" | "team";

export type PlanAccess =
  | { kind: "granted"; source: PlanSource; teamId: string | null }
  | { kind: "upgrade"; feature: PlanFeatureInfo; requiredPlan: "pro" | "team" }
  | { kind: "expired"; feature: PlanFeatureInfo; state: "grace" | "archived"; expiresAt: string | null; readOnlyUntil: string | null }
  /** The server sent no plan block (older backend): the app does not know, so
   *  it locks nothing and shows no upgrade — the server stays the authority. */
  | { kind: "unknown"; feature: PlanFeatureInfo };

/** The two states that ARE a refusal: they render the plan notice and disable
 *  writes. `granted` is usable and `unknown` is not locked. */
export type PlanLock = Extract<PlanAccess, { kind: "upgrade" } | { kind: "expired" }>;

export const GRACE_PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The plan that satisfies each right; mirrors the backend rule. */
export function requiredPlanFor(feature: PlanFeatureInfo): "pro" | "team" {
  return feature === "team" ? "team" : "pro";
}

const FREE_RIGHT: Record<PlanFeatureInfo, PlanRightInfo> = {
  sync: { granted: false, state: "none", plan: "pro", source: null, teamId: null, expiresAt: null },
  team: { granted: false, state: "none", plan: "team", source: null, teamId: null, expiresAt: null },
};

/** The right for one feature of a PRESENT plan; a missing right falls back to
 *  an unmet one. A null plan never reaches here — `decidePlanAccess` reads that
 *  as unknown. */
export function rightFor(plan: CloudPlanInfo, feature: PlanFeatureInfo): PlanRightInfo {
  return plan.rights?.[feature] ?? FREE_RIGHT[feature];
}

/** End of the read-only grace window (`expiresAt + 30 days`), ISO; null when
 *  there is no valid date. */
export function readOnlyUntil(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return new Date(at + GRACE_PERIOD_DAYS * DAY_MS).toISOString();
}

/**
 * The single question every screen asks: may this feature be used? A granted
 * right names where it comes from; an unmet one is either "upgrade" (nothing
 * granted it) or "expired" (it was granted and lapsed — reads still work until
 * the grace window closes). No plan block at all is "unknown": the app locks
 * nothing and only reacts to a real server refusal.
 */
export function decidePlanAccess(plan: CloudPlanInfo | null, feature: PlanFeatureInfo): PlanAccess {
  if (plan === null) return { kind: "unknown", feature };
  const right = rightFor(plan, feature);
  if (right.granted) {
    const source: PlanSource = right.source ?? (right.teamId ? "team" : "account");
    return { kind: "granted", source, teamId: right.teamId };
  }
  if (right.state === "grace" || right.state === "archived") {
    return {
      kind: "expired",
      feature,
      state: right.state,
      expiresAt: right.expiresAt,
      readOnlyUntil: readOnlyUntil(right.expiresAt),
    };
  }
  return { kind: "upgrade", feature, requiredPlan: requiredPlanFor(feature) };
}

/** A write is allowed on a granted (active) right, and also when the plan is
 *  UNKNOWN — an older server that never declared a plan must not be locked out;
 *  only a real refusal (upgrade/expired) blocks writes. */
export function canWrite(access: PlanAccess): boolean {
  return access.kind === "granted" || access.kind === "unknown";
}

/**
 * Any 402 that reaches the UI must fall into the standard upgrade/expired
 * notice, never a crude error. A granted feature keeps its raw message. An
 * unknown plan has no proactive notice, but a REAL refusal still becomes the
 * plan notice (the feature's required plan) — the server was the authority.
 */
export function describePlanFailure(
  access: PlanAccess,
  rawError: string,
): { kind: "plan"; access: PlanLock } | { kind: "raw"; error: string } {
  if (access.kind === "granted") return { kind: "raw", error: rawError };
  if (access.kind === "unknown") {
    return { kind: "plan", access: { kind: "upgrade", feature: access.feature, requiredPlan: requiredPlanFor(access.feature) } };
  }
  return { kind: "plan", access };
}
