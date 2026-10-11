/**
 * Account mode — single source of truth for "has a cloud account".
 *
 * The live status is `window.cloud.status` (`logged-in` vs not). UI, shortcuts,
 * deep links and command palettes ask these helpers instead of re-checking
 * `state === "logged-in"` inline.
 */

import type { SettingsNavEntry, SettingsPageId } from "./settings-nav-decision";

/**
 * Stable machine code written into `CloudStatus.lastError` by cloud-auth.
 * Keep in sync with `SIGNUP_CLOSED_ERROR` in cloud-auth-decision.ts.
 */
export const SIGNUP_CLOSED_ERROR = "signup_closed";

/** i18n key shown when a cloud-only surface is opened without an account. */
export const CLOUD_FEATURE_NOTICE_KEY = "account.needLogin" as const;

/** Shell sections that require a cloud account (mirrors ShellSection ids). */
export type CloudGatedShellSection = "inbox" | "workhome" | "team" | "account";

/** All shell section ids the account-mode nav can emit. */
export type AccountModeShellSection = "sessions" | "stats" | CloudGatedShellSection;

/** Shell nav sections that require a cloud account. */
export const CLOUD_SHELL_SECTIONS: readonly CloudGatedShellSection[] = ["inbox", "workhome", "team", "account"];

/** Settings pages that require a cloud account to appear in the nav. */
export const CLOUD_SETTINGS_PAGES: readonly SettingsPageId[] = ["team"];

/** Ctrl+K commands that only make sense with a cloud account. */
export const CLOUD_BOARD_CMD_IDS = ["new-team", "distribute", "import"] as const;

export type CloudStatusLike = { state: string } | null | undefined;

/** True only when the cloud status is fully signed in. */
export function hasCloudAccount(status: CloudStatusLike): boolean {
  return status?.state === "logged-in";
}

/** True when `lastError` is the signup-closed machine code. */
export function isSignupClosedError(lastError: string | null | undefined): boolean {
  return lastError === SIGNUP_CLOSED_ERROR;
}

/**
 * Shell nav rows for the current account mode. Sessions and stats always stay;
 * cloud sections disappear when there is no cloud account.
 */
export function shellNavSections(hasAccount: boolean): AccountModeShellSection[] {
  if (!hasAccount) return ["sessions", "stats"];
  return ["sessions", "inbox", "workhome", "team", "stats"];
}

/** Drop cloud-only settings entries when the account is local. */
export function settingsNavForAccountMode(
  entries: readonly SettingsNavEntry[],
  hasAccount: boolean,
): SettingsNavEntry[] {
  if (hasAccount) return [...entries];
  return entries.filter((e) => !CLOUD_SETTINGS_PAGES.includes(e.id));
}

/**
 * Gate a cloud-only feature. Callers toast `CLOUD_FEATURE_NOTICE_KEY` on deny
 * and do not open the surface.
 */
export function gateCloudFeature(hasAccount: boolean): { ok: true } | { ok: false; noticeKey: typeof CLOUD_FEATURE_NOTICE_KEY } {
  if (hasAccount) return { ok: true };
  return { ok: false, noticeKey: CLOUD_FEATURE_NOTICE_KEY };
}

/** Whether the shell should leave a cloud section after logout. */
export function shouldResetShellSection(section: string, hasAccount: boolean): boolean {
  return !hasAccount && (CLOUD_SHELL_SECTIONS as readonly string[]).includes(section);
}
