import { describe, expect, it } from "vitest";
import {
  GRACE_PERIOD_DAYS,
  PLANS_URL_DEFAULT,
  freePlan,
  parseCloudPlan,
  planErrorFrom,
  readOnlyUntil,
  requiredPlanFor,
  resolvePlansUrl,
} from "../../src/main/plan-decision";
import {
  canWrite,
  decidePlanAccess,
  describePlanFailure,
  rightFor,
  type PlanAccess,
} from "../../src/renderer/src/PlanAccess";
import type { CloudPlanInfo } from "../../src/preload/index";

/**
 * The paid-right matrix: what each plan/state grants, what the app locks, and
 * how a 402 is classified. Both sides are exercised — the main process parses
 * the backend reply, the renderer decides what a screen shows.
 */

const EXPIRED = "2026-01-01T00:00:00.000Z";

/** A `/v1/me` body with the given rights, defaulting to Free. */
function me(body: Partial<Record<"sync" | "team", unknown>> = {}, accountPlan = "free") {
  return {
    account: { id: "acc-1", display_name: "Lucas" },
    plan: {
      account_plan: accountPlan,
      rights: {
        sync: body.sync ?? { granted: false, state: "none", plan: "pro" },
        team: body.team ?? { granted: false, state: "none", plan: "team" },
      },
    },
  };
}

describe("parseCloudPlan", () => {
  it("reads the plan block, keeping the origin of each right", () => {
    const plan = parseCloudPlan(
      me({
        sync: { granted: true, state: "active", plan: "pro", source: "account" },
        team: { granted: true, state: "active", plan: "team", source: "team", team_id: "t1" },
      }, "pro"),
    );
    expect(plan?.accountPlan).toBe("pro");
    expect(plan?.rights.sync.source).toBe("account");
    expect(plan?.rights.team.source).toBe("team");
    expect(plan?.rights.team.teamId).toBe("t1");
  });

  it("accepts the plan block itself, not only the whole /me body", () => {
    const plan = parseCloudPlan({ account_plan: "pro", rights: { sync: { granted: true, state: "active", plan: "pro" } } });
    expect(plan?.rights.sync.granted).toBe(true);
  });

  it("a body with NO plan block is UNKNOWN, never Free", () => {
    expect(parseCloudPlan({ account: { id: "acc-1" } })).toBeNull();
    expect(parseCloudPlan({})).toBeNull();
  });

  it("degrades a missing field INSIDE a present block to an honest value", () => {
    const plan = parseCloudPlan({ account_plan: "free", rights: {} });
    expect(plan?.accountPlan).toBe("free");
    expect(plan?.rights.sync.granted).toBe(false);
    expect(plan?.rights.team.state).toBe("none");
  });

  it("a non-object is null, never an invented plan", () => {
    expect(parseCloudPlan(null)).toBeNull();
    expect(parseCloudPlan("nope")).toBeNull();
  });
});

describe("decode the effective access per feature", () => {
  it("no plan block is UNKNOWN: nothing is locked, no upgrade is offered", () => {
    expect(decidePlanAccess(null, "sync")).toEqual({ kind: "unknown", feature: "sync" });
    expect(decidePlanAccess(null, "team")).toEqual({ kind: "unknown", feature: "team" });
    expect(canWrite(decidePlanAccess(null, "sync"))).toBe(true);
  });

  it("Free account: both rights need an upgrade", () => {
    const plan = parseCloudPlan(me());
    expect(decidePlanAccess(plan, "sync").kind).toBe("upgrade");
    expect(decidePlanAccess(plan, "team").kind).toBe("upgrade");
  });

  it("Pro account grants sync (source account) but not team", () => {
    const plan = parseCloudPlan(me({ sync: { granted: true, state: "active", plan: "pro", source: "account" } }, "pro"));
    expect(decidePlanAccess(plan, "sync")).toEqual({ kind: "granted", source: "account", teamId: null });
    expect(decidePlanAccess(plan, "team").kind).toBe("upgrade");
  });

  it("a paid team seat grants sync and team, sourced from the team", () => {
    const plan = parseCloudPlan(
      me({
        sync: { granted: true, state: "active", plan: "pro", source: "team", team_id: "t1" },
        team: { granted: true, state: "active", plan: "team", source: "team", team_id: "t1" },
      }),
    );
    expect(decidePlanAccess(plan, "sync")).toEqual({ kind: "granted", source: "team", teamId: "t1" });
    expect(decidePlanAccess(plan, "team")).toEqual({ kind: "granted", source: "team", teamId: "t1" });
  });

  it("grace state is expired (read-only) and carries the 30-day window", () => {
    const plan = parseCloudPlan(me({ sync: { granted: false, state: "grace", plan: "pro", expires_at: EXPIRED } }));
    const access = decidePlanAccess(plan, "sync");
    expect(access.kind).toBe("expired");
    if (access.kind !== "expired") return;
    expect(access.state).toBe("grace");
    expect(access.expiresAt).toBe(EXPIRED);
    expect(access.readOnlyUntil).toBe(readOnlyUntil(EXPIRED));
    expect(Date.parse(access.readOnlyUntil!)).toBe(Date.parse(EXPIRED) + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  });

  it("archived state is expired too, and still names the dates", () => {
    const plan = parseCloudPlan(me({ team: { granted: false, state: "archived", plan: "team", expires_at: EXPIRED } }));
    const access = decidePlanAccess(plan, "team");
    expect(access.kind).toBe("expired");
    if (access.kind === "expired") expect(access.state).toBe("archived");
  });

  it("writes are allowed while granted or unknown; refused on a real lock", () => {
    expect(canWrite({ kind: "granted", source: "account", teamId: null })).toBe(true);
    expect(canWrite({ kind: "unknown", feature: "sync" })).toBe(true);
    expect(canWrite({ kind: "upgrade", feature: "sync", requiredPlan: "pro" })).toBe(false);
    expect(canWrite({ kind: "expired", feature: "sync", state: "grace", expiresAt: EXPIRED, readOnlyUntil: null })).toBe(false);
  });
});

describe("rightFor and requiredPlanFor", () => {
  it("reads a present plan; a right missing inside it is unmet", () => {
    const partial = { accountPlan: "free", accountExpiresAt: null, rights: {} } as unknown as CloudPlanInfo;
    expect(rightFor(partial, "sync").granted).toBe(false);
    expect(rightFor(freePlan(), "team").plan).toBe("team");
  });

  it("sync needs Pro, team needs Team", () => {
    expect(requiredPlanFor("sync")).toBe("pro");
    expect(requiredPlanFor("team")).toBe("team");
  });
});

describe("planErrorFrom", () => {
  it("classifies a 402 plan_required with its feature and plan", () => {
    const err = { status: 402, code: "plan_required", message: "x", feature: "sync", plan: "pro" };
    expect(planErrorFrom(err)).toEqual({ code: "plan_required", feature: "sync", plan: "pro", expiredAt: null });
  });

  it("classifies a 402 plan_expired with the expiry", () => {
    const err = { status: 402, code: "plan_expired", message: "x", feature: "team", plan: "team", expiredAt: EXPIRED };
    expect(planErrorFrom(err)?.expiredAt).toBe(EXPIRED);
  });

  it("classifies seats_exceeded, which has no feature", () => {
    expect(planErrorFrom({ status: 402, code: "seats_exceeded", message: "x" })?.code).toBe("seats_exceeded");
  });

  it("leaves a non-402 and an unknown 402 code on the ordinary error path", () => {
    expect(planErrorFrom({ status: 409, code: "plan_required", message: "x" })).toBeNull();
    expect(planErrorFrom({ status: 402, code: "weird", message: "x" })).toBeNull();
  });
});

describe("describePlanFailure", () => {
  const upgrade: PlanAccess = { kind: "upgrade", feature: "sync", requiredPlan: "pro" };
  it("routes an un-granted feature to the plan notice, never the raw error", () => {
    expect(describePlanFailure(upgrade, "boom")).toEqual({ kind: "plan", access: upgrade });
  });
  it("keeps the raw error once the feature is granted", () => {
    const granted: PlanAccess = { kind: "granted", source: "account", teamId: null };
    expect(describePlanFailure(granted, "boom")).toEqual({ kind: "raw", error: "boom" });
  });
  it("an UNKNOWN plan offers no proactive notice, but a real refusal becomes one", () => {
    const unknown: PlanAccess = { kind: "unknown", feature: "team" };
    expect(describePlanFailure(unknown, "402")).toEqual({ kind: "plan", access: { kind: "upgrade", feature: "team", requiredPlan: "team" } });
  });
});

describe("resolvePlansUrl", () => {
  it("uses the env override when present", () => {
    expect(resolvePlansUrl({ STELLARCLOUD_PLANS_URL: "https://example.test/planos" })).toBe("https://example.test/planos");
  });
  it("falls back to the site's plans page", () => {
    expect(resolvePlansUrl({})).toBe(PLANS_URL_DEFAULT);
  });
});
