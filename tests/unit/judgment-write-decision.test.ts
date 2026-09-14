import { describe, it, expect } from "vitest";
import {
  decideJudgmentWrite,
  describeImplementerJudgmentRefusal,
  roleOnTask,
} from "../../src/main/judgment-write-decision";

describe("decideJudgmentWrite (CAMADA 4)", () => {
  it("allows non-judgment status for implementer", () => {
    expect(decideJudgmentWrite({ proposedStatus: "running", requesterRoleOnTask: "implementer" })).toEqual({
      action: "allow",
    });
    expect(decideJudgmentWrite({ proposedStatus: "pending", requesterRoleOnTask: "implementer" })).toEqual({
      action: "allow",
    });
    expect(decideJudgmentWrite({ proposedStatus: null, requesterRoleOnTask: "implementer" })).toEqual({ action: "allow" });
  });

  it("refuses done/failed for implementer and names request_task_status", () => {
    const done = decideJudgmentWrite({ proposedStatus: "done", requesterRoleOnTask: "implementer" });
    expect(done).toEqual({ action: "refuse", error: describeImplementerJudgmentRefusal("done") });
    expect(done.action === "refuse" && done.error).toContain("request_task_status");

    const failed = decideJudgmentWrite({ proposedStatus: "failed", requesterRoleOnTask: "implementer" });
    expect(failed.action).toBe("refuse");
    expect(failed.action === "refuse" && failed.error).toContain("failed");
  });

  it("allows reviewer to write judgment (role is to judge)", () => {
    expect(decideJudgmentWrite({ proposedStatus: "done", requesterRoleOnTask: "reviewer" })).toEqual({ action: "allow" });
    expect(decideJudgmentWrite({ proposedStatus: "failed", requesterRoleOnTask: "reviewer" })).toEqual({ action: "allow" });
  });

  it("allows outsider (null role / no link) to write judgment", () => {
    expect(decideJudgmentWrite({ proposedStatus: "done", requesterRoleOnTask: null })).toEqual({ action: "allow" });
  });
});

describe("roleOnTask", () => {
  const cards = [
    { card_id: "10", role: "implementer" },
    { card_id: "20", role: "reviewer" },
  ];
  it("returns role for linked card, null otherwise", () => {
    expect(roleOnTask(cards, "10")).toBe("implementer");
    expect(roleOnTask(cards, "20")).toBe("reviewer");
    expect(roleOnTask(cards, "99")).toBeNull();
    expect(roleOnTask(cards, undefined)).toBeNull();
    expect(roleOnTask(cards, null)).toBeNull();
  });
});
