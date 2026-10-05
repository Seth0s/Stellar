/**
 * PLANS AND PAID RIGHTS IN THE APP — the DECISION layer, no I/O.
 *
 * The backend is the authority: each route declares the right it requires
 * (`sync` or `team`). Without it the answer is 402 with `plan_required`; inside
 * the 30-day grace window a WRITE is refused with `plan_expired` while a read
 * still works; a member past the team's paid seats is `seats_exceeded`.
 * `GET /v1/me` returns the effective plan and, per right, WHERE the grant comes
 * from (`account` or `team`) and when it expires.
 *
 * This module reads that block and classifies the 402 into a type of its own —
 * a plan refusal is never collapsed into a generic error. The screens that
 * decide what to show/lock live in the renderer (`PlanAccess.ts`); the I/O
 * shell is `cloud-api.ts` / `cloud-auth.ts`.
 */

import type { CloudApiError } from "./cloud-auth-decision";

export type PlanState = "none" | "active" | "grace" | "archived";
export type PlanFeature = "sync" | "team";
export type PlanSourceKind = "account" | "team";

export const PLAN_FEATURES: readonly PlanFeature[] = ["sync", "team"];

export function isPlanFeature(value: unknown): value is PlanFeature {
  return value === "sync" || value === "team";
}

/** The plan that satisfies each right; mirrors `Right.RequiredPlan()` in the
 *  backend (sync/remote need Pro, team needs Team). */
export function requiredPlanFor(feature: PlanFeature): "pro" | "team" {
  return feature === "team" ? "team" : "pro";
}

/** The grace window an expired paid resource stays READABLE for. */
export const GRACE_PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanRight = {
  granted: boolean;
  state: PlanState;
  /** The plan that would satisfy the right ("pro" | "team"). */
  plan: string;
  /** Where an effective grant comes from; null when nothing grants it. */
  source: PlanSourceKind | null;
  teamId: string | null;
  expiresAt: string | null;
};

export type CloudPlan = {
  accountPlan: string;
  accountExpiresAt: string | null;
  rights: Record<PlanFeature, PlanRight>;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseState(value: unknown): PlanState {
  return value === "active" || value === "grace" || value === "archived" ? value : "none";
}

function parseRight(raw: unknown, feature: PlanFeature): PlanRight {
  const required = requiredPlanFor(feature);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { granted: false, state: "none", plan: required, source: null, teamId: null, expiresAt: null };
  }
  const rec = raw as Record<string, unknown>;
  const source = rec.source === "account" || rec.source === "team" ? rec.source : null;
  return {
    granted: rec.granted === true,
    state: parseState(rec.state),
    plan: asString(rec.plan) ?? required,
    source,
    teamId: asString(rec.team_id),
    expiresAt: asString(rec.expires_at),
  };
}

/** Free = logged out or an account with no paid grant: every right is unmet. */
export function freePlan(): CloudPlan {
  return {
    accountPlan: "free",
    accountExpiresAt: null,
    rights: { sync: parseRight(null, "sync"), team: parseRight(null, "team") },
  };
}

/**
 * Reads the plan block from `GET /v1/me`. Accepts either the block itself
 * (`{ account_plan, rights }`) or the whole `/me` body (`{ plan: { … } }`).
 *
 * A body with NO plan block is an older server (before plans existed): the plan
 * is UNKNOWN, and `null` is the honest answer — the caller must not read it as
 * Free and lock anything. Free is only ever the server SAYING free. Within a
 * present block, a missing field degrades to an honest value.
 */
export function parseCloudPlan(raw: unknown): CloudPlan | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const outer = raw as Record<string, unknown>;
  const hasPlanKey = Object.prototype.hasOwnProperty.call(outer, "plan");
  const block = hasPlanKey && typeof outer.plan === "object" && outer.plan !== null ? (outer.plan as Record<string, unknown>) : outer;
  const hasRights = Object.prototype.hasOwnProperty.call(block, "rights");
  const hasAccountPlan = Object.prototype.hasOwnProperty.call(block, "account_plan");
  if (!hasRights && !hasAccountPlan) return null;
  const rawRights = typeof block.rights === "object" && block.rights !== null ? (block.rights as Record<string, unknown>) : {};
  return {
    accountPlan: asString(block.account_plan) ?? "free",
    accountExpiresAt: asString(block.account_expires_at),
    rights: {
      sync: parseRight(rawRights.sync, "sync"),
      team: parseRight(rawRights.team, "team"),
    },
  };
}

// ---------------------------------------------------------------------------
// 402 — a plan refusal carries its own shape, never a generic error.
// ---------------------------------------------------------------------------

export type PlanErrorCode = "plan_required" | "plan_expired" | "seats_exceeded";

export type PlanError = {
  code: PlanErrorCode;
  /** The right the route declared ("sync" | "team"); null when unknown. */
  feature: PlanFeature | null;
  /** The plan that would satisfy the right; null when the backend omits it. */
  plan: string | null;
  /** RFC3339 expiry, only on `plan_expired`. */
  expiredAt: string | null;
};

function isPlanErrorCode(value: string): value is PlanErrorCode {
  return value === "plan_required" || value === "plan_expired" || value === "seats_exceeded";
}

/**
 * Classifies a backend error as a plan refusal. Returns `null` for anything
 * that is not a 402 with a plan code, so the caller can keep its ordinary
 * error path for everything else.
 */
export function planErrorFrom(error: CloudApiError): PlanError | null {
  if (error.status !== 402 || !isPlanErrorCode(error.code)) return null;
  return {
    code: error.code,
    feature: isPlanFeature(error.feature) ? error.feature : null,
    plan: asString(error.plan),
    expiredAt: asString(error.expiredAt),
  };
}

export function isPlanError(error: CloudApiError): boolean {
  return planErrorFrom(error) !== null;
}

// ---------------------------------------------------------------------------
// Read-only window of an expired grant.
// ---------------------------------------------------------------------------

/** End of the grace window (`expiresAt + 30 days`), as an ISO string; null
 *  when there is no date to add to. */
export function readOnlyUntil(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return new Date(at + GRACE_PERIOD_DAYS * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Upgrade URL — "Fazer upgrade" opens the site's plans page (config).
// ---------------------------------------------------------------------------

export const PLANS_URL_ENV = "STELLARCLOUD_PLANS_URL";
export const PLANS_URL_DEFAULT = "https://stellar.idyplatform.com/#planos";

/** The plans page shown by the upgrade call-to-action: env override or default. */
export function resolvePlansUrl(env: Record<string, string | undefined>): string {
  const raw = env[PLANS_URL_ENV]?.trim();
  return raw && raw.length > 0 ? raw : PLANS_URL_DEFAULT;
}
