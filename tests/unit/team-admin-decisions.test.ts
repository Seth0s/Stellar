import { describe, expect, it } from "vitest";
import type { TeamMemberInfo, TeamRole } from "../../src/preload/index";
import {
  canDeleteTeam,
  canRenameTeam,
  consumeTeamSub,
  identityMatchesInvite,
  inviteDaysLeft,
  inviteStep,
  maskIdentity,
  memberRowState,
  ownerCount,
  requestTeamSub,
  seatsView,
  slugMatches,
  splitTemplate,
} from "../../src/renderer/src/team-admin-decisions";

function member(id: string, role: TeamRole): TeamMemberInfo {
  return { accountId: id, role, joinedAt: null, displayName: id, avatarInitials: id.slice(0, 2).toUpperCase(), email: null };
}

describe("seatsView", () => {
  it("null seats mean no limit", () => {
    expect(seatsView(null)).toEqual({ kind: "unlimited" });
  });
  it("open below the total, full at or above it", () => {
    expect(seatsView({ used: 3, total: 5, expiresAt: null })).toEqual({ kind: "open", used: 3, total: 5 });
    expect(seatsView({ used: 5, total: 5, expiresAt: null })).toEqual({ kind: "full", used: 5, total: 5 });
    expect(seatsView({ used: 6, total: 5, expiresAt: null }).kind).toBe("full");
  });
});

describe("memberRowState", () => {
  const owner = member("owner", "owner");
  const admin = member("admin", "admin");
  const plain = member("plain", "member");
  const members = [owner, admin, plain];

  it("an owner changes anyone's role and removes others", () => {
    const row = memberRowState({ members, member: plain, accountId: "owner", myRole: "owner" });
    expect(row).toMatchObject({ canChangeRole: true, roleLock: null, action: "remove", actionLock: null });
    expect(row.roleOptions).toEqual(["owner", "admin", "member"]);
  });

  it("the sole owner can neither be demoted nor leave, and the reason is stated", () => {
    const row = memberRowState({ members, member: owner, accountId: "owner", myRole: "owner" });
    expect(row).toMatchObject({ canChangeRole: false, roleLock: "last-owner", action: "leave", actionLock: "last-owner" });
  });

  it("with two owners each may leave and be demoted", () => {
    const two = [owner, member("second", "owner"), plain];
    const row = memberRowState({ members: two, member: owner, accountId: "owner", myRole: "owner" });
    expect(row).toMatchObject({ canChangeRole: true, action: "leave", actionLock: null });
    expect(ownerCount(two)).toBe(2);
  });

  it("an admin only manages plain members and never grants owner", () => {
    const onPlain = memberRowState({ members, member: plain, accountId: "admin", myRole: "admin" });
    expect(onPlain).toMatchObject({ canChangeRole: true, action: "remove" });
    expect(onPlain.roleOptions).toEqual(["member", "admin"]);
    const onOwner = memberRowState({ members, member: owner, accountId: "admin", myRole: "admin" });
    expect(onOwner).toMatchObject({ canChangeRole: false, roleLock: "permission", action: null });
    const onAdmin = memberRowState({ members: [owner, admin, member("a2", "admin")], member: member("a2", "admin"), accountId: "admin", myRole: "admin" });
    expect(onAdmin).toMatchObject({ canChangeRole: false, action: null });
  });

  it("a plain member can only leave their own row", () => {
    expect(memberRowState({ members, member: plain, accountId: "plain", myRole: "member" })).toMatchObject({
      canChangeRole: false,
      roleLock: "permission",
      action: "leave",
      actionLock: null,
    });
    expect(memberRowState({ members, member: admin, accountId: "plain", myRole: "member" }).action).toBeNull();
  });
});

describe("permissions", () => {
  it("rename is admin+, delete is owner only", () => {
    expect(canRenameTeam("owner") && canRenameTeam("admin")).toBe(true);
    expect(canRenameTeam("member") || canRenameTeam(null)).toBe(false);
    expect(canDeleteTeam("owner")).toBe(true);
    expect(canDeleteTeam("admin") || canDeleteTeam("member") || canDeleteTeam(null)).toBe(false);
  });

  it("the delete button unlocks only on the exact slug", () => {
    expect(slugMatches("nebula-labs", "nebula-labs")).toBe(true);
    expect(slugMatches("  nebula-labs ", "nebula-labs")).toBe(true);
    expect(slugMatches("Nebula-Labs", "nebula-labs")).toBe(false);
    expect(slugMatches("nebula", "nebula-labs")).toBe(false);
    expect(slugMatches("", "")).toBe(false);
  });
});

describe("inviteDaysLeft", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  it("counts whole days, rounding up, never below zero", () => {
    expect(inviteDaysLeft({ expiresAt: "2026-10-16T12:00:00Z" }, now)).toBe(5);
    expect(inviteDaysLeft({ expiresAt: "2026-10-16T13:00:00Z" }, now)).toBe(6);
    expect(inviteDaysLeft({ expiresAt: "2026-10-10T12:00:00Z" }, now)).toBe(0);
    expect(inviteDaysLeft({ expiresAt: null }, now)).toBeNull();
    expect(inviteDaysLeft({ expiresAt: "nope" }, now)).toBeNull();
  });
});

describe("invite identity and step", () => {
  it("masks like the server and matches any held identity", () => {
    expect(maskIdentity("kai@example.com")).toBe("k***@example.com");
    expect(maskIdentity("samok")).toBe("s***");
    expect(identityMatchesInvite(["Kai@Example.com"], "k***@example.com")).toBe(true);
    expect(identityMatchesInvite(["jordan@example.com", "kai@example.com"], "k***@example.com")).toBe(true);
    expect(identityMatchesInvite(["jordan@example.com"], "k***@example.com")).toBe(false);
  });

  it("nothing to compare never rules the account out", () => {
    expect(identityMatchesInvite([], "k***@example.com")).toBe(true);
    expect(identityMatchesInvite(["jordan@example.com"], "")).toBe(true);
  });

  it("walks the steps: loading, unavailable, signin, accept, wrong-id, joined", () => {
    const base = { previewState: "ready" as const, loggedIn: false, identityMatches: true, serverMismatch: false, joined: false };
    expect(inviteStep({ ...base, previewState: "loading" })).toBe("loading");
    expect(inviteStep({ ...base, previewState: "unavailable" })).toBe("unavailable");
    expect(inviteStep(base)).toBe("signin");
    expect(inviteStep({ ...base, loggedIn: true })).toBe("accept");
    expect(inviteStep({ ...base, loggedIn: true, identityMatches: false })).toBe("wrong-id");
    expect(inviteStep({ ...base, loggedIn: true, serverMismatch: true })).toBe("wrong-id");
    expect(inviteStep({ ...base, loggedIn: true, joined: true })).toBe("joined");
  });
});

describe("splitTemplate", () => {
  it("separates text from slots, keeping order", () => {
    expect(splitTemplate("{a} convidou você para {b}.")).toEqual([{ slot: "a" }, { text: " convidou você para " }, { slot: "b" }, { text: "." }]);
    expect(splitTemplate("sem slot")).toEqual([{ text: "sem slot" }]);
  });
});

describe("requestTeamSub / consumeTeamSub", () => {
  it("hands the section to the next team page once", () => {
    const store = new Map<string, string>();
    const storage = {
      setItem: (k: string, v: string) => void store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    requestTeamSub("board", storage);
    expect(consumeTeamSub(storage)).toBe("board");
    expect(consumeTeamSub(storage)).toBeNull();
  });

  it("storage that throws is not an error", () => {
    const broken = {
      setItem: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(() => requestTeamSub("board", broken)).not.toThrow();
    expect(consumeTeamSub(broken)).toBeNull();
  });
});
