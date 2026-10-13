/**
 * Settings › Perfis — who can rename a profile OF THE ACCOUNT, and what a
 * refusal says. Pure: the page passes what it knows (the connection, the role
 * in the team) and shows the answer; the server still decides every write.
 */

import type { AccountProfileRenameFailure } from "../../preload/index";
import type { AccountProfileView } from "./account-scope-decision";
import type { MessageKey } from "../../shared/i18n";

export type TeamRoleKnown = "owner" | "admin" | "member";

/** What the page knows of the person's seat in a team: not asked yet, unreadable, or a role. */
export type RoleReading = { state: "checking" } | { state: "unavailable" } | { state: "known"; role: TeamRoleKnown };

export type AccountRenameBlock = "no-server-profile" | "offline" | "role" | "checking";

export type AccountRenameGate = { can: true } | { can: false; reason: AccountRenameBlock };

/**
 * - the personal profile: always (the account is the only one who owns it);
 * - a team profile: only owner/admin of that team;
 * - a profile the server has not created yet (it is only listed from the team): not yet;
 * - no connection to the account: the name is stored on the server, so not now.
 */
export function decideAccountRename(input: { profile: AccountProfileView; online: boolean; role: RoleReading }): AccountRenameGate {
  if (input.profile.id.startsWith("team:")) return { can: false, reason: "no-server-profile" };
  if (!input.online) return { can: false, reason: "offline" };
  if (input.profile.kind !== "team") return { can: true };
  if (input.role.state === "checking") return { can: false, reason: "checking" };
  if (input.role.state === "unavailable") return { can: false, reason: "offline" };
  return input.role.role === "owner" || input.role.role === "admin" ? { can: true } : { can: false, reason: "role" };
}

/** The hint shown beside a disabled Rename button. */
export const ACCOUNT_RENAME_BLOCK_KEY: Record<AccountRenameBlock, MessageKey> = {
  "no-server-profile": "settings.profiles.accountNoServer",
  offline: "settings.profiles.accountOffline",
  role: "settings.profiles.accountRole",
  checking: "settings.profiles.accountChecking",
};

/** The text under the field when the server (or the check before it) refuses. */
export const ACCOUNT_RENAME_FAILURE_KEY: Record<AccountProfileRenameFailure, MessageKey> = {
  "invalid-name": "settings.profiles.invalid",
  "duplicate-name": "settings.profiles.accountDuplicate",
  forbidden: "settings.profiles.accountForbidden",
  "not-found": "settings.profiles.accountGone",
  offline: "settings.profiles.accountOfflineError",
  "not-signed-in": "settings.profiles.accountSignedOut",
  failed: "profiles.error.save-failed",
};

/** The role of the signed-in account in a team, from the team's member list. */
export function roleInTeam(members: readonly { accountId: string; role: string }[], accountId: string | null): RoleReading {
  if (accountId === null) return { state: "unavailable" };
  const mine = members.find((m) => m.accountId === accountId);
  if (!mine) return { state: "unavailable" };
  return mine.role === "owner" || mine.role === "admin" || mine.role === "member" ? { state: "known", role: mine.role } : { state: "unavailable" };
}
