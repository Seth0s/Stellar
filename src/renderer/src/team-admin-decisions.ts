/**
 * TEAM ADMINISTRATION — the pure decisions the team screens read: seats, who
 * may change or remove whom (an exact mirror of the server rules, the server
 * stays the authority), the last-owner lock, invite expiry, the delete
 * confirmation, and the invite dialog's step.
 */

import type { TeamInviteInfo, TeamMemberInfo, TeamRole, TeamSeatsInfo } from "../../preload/index";

const RANK: Record<TeamRole, number> = { owner: 3, admin: 2, member: 1 };

export function canManageMembers(role: TeamRole | null): boolean {
  return role !== null && RANK[role] >= RANK.admin;
}

/** Renaming the team is an admin+ action. */
export function canRenameTeam(role: TeamRole | null): boolean {
  return canManageMembers(role);
}

/** Deleting the team is owner-only. */
export function canDeleteTeam(role: TeamRole | null): boolean {
  return role === "owner";
}

// ---- seats --------------------------------------------------------------------

export type SeatsView =
  /** No plan on the team: there is no seat limit to show. */
  | { kind: "unlimited" }
  | { kind: "open"; used: number; total: number }
  | { kind: "full"; used: number; total: number };

export function seatsView(seats: TeamSeatsInfo | null): SeatsView {
  if (seats === null) return { kind: "unlimited" };
  return seats.used >= seats.total ? { kind: "full", used: seats.used, total: seats.total } : { kind: "open", used: seats.used, total: seats.total };
}

// ---- members ------------------------------------------------------------------

export function ownerCount(members: readonly TeamMemberInfo[]): number {
  return members.filter((m) => m.role === "owner").length;
}

export type MemberRowState = {
  /** The role select is usable. */
  canChangeRole: boolean;
  /** Why the select is locked, when it is: shown as its title. */
  roleLock: "last-owner" | "permission" | null;
  /** Roles the select offers for this row. */
  roleOptions: TeamRole[];
  /** The one action the row offers: leave (own row) or remove (someone else). */
  action: "leave" | "remove" | null;
  /** The action exists but is blocked (the last owner cannot leave). */
  actionLock: "last-owner" | null;
};

/**
 * What a member row offers the signed-in person. Mirrors the server: an admin
 * only manages plain members and never grants owner; an owner manages anyone;
 * anyone may leave; the last owner can neither be demoted nor leave.
 */
export function memberRowState(input: {
  members: readonly TeamMemberInfo[];
  member: TeamMemberInfo;
  accountId: string | null;
  myRole: TeamRole | null;
}): MemberRowState {
  const { members, member, accountId, myRole } = input;
  const isSelf = accountId !== null && member.accountId === accountId;
  const lastOwner = member.role === "owner" && ownerCount(members) <= 1;

  let roleOptions: TeamRole[] = [];
  if (myRole === "owner") roleOptions = ["owner", "admin", "member"];
  else if (myRole === "admin" && member.role === "member") roleOptions = ["member", "admin"];
  if (roleOptions.length > 0 && !roleOptions.includes(member.role)) roleOptions = [...roleOptions, member.role];

  const mayChange = roleOptions.length > 1;
  const canChangeRole = mayChange && !lastOwner;
  const roleLock: MemberRowState["roleLock"] = canChangeRole ? null : lastOwner && mayChange ? "last-owner" : "permission";

  let action: MemberRowState["action"] = null;
  if (isSelf) action = "leave";
  else if (myRole === "owner" || (myRole === "admin" && member.role === "member")) action = "remove";
  const actionLock: MemberRowState["actionLock"] = action !== null && lastOwner ? "last-owner" : null;

  return { canChangeRole, roleLock, roleOptions, action, actionLock };
}

// ---- invites ------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left on an invite (rounded up); `null` without a valid date. */
export function inviteDaysLeft(invite: Pick<TeamInviteInfo, "expiresAt">, now: number): number | null {
  if (!invite.expiresAt) return null;
  const at = Date.parse(invite.expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

/** The roles an invite may carry (the prototype offers member and admin). */
export const INVITE_ROLES: readonly TeamRole[] = ["member", "admin"];

// ---- settings -----------------------------------------------------------------

/** The delete button unlocks only on the exact slug. */
export function slugMatches(input: string, slug: string): boolean {
  return slug !== "" && input.trim() === slug;
}

// ---- invite dialog ------------------------------------------------------------

/** Mirror of how the server masks an invite target: first letter + `***`. */
export function maskIdentity(identity: string): string {
  const value = identity.trim();
  if (value === "") return "";
  const at = value.indexOf("@");
  return at < 0 ? `${value.charAt(0)}***` : `${value.charAt(0)}***${value.slice(at)}`;
}

/** Does any identity the account holds mask to the invite's masked target? A
 *  necessary condition only: the server still decides on accept. With nothing to
 *  compare (no masked target, or no identity read) it does not rule anything out. */
export function identityMatchesInvite(identities: readonly string[], targetMasked: string): boolean {
  if (targetMasked === "" || identities.length === 0) return true;
  const wanted = targetMasked.toLowerCase();
  return identities.some((id) => maskIdentity(id).toLowerCase() === wanted);
}

export type InviteStep = "loading" | "unavailable" | "signin" | "accept" | "wrong-id" | "joined";

export function inviteStep(input: {
  previewState: "loading" | "ready" | "unavailable";
  loggedIn: boolean;
  identityMatches: boolean;
  serverMismatch: boolean;
  joined: boolean;
}): InviteStep {
  if (input.joined) return "joined";
  if (input.previewState === "loading") return "loading";
  if (input.previewState === "unavailable") return "unavailable";
  if (!input.loggedIn) return "signin";
  return input.serverMismatch || !input.identityMatches ? "wrong-id" : "accept";
}

// ---- tiny template splitting (bold / mono slots inside a translated string) ----

export type TemplatePart = { text: string } | { slot: string };

/** Splits `"{who} did it"` into text and slot parts, so a screen can wrap a slot
 *  in its own element without breaking the sentence across several keys. */
export function splitTemplate(template: string): TemplatePart[] {
  const out: TemplatePart[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(template); m !== null; m = re.exec(template)) {
    if (m.index > last) out.push({ text: template.slice(last, m.index) });
    out.push({ slot: m[1] });
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last) });
  return out;
}

// ---- opening a team section from outside the team page --------------------------

export const TEAM_OPEN_SUB_KEY = "stellar.team.openSub";

/** Asks the next team page mount to open on `sub` (the invite dialog's "open the
 *  team board"). Best effort: storage may be unavailable. */
export function requestTeamSub(sub: string, storage: Pick<Storage, "setItem"> | null = safeSession()): void {
  try {
    storage?.setItem(TEAM_OPEN_SUB_KEY, sub);
  } catch {
    /* storage unavailable: the team page just opens on its default */
  }
}

export function consumeTeamSub(storage: Pick<Storage, "getItem" | "removeItem"> | null = safeSession()): string | null {
  try {
    const value = storage?.getItem(TEAM_OPEN_SUB_KEY) ?? null;
    if (value !== null) storage?.removeItem(TEAM_OPEN_SUB_KEY);
    return value;
  } catch {
    return null;
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
