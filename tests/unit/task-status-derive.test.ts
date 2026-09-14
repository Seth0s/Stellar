import { describe, it, expect } from "vitest";
import {
  coerceStoredTaskStatus,
  deriveParticipationDivergence,
  deriveTaskStatus,
  isJudgmentStatus,
  storedStatusAfterImplementerLink,
} from "../../src/task-status-derive";

describe("task-status-derive (pure)", () => {
  it("isJudgmentStatus", () => {
    expect(isJudgmentStatus("done")).toBe(true);
    expect(isJudgmentStatus("failed")).toBe(true);
    expect(isJudgmentStatus("pending")).toBe(false);
    expect(isJudgmentStatus("running")).toBe(false);
  });

  it("coerceStoredTaskStatus maps running → pending", () => {
    expect(coerceStoredTaskStatus("running")).toBe("pending");
    expect(coerceStoredTaskStatus("pending")).toBe("pending");
    expect(coerceStoredTaskStatus("done")).toBe("done");
  });

  it("deriveTaskStatus: judgment wins; else live → running", () => {
    expect(deriveTaskStatus("done", true)).toBe("done");
    expect(deriveTaskStatus("failed", true)).toBe("failed");
    expect(deriveTaskStatus("pending", true)).toBe("running");
    expect(deriveTaskStatus("pending", false)).toBe("pending");
  });

  it("storedStatusAfterImplementerLink reopens failed only", () => {
    expect(storedStatusAfterImplementerLink("failed")).toBe("pending");
    expect(storedStatusAfterImplementerLink("done")).toBe("done");
    expect(storedStatusAfterImplementerLink("running")).toBe("pending");
  });

  it("deriveParticipationDivergence: human hold when effective running", () => {
    const d = deriveParticipationDivergence({
      storedStatus: "pending",
      effectiveStatus: "running",
      lastStatusActor: "human",
      existingDivergedStatus: null,
      existingDivergedActor: null,
    });
    expect(d).toEqual({ divergedStatus: "pending", divergedActor: "human" });
  });

  it("deriveParticipationDivergence: aligned pending clears human hold noise", () => {
    const d = deriveParticipationDivergence({
      storedStatus: "pending",
      effectiveStatus: "pending",
      lastStatusActor: "human",
      existingDivergedStatus: "pending",
      existingDivergedActor: "human",
    });
    expect(d).toEqual({ divergedStatus: null, divergedActor: null });
  });

  it("deriveParticipationDivergence: judgment keeps stored diverged_*", () => {
    const d = deriveParticipationDivergence({
      storedStatus: "done",
      effectiveStatus: "done",
      lastStatusActor: "human",
      existingDivergedStatus: "failed",
      existingDivergedActor: "app",
    });
    expect(d).toEqual({ divergedStatus: "failed", divergedActor: "app" });
  });
});
