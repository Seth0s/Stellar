import { describe, expect, it } from "vitest";
import {
  ageBucket,
  candidateLabelKey,
  decideSaveState,
  failureMessageKey,
  failureScreen,
  outcomeOfSave,
  profileCanHoldSessions,
  projectRefParts,
  saveStateTone,
  sessionMetaParts,
  sortAccountSessions,
} from "../../src/renderer/src/account-session-decision";
import type { AccountSessionLink, AccountSessionView } from "../../src/preload/index";

const link: AccountSessionLink = { profileId: "p", sessionId: "s", revision: 4, savedAt: 1, omitted: 0 };
const view = (over: Partial<AccountSessionView>): AccountSessionView => ({
  id: "s",
  name: "app",
  project: "app",
  projectRef: null,
  revision: 1,
  cardCount: 1,
  taskCount: 0,
  updatedAt: "2026-01-01T00:00:00Z",
  updatedByDevice: null,
  openHereBoardId: null,
  ...over,
});

describe("profileCanHoldSessions", () => {
  it("refuses a profile the server has no row for", () => {
    expect(profileCanHoldSessions("c0ffee")).toBe(true);
    expect(profileCanHoldSessions("team:abc")).toBe(false);
    expect(profileCanHoldSessions("")).toBe(false);
    expect(profileCanHoldSessions(null)).toBe(false);
  });
});

describe("save state", () => {
  it("says unsaved without a link, saved with the revision with one", () => {
    expect(decideSaveState(null, null)).toEqual({ kind: "unsaved" });
    expect(decideSaveState(link, null)).toEqual({ kind: "saved", revision: 4 });
  });

  it("a conflict or a lost connection wins over a saved link", () => {
    expect(decideSaveState(link, { kind: "conflict" })).toEqual({ kind: "conflict" });
    expect(decideSaveState(link, { kind: "offline" })).toEqual({ kind: "offline" });
    expect(decideSaveState(link, { kind: "saved" })).toEqual({ kind: "saved", revision: 4 });
    expect(decideSaveState(null, { kind: "failed" })).toEqual({ kind: "unsaved" });
  });

  it("has a tone per state", () => {
    expect(saveStateTone({ kind: "saved", revision: 1 })).toBe("ok");
    expect(saveStateTone({ kind: "conflict" })).toBe("warn");
    expect(saveStateTone({ kind: "offline" })).toBe("warn");
    expect(saveStateTone({ kind: "unsaved" })).toBe("idle");
  });

  it("reads a save result into an outcome", () => {
    expect(outcomeOfSave({ ok: true, revision: 2, created: true, summary: { cardCount: 1, taskCount: 0 }, omitted: 0, overLimit: 0 })).toEqual({ kind: "saved" });
    expect(
      outcomeOfSave({ ok: false, conflict: { currentRevision: 2, currentUpdatedAt: null, currentDevice: null, currentSummary: null, mine: { cardCount: 1, taskCount: 0 }, baseRevision: 1, baseAt: 1 } }),
    ).toEqual({ kind: "conflict" });
    expect(outcomeOfSave({ ok: false, failure: { state: "offline" } })).toEqual({ kind: "offline" });
    expect(outcomeOfSave({ ok: false, failure: { state: "limit" } })).toEqual({ kind: "failed" });
  });
});

describe("failures", () => {
  it("leads plan, offline and login to their own screen", () => {
    expect(failureScreen({ state: "plan", expired: false })).toBe("plan");
    expect(failureScreen({ state: "offline" })).toBe("offline");
    expect(failureScreen({ state: "login" })).toBe("login");
    expect(failureScreen({ state: "limit" })).toBe("message");
  });

  it("has a message for every other state", () => {
    expect(failureMessageKey({ state: "limit" })).toBe("accountSession.failure.limit");
    expect(failureMessageKey({ state: "too-large" })).toBe("accountSession.failure.tooLarge");
    expect(failureMessageKey({ state: "rate-limited", retryAfterSec: 3 })).toBe("accountSession.failure.rateLimited");
    expect(failureMessageKey({ state: "gone" })).toBe("accountSession.failure.gone");
    expect(failureMessageKey({ state: "invalid", code: "snapshot_invalid" })).toBe("accountSession.failure.invalid");
    expect(failureMessageKey({ state: "error", code: "x", message: "m" })).toBe("accountSession.failure.error");
  });
});

describe("list rows", () => {
  it("names the project by its remote or its folder", () => {
    expect(projectRefParts({ kind: "git", remote: "github.com/e/app", name: "app" })).toEqual({ kind: "git", text: "github.com/e/app" });
    expect(projectRefParts({ kind: "folder", name: "docs-site" })).toEqual({ kind: "folder", text: "docs-site" });
    expect(projectRefParts(null)).toEqual({ kind: "none", text: "" });
  });

  it("puts the sessions held here first, then the newest", () => {
    const sorted = sortAccountSessions([
      view({ id: "old", updatedAt: "2026-01-01T00:00:00Z" }),
      view({ id: "new", updatedAt: "2026-01-03T00:00:00Z" }),
      view({ id: "here", updatedAt: "2025-01-01T00:00:00Z", openHereBoardId: "b" }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["here", "new", "old"]);
  });

  it("measures the age against now and tolerates a bad date", () => {
    const now = Date.parse("2026-01-01T00:20:00Z");
    expect(sessionMetaParts(view({ updatedAt: "2026-01-01T00:00:00Z", updatedByDevice: "Notebook", cardCount: 7, taskCount: 14 }), now)).toMatchObject({
      cards: 7,
      tasks: 14,
      device: "Notebook",
      ageMs: 20 * 60_000,
    });
    expect(sessionMetaParts(view({ updatedAt: "" }), now).ageMs).toBeNull();
  });

  it("buckets an age into the largest whole unit", () => {
    expect(ageBucket(null)).toBeNull();
    expect(ageBucket(30_000)).toEqual({ unit: "now", n: 0 });
    expect(ageBucket(20 * 60_000)).toEqual({ unit: "min", n: 20 });
    expect(ageBucket(5 * 3600_000)).toEqual({ unit: "hour", n: 5 });
    expect(ageBucket(3 * 24 * 3600_000)).toEqual({ unit: "day", n: 3 });
  });
});

describe("folder candidates", () => {
  it("labels a sure match and a close one differently", () => {
    expect(candidateLabelKey("remote")).toBe("accountSession.folder.sameRemote");
    expect(candidateLabelKey("name")).toBe("accountSession.folder.otherRemote");
  });
});
