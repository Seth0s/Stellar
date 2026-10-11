import { describe, expect, it } from "vitest";
import { getTeamNav, isTeamSub, publishTeamSubs, setTeamSub, subscribeTeamNav } from "../../src/renderer/src/team-nav";

describe("team-nav store", () => {
  it("holds the open section and the sections on offer, and tells subscribers", () => {
    let calls = 0;
    const off = subscribeTeamNav(() => calls++);
    setTeamSub("members");
    expect(getTeamNav().sub).toBe("members");
    publishTeamSubs(["overview", "members"]);
    expect(getTeamNav().available).toEqual(["overview", "members"]);
    const before = calls;
    publishTeamSubs(["overview", "members"]);
    setTeamSub("members");
    expect(calls).toBe(before);
    publishTeamSubs([]);
    off();
    setTeamSub("overview");
    expect(calls).toBe(before + 1);
  });

  it("recognises only real sections", () => {
    expect(isTeamSub("settings")).toBe(true);
    expect(isTeamSub("nope")).toBe(false);
    expect(isTeamSub(null)).toBe(false);
  });
});
