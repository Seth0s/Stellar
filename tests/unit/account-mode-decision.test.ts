import { describe, expect, it } from "vitest";
import {
  CLOUD_FEATURE_NOTICE_KEY,
  gateCloudFeature,
  hasCloudAccount,
  isSignupClosedError,
  settingsNavForAccountMode,
  shellNavSections,
  shouldResetShellSection,
  SIGNUP_CLOSED_ERROR,
} from "../../src/renderer/src/account-mode-decision";
import { SETTINGS_NAV, settingsNavForScope } from "../../src/renderer/src/settings-nav-decision";
import { decideCallback } from "../../src/main/cloud-auth-decision";

describe("account-mode-decision", () => {
  it("hasCloudAccount is true only for logged-in", () => {
    expect(hasCloudAccount(null)).toBe(false);
    expect(hasCloudAccount({ state: "logged-out" })).toBe(false);
    expect(hasCloudAccount({ state: "pending" })).toBe(false);
    expect(hasCloudAccount({ state: "logged-in" })).toBe(true);
  });

  it("local shell nav hides inbox, workhome and team", () => {
    expect(shellNavSections(false)).toEqual(["sessions", "stats"]);
    expect(shellNavSections(true)).toEqual(["sessions", "inbox", "workhome", "team", "stats"]);
  });

  it("settings nav drops team without a cloud account", () => {
    const board = settingsNavForScope("board");
    expect(settingsNavForAccountMode(board, false).map((e) => e.id)).toEqual(["mode", "rules"]);
    expect(settingsNavForAccountMode(board, true).map((e) => e.id)).toEqual(["mode", "rules", "team"]);
    expect(settingsNavForAccountMode(SETTINGS_NAV, false).some((e) => e.id === "team")).toBe(false);
  });

  it("gateCloudFeature denies with a single notice key", () => {
    expect(gateCloudFeature(true)).toEqual({ ok: true });
    expect(gateCloudFeature(false)).toEqual({ ok: false, noticeKey: CLOUD_FEATURE_NOTICE_KEY });
  });

  it("resets cloud shell sections after logout", () => {
    expect(shouldResetShellSection("team", false)).toBe(true);
    expect(shouldResetShellSection("sessions", false)).toBe(false);
    expect(shouldResetShellSection("team", true)).toBe(false);
  });

  it("recognizes signup_closed lastError", () => {
    expect(isSignupClosedError(SIGNUP_CLOSED_ERROR)).toBe(true);
    expect(isSignupClosedError("o provedor recusou o login")).toBe(false);
  });

  it("decideCallback maps signup_closed for the login transport", () => {
    expect(decideCallback({ state: "S", error: "signup_closed" }, "S")).toEqual({
      kind: "error",
      reason: "signup-closed",
    });
  });
});
