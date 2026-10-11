import { describe, expect, it } from "vitest";
import {
  CHANGES_REQUESTED_STATUS,
  carryChangesRequested,
  changesRequestedFromResultJson,
  clearChangesRequestedJson,
  decideChangesRequestedWrite,
  describeChangesRequestedWithoutReason,
  normalizeChangesRequested,
  reasonFromReviewReport,
  stampChangesRequestedJson,
} from "../../src/main/task-changes-requested-decision";

describe("decideChangesRequestedWrite", () => {
  it("allows human, marked orchestrator, and linked reviewer", () => {
    expect(
      decideChangesRequestedWrite({
        requesterId: "human:ui",
        requesterRoleOnTask: null,
        orchestratorCardId: "orch",
      }).action,
    ).toBe("allow");
    expect(
      decideChangesRequestedWrite({
        requesterId: "orch",
        requesterRoleOnTask: null,
        orchestratorCardId: "orch",
      }).action,
    ).toBe("allow");
    expect(
      decideChangesRequestedWrite({
        requesterId: "rv",
        requesterRoleOnTask: "reviewer",
        orchestratorCardId: "orch",
      }).action,
    ).toBe("allow");
  });

  it("refuses implementer even when review is wanted and orch is marked", () => {
    const d = decideChangesRequestedWrite({
      requesterId: "impl",
      requesterRoleOnTask: "implementer",
      orchestratorCardId: "orch",
    });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.error).toContain("implementer");
  });

  it("refuses outsider who is not the marked orchestrator", () => {
    const d = decideChangesRequestedWrite({
      requesterId: "other",
      requesterRoleOnTask: null,
      orchestratorCardId: "orch",
    });
    expect(d.action).toBe("refuse");
  });
});

describe("changesRequested result_json stamp", () => {
  it("stamps, reads, carries, and clears", () => {
    const stamp = normalizeChangesRequested({ reason: " redo tests " }, 10, "orch");
    expect(stamp).toEqual({ reason: "redo tests", by: "orch", at: 10 });
    const json = stampChangesRequestedJson('{"keep":1}', stamp!);
    expect(changesRequestedFromResultJson(json)).toEqual(stamp);
    const carried = carryChangesRequested(json, '{"keep":2}');
    expect(changesRequestedFromResultJson(carried)).toEqual(stamp);
    expect(changesRequestedFromResultJson(clearChangesRequestedJson(json))).toBeNull();
  });

  it("describes missing reason", () => {
    expect(describeChangesRequestedWithoutReason()).toContain(CHANGES_REQUESTED_STATUS);
    expect(describeChangesRequestedWithoutReason()).toContain("requestChanges");
  });

  it("reads reason from a review report body", () => {
    expect(reasonFromReviewReport({ reason: "faltou teste" })).toBe("faltou teste");
    expect(reasonFromReviewReport({ ok: false })).toBe("reprovado");
  });
});
