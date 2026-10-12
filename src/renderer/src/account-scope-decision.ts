/**
 * Account scope — the one state behind the profile selector, the sidebar
 * footer and the Home.
 *
 * A signed-in user looks at the app through ONE of two scopes: `local` (this
 * machine's sessions) or `account` (what comes from the account: inbox, team,
 * work home). Selector, footer and Home all read the scope computed here, so
 * they cannot disagree. Without an account the scope is always `local`.
 */

import type { MessageKey } from "../../shared/i18n";
import type { AccountModeShellSection } from "./account-mode-decision";

export type AccountScope = "local" | "account";

export function isAccountScope(value: unknown): value is AccountScope {
  return value === "local" || value === "account";
}

/**
 * The scope in effect. No account → `local`. With an account, the user's last
 * choice for this profile; with no choice yet, `account` (they just signed in).
 */
export function effectiveScope(loggedIn: boolean, stored: AccountScope | null): AccountScope {
  if (!loggedIn) return "local";
  return stored ?? "account";
}

/** Sidebar sections of a scope. Stats is the only one both share. */
export function scopeNavSections(scope: AccountScope): AccountModeShellSection[] {
  return scope === "account" ? ["inbox", "workhome", "team", "stats"] : ["sessions", "stats"];
}

/** Where a scope lands: local sessions, or the account's work home (the inbox
 *  swaps the sidebar footer for its own preferences, so it is not a landing). */
export function scopeLanding(scope: AccountScope): "sessions" | "workhome" {
  return scope === "account" ? "workhome" : "sessions";
}

/** Whether a section belongs to the scope (the account page is the footer's target). */
export function sectionAllowedInScope(section: string, scope: AccountScope): boolean {
  if (section === "account") return scope === "account";
  return (scopeNavSections(scope) as string[]).includes(section);
}

/** Footer subtitle under the account name for a scope. */
export function scopeFooterSubKey(scope: AccountScope): MessageKey {
  return scope === "account" ? "shell.accountSub" : "shell.accountSub.local";
}

export function scopeStorageKey(profileId: string | null): string {
  return `ac.scope.${profileId ?? "default"}`;
}

/** Reads the stored choice; a missing, unreadable or invalid value is `null`. */
export function readStoredScope(storage: Pick<Storage, "getItem"> | null, profileId: string | null): AccountScope | null {
  try {
    const raw = storage?.getItem(scopeStorageKey(profileId)) ?? null;
    return isAccountScope(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredScope(storage: Pick<Storage, "setItem"> | null, profileId: string | null, scope: AccountScope): void {
  try {
    storage?.setItem(scopeStorageKey(profileId), scope);
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
}
