import { describe, it, expect } from "vitest";
import {
  profileFromSpawnArgs,
  profileFromCardRow,
  normalizeProfileField,
} from "../../src/main/participation-profile-decision";

describe("participation profile — fact on the link, not task intention", () => {
  it("trims and collapses empty to null — never invents a provider", () => {
    expect(normalizeProfileField("  claude  ")).toBe("claude");
    expect(normalizeProfileField("")).toBeNull();
    expect(normalizeProfileField("   ")).toBeNull();
    expect(normalizeProfileField(undefined)).toBeNull();
  });

  it("records what went to argv", () => {
    expect(
      profileFromSpawnArgs({ provider: "cursor", model: "gpt-5", effort: "high" }),
    ).toEqual({
      provider: "cursor",
      model: "gpt-5",
      effort: "high",
      requestedResumeId: null,
      sessionId: null,
    });
    expect(profileFromSpawnArgs({ provider: "claude", resumeId: "sess-9" })).toEqual({
      provider: "claude",
      model: null,
      effort: null,
      requestedResumeId: "sess-9",
      sessionId: null,
    });
  });

  it("reads the same shape from a living card row (link_task_card path)", () => {
    expect(
      profileFromCardRow({ provider: "codex", model: null, effort: "medium" }),
    ).toEqual({
      provider: "codex",
      model: null,
      effort: "medium",
      requestedResumeId: null,
      sessionId: null,
    });
    expect(
      profileFromCardRow({ provider: "cursor", model: null, effort: null, resume_id: "live-1" }),
    ).toEqual({
      provider: "cursor",
      model: null,
      effort: null,
      requestedResumeId: null,
      sessionId: "live-1",
    });
    expect(profileFromCardRow(undefined)).toEqual({
      provider: null,
      model: null,
      effort: null,
      requestedResumeId: null,
      sessionId: null,
    });
  });
});
