import { describe, it, expect } from "vitest";
import {
  normalizeSessionId,
  resumeTargetFromParticipation,
  sessionFromCardRow,
  sessionFromSpawnArgs,
  shouldStampParticipationSession,
} from "../../src/main/participation-session-decision";

describe("participation-session-decision", () => {
  it("normalizeSessionId trims and rejects empty", () => {
    expect(normalizeSessionId("  abc  ")).toBe("abc");
    expect(normalizeSessionId("")).toBeNull();
    expect(normalizeSessionId("   ")).toBeNull();
    expect(normalizeSessionId(null)).toBeNull();
    expect(normalizeSessionId(1)).toBeNull();
  });

  it("sessionFromSpawnArgs records request only", () => {
    expect(sessionFromSpawnArgs({ resumeId: "sess-1" })).toEqual({ requestedResumeId: "sess-1" });
    expect(sessionFromSpawnArgs({ resumeId: null })).toEqual({ requestedResumeId: null });
    expect(sessionFromSpawnArgs({})).toEqual({ requestedResumeId: null });
  });

  it("sessionFromCardRow stamps sessionId only for resumable providers", () => {
    expect(sessionFromCardRow({ provider: "claude", resume_id: "c1" })).toEqual({
      requestedResumeId: null,
      sessionId: "c1",
    });
    expect(sessionFromCardRow({ provider: "cursor", resume_id: "c2" })).toEqual({
      requestedResumeId: null,
      sessionId: "c2",
    });
    expect(sessionFromCardRow({ provider: "bash", resume_id: "nope" })).toEqual({
      requestedResumeId: null,
      sessionId: null,
    });
    expect(sessionFromCardRow({ provider: "antigravity", resume_id: "agy" })).toEqual({
      requestedResumeId: null,
      sessionId: null,
    });
  });

  it("shouldStampParticipationSession matches IMPOSE_SESSION_ID_PROVIDERS", () => {
    expect(shouldStampParticipationSession("claude")).toBe(true);
    expect(shouldStampParticipationSession("cursor")).toBe(true);
    expect(shouldStampParticipationSession("bash")).toBe(false);
    expect(shouldStampParticipationSession("antigravity")).toBe(false);
    expect(shouldStampParticipationSession(null)).toBe(false);
  });

  it("resumeTargetFromParticipation prefers discovered over requested", () => {
    expect(
      resumeTargetFromParticipation({
        session_id: "discovered",
        requested_resume_id: "requested",
      }),
    ).toBe("discovered");
    expect(
      resumeTargetFromParticipation({
        session_id: null,
        requested_resume_id: "requested",
      }),
    ).toBe("requested");
    expect(
      resumeTargetFromParticipation({
        sessionId: null,
        requestedResumeId: null,
      }),
    ).toBeNull();
  });
});
