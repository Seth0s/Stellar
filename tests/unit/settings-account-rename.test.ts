import { describe, expect, it } from "vitest";
import { accountRenameFailure, validateAccountProfileName } from "../../src/main/cloud-profile-rename-decision";
import { MAX_PROFILE_NAME_LENGTH } from "../../src/main/profiles-decision";
import {
  ACCOUNT_RENAME_BLOCK_KEY,
  ACCOUNT_RENAME_FAILURE_KEY,
  decideAccountRename,
  roleInTeam,
  type RoleReading,
} from "../../src/renderer/src/settings-account-rename-decision";
import { CATALOGS } from "../../src/shared/i18n";

const personal = { id: "p1", name: "Pessoal", kind: "personal" as const, teamId: null };
const team = { id: "p2", name: "Idy", kind: "team" as const, teamId: "t1" };
const known = (role: "owner" | "admin" | "member"): RoleReading => ({ state: "known", role });

describe("decideAccountRename — who can rename an account profile", () => {
  it("the personal profile: always, whatever the team roles say", () => {
    expect(decideAccountRename({ profile: personal, online: true, role: { state: "checking" } })).toEqual({ can: true });
    expect(decideAccountRename({ profile: personal, online: true, role: { state: "unavailable" } })).toEqual({ can: true });
  });

  it("a team profile: owner and admin only", () => {
    expect(decideAccountRename({ profile: team, online: true, role: known("owner") })).toEqual({ can: true });
    expect(decideAccountRename({ profile: team, online: true, role: known("admin") })).toEqual({ can: true });
    expect(decideAccountRename({ profile: team, online: true, role: known("member") })).toEqual({ can: false, reason: "role" });
  });

  it("while the role is being read the button waits; if it cannot be read, it says offline", () => {
    expect(decideAccountRename({ profile: team, online: true, role: { state: "checking" } })).toEqual({ can: false, reason: "checking" });
    expect(decideAccountRename({ profile: team, online: true, role: { state: "unavailable" } })).toEqual({ can: false, reason: "offline" });
  });

  it("offline blocks every profile, the personal one included", () => {
    expect(decideAccountRename({ profile: personal, online: false, role: known("owner") })).toEqual({ can: false, reason: "offline" });
    expect(decideAccountRename({ profile: team, online: false, role: known("owner") })).toEqual({ can: false, reason: "offline" });
  });

  it("a profile only listed from its team (no server row yet) is not renamed", () => {
    expect(decideAccountRename({ profile: { ...team, id: "team:t1" }, online: true, role: known("owner") })).toEqual({
      can: false,
      reason: "no-server-profile",
    });
  });

  it("reads the role from the member list of the signed-in account", () => {
    const members = [
      { accountId: "a", role: "owner" },
      { accountId: "b", role: "member" },
    ];
    expect(roleInTeam(members, "a")).toEqual(known("owner"));
    expect(roleInTeam(members, "b")).toEqual(known("member"));
    expect(roleInTeam(members, "z")).toEqual({ state: "unavailable" });
    expect(roleInTeam(members, null)).toEqual({ state: "unavailable" });
    expect(roleInTeam([{ accountId: "a", role: "root" }], "a")).toEqual({ state: "unavailable" });
  });

  it("every reason has a text in both languages", () => {
    for (const key of [...Object.values(ACCOUNT_RENAME_BLOCK_KEY), ...Object.values(ACCOUNT_RENAME_FAILURE_KEY)]) {
      expect(CATALOGS["pt-BR"][key], key).toBeTruthy();
      expect(CATALOGS.en[key], key).toBeTruthy();
    }
  });
});

describe("validateAccountProfileName — checked before the request leaves", () => {
  it("trims and accepts a normal name", () => {
    expect(validateAccountProfileName("  Trabalho ")).toEqual({ ok: true, name: "Trabalho" });
  });

  it("refuses empty, blank and non-string", () => {
    for (const bad of ["", "   ", null, undefined, 3, {}]) expect(validateAccountProfileName(bad)).toEqual({ ok: false, reason: "invalid-name" });
  });

  it("the limit is the app's, counted in characters", () => {
    expect(validateAccountProfileName("é".repeat(MAX_PROFILE_NAME_LENGTH)).ok).toBe(true);
    expect(validateAccountProfileName("é".repeat(MAX_PROFILE_NAME_LENGTH + 1).toString())).toEqual({ ok: false, reason: "invalid-name" });
    // one emoji is one character, as the server counts it
    expect(validateAccountProfileName("😀".repeat(MAX_PROFILE_NAME_LENGTH)).ok).toBe(true);
  });

  it("refuses control characters and line separators", () => {
    for (const bad of ["a\nb", "a\tb", "a\u0000b", "a\u001bb", "a\u007fb", "a b", "a b"]) {
      expect(validateAccountProfileName(bad)).toEqual({ ok: false, reason: "invalid-name" });
    }
  });
});

describe("accountRenameFailure — what the server's answer means", () => {
  it("maps each status the route documents", () => {
    expect(accountRenameFailure({ status: 400, code: "bad_request" })).toBe("invalid-name");
    expect(accountRenameFailure({ status: 401, code: "unauthorized" })).toBe("not-signed-in");
    expect(accountRenameFailure({ status: 403, code: "forbidden" })).toBe("forbidden");
    expect(accountRenameFailure({ status: 403, code: "human_session_required" })).toBe("forbidden");
    expect(accountRenameFailure({ status: 404, code: "not_found" })).toBe("not-found");
    expect(accountRenameFailure({ status: 409, code: "profile_name_taken" })).toBe("duplicate-name");
  });

  it("no answer is offline; a broken answer is a plain failure", () => {
    expect(accountRenameFailure({ status: 0, code: "network" })).toBe("offline");
    expect(accountRenameFailure({ status: 0, code: "timeout" })).toBe("offline");
    expect(accountRenameFailure({ status: 0, code: "invalid_response" })).toBe("failed");
    expect(accountRenameFailure({ status: 503, code: "unavailable" })).toBe("offline");
    expect(accountRenameFailure({ status: 500, code: "internal_error" })).toBe("failed");
    expect(accountRenameFailure({ status: 429, code: "rate_limited" })).toBe("failed");
  });
});
