/**
 * TEAMS IN THE APP — the pure DECISION layer, no I/O.
 *
 * Everything testable without network, clock or disk: roles and permissions (an
 * EXACT mirror of the backend rules), reading the team replies from `/me` and
 * from the detail endpoint, classifying an invite target, the team FILE PREFIX
 * for materialized paths, the filter that keeps memory out of the base, and the
 * `stellar://invite` deep link.
 *
 * The I/O shell is `team.ts`; the wiring is `team-ipc.ts`.
 *
 * BACKEND RULES THIS MODULE MIRRORS:
 *  - an admin only manages `member`; only an `owner` grants `owner`;
 *  - at least one owner always remains (the backend enforces it; here it is
 *    only the UI permission);
 *  - an invite target is an email OR a GitHub login;
 *  - the team base carries rules/skills/agents/config — NEVER memory nor the
 *    `stellar` bundle (a provider declaration is personal).
 */

import { isOpaqueId } from "./local-identity-decision";
import {
  buildManifest,
  markerTool,
  type WorkHomeManifest,
  type WorkHomeManifestEntry,
} from "./work-home-manifest";
import { isTemplatedContentPath } from "./work-home-tools";
import type { WorkHomeApplyPlan, WorkHomeApplyPlanItem } from "./work-home-apply-decision";

// ---------------------------------------------------------------------------
// Roles and permissions (mirror of internal/team: rank / ChangeRole / RemoveMember)
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "admin" | "member";
export const TEAM_ROLES: readonly TeamRole[] = ["owner", "admin", "member"];

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

/** Same scale as the backend: owner 3 > admin 2 > member 1. */
export function teamRoleRank(role: TeamRole): number {
  return role === "owner" ? 3 : role === "admin" ? 2 : 1;
}

/** Publishing the base and managing invites/members requires admin or owner. */
export function canManageTeam(role: TeamRole): boolean {
  return teamRoleRank(role) >= teamRoleRank("admin");
}

export function canPublishTeamHouse(role: TeamRole): boolean {
  return canManageTeam(role);
}

/**
 * Mirror of `ChangeRole`: an admin only manages `member` and never grants
 * `owner`; an owner can do anything. The last-owner rule lives in the backend
 * (it needs the database), not here.
 */
export function canChangeTeamRole(caller: TeamRole, target: TeamRole, next: TeamRole): boolean {
  if (teamRoleRank(caller) < teamRoleRank("admin")) return false;
  if (caller === "admin" && (teamRoleRank(target) >= teamRoleRank("admin") || next === "owner")) return false;
  return true;
}

/**
 * Mirror of `RemoveMember`: anyone can leave (`isSelf`); an admin only removes
 * `member`; an owner removes admin/member. The last owner is blocked in the
 * backend.
 */
export function canRemoveTeamMember(caller: TeamRole, target: TeamRole, isSelf: boolean): boolean {
  if (isSelf) return true;
  if (teamRoleRank(caller) < teamRoleRank("admin")) return false;
  if (caller === "admin" && teamRoleRank(target) >= teamRoleRank("admin")) return false;
  return true;
}

/** Role of the signed-in account in a team detail; `null` when not a member. */
export function accountRoleIn(detail: { members: readonly TeamMemberView[] }, accountId: string): TeamRole | null {
  return detail.members.find((m) => m.accountId === accountId)?.role ?? null;
}

/**
 * Does this team-endpoint error mean the CALLER lost membership (was removed)?
 * Mirrors the backend: a removed account no longer has a membership row, so
 * every team-scoped call answers 404 `not found`. A 403 is a ROLE refusal
 * (`forbidden`) or an invite for another account (`invite_target_mismatch`) —
 * NOT a removal, and turning the profile off on it would be a false statement.
 * So the profile is turned off on 404, and on a 403 only when its code is not
 * one of those two known role codes.
 */
export function teamErrorMeansDetached(status: number, code: string): boolean {
  if (status === 404) return true;
  if (status === 403) return code !== "forbidden" && code !== "invite_target_mismatch";
  return false;
}

// ---------------------------------------------------------------------------
// Reading the backend replies
// ---------------------------------------------------------------------------

export type TeamSummary = { id: string; name: string; slug: string };
export type TeamMemberView = {
  accountId: string;
  role: TeamRole;
  joinedAt: string | null;
  /** B7.1: display name and avatar initials; `email` only comes for owner/admin. */
  displayName: string;
  avatarInitials: string;
  email: string | null;
};
export type TeamProfileRef = { id: string; kind: string; teamId: string | null; name: string };
export type TeamListView = {
  accountId: string | null;
  displayName: string;
  teams: TeamSummary[];
  profiles: TeamProfileRef[];
  identitySubjects: string[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `pgtype.Timestamp*` marshals an RFC3339 string or null; anything else is null. */
function asTimestamp(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseTeamSummary(value: unknown): TeamSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!isOpaqueId(rec.id)) return null;
  if (typeof rec.name !== "string" || typeof rec.slug !== "string" || rec.slug === "") return null;
  return { id: rec.id, name: rec.name, slug: rec.slug };
}

/**
 * Reads `/me` with teams and profiles. A null `team_id` means a personal
 * profile. Missing fields do not break the read; what does not match is
 * dropped, never "repaired".
 */
export function parseTeamListView(raw: unknown): TeamListView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const teams: TeamSummary[] = [];
  if (Array.isArray(rec.teams)) {
    for (const item of rec.teams) {
      const parsed = parseTeamSummary(item);
      if (parsed) teams.push(parsed);
    }
  }

  const profiles: TeamProfileRef[] = [];
  if (Array.isArray(rec.profiles)) {
    for (const item of rec.profiles) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const p = item as Record<string, unknown>;
      if (!isOpaqueId(p.id)) continue;
      profiles.push({
        id: p.id,
        kind: typeof p.kind === "string" ? p.kind : "unknown",
        teamId: isOpaqueId(p.team_id) ? p.team_id : null,
        name: typeof p.name === "string" ? p.name : "",
      });
    }
  }

  const identitySubjects: string[] = [];
  if (Array.isArray(rec.identities)) {
    for (const item of rec.identities) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const i = item as Record<string, unknown>;
      if (typeof i.subject === "string" && i.subject !== "") identitySubjects.push(i.subject);
      const login = asString(i.login);
      if (login !== null) identitySubjects.push(login);
    }
  }

  const account = typeof rec.account === "object" && rec.account !== null ? (rec.account as Record<string, unknown>) : {};
  const rawName = asString(account.display_name);
  const identityLogin = Array.isArray(rec.identities)
    ? rec.identities
        .map((item) => (typeof item === "object" && item !== null ? asString((item as Record<string, unknown>).login) : null))
        .find((v): v is string => v !== null) ?? null
    : null;

  return {
    accountId: isOpaqueId(account.id) ? account.id : null,
    displayName: rawName ?? identityLogin ?? "",
    teams,
    profiles,
    identitySubjects,
  };
}

export type TeamDetailView = { team: TeamSummary; members: TeamMemberView[] };

/** One member row. B7.1 carries `display_name`/`avatar_initials` (and `email`
 *  for owner/admin); older replies simply leave them blank. */
export function parseTeamMember(raw: unknown): TeamMemberView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (!isOpaqueId(m.account_id) || !isTeamRole(m.role)) return null;
  return {
    accountId: m.account_id,
    role: m.role,
    joinedAt: asTimestamp(m.joined_at),
    displayName: typeof m.display_name === "string" ? m.display_name : "",
    avatarInitials: typeof m.avatar_initials === "string" ? m.avatar_initials : "",
    email: asString(m.email),
  };
}

export function parseTeamDetail(raw: unknown): TeamDetailView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const team = parseTeamSummary(rec.team);
  if (!team) return null;
  const members: TeamMemberView[] = [];
  if (Array.isArray(rec.members)) {
    for (const item of rec.members) {
      const parsed = parseTeamMember(item);
      if (parsed) members.push(parsed);
    }
  }
  return { team, members };
}

export type TeamInviteView = { id: string; teamId: string; target: string; role: TeamRole };

export function parseTeamInvite(raw: unknown): TeamInviteView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!isOpaqueId(rec.id) || !isOpaqueId(rec.team_id)) return null;
  if (typeof rec.target !== "string" || !isTeamRole(rec.role)) return null;
  return { id: rec.id, teamId: rec.team_id, target: rec.target, role: rec.role };
}

/** GET /v1/teams/{id}/invites -> `{ invites: [...] }` (owner/admin). */
export function parseTeamInviteList(raw: unknown): TeamInviteView[] {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const invites: TeamInviteView[] = [];
  if (Array.isArray(rec.invites)) {
    for (const item of rec.invites) {
      const parsed = parseTeamInvite(item);
      if (parsed) invites.push(parsed);
    }
  }
  return invites;
}

// ---------------------------------------------------------------------------
// Invite target (mirror of resolveInviteTarget/emailPattern/loginPattern)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type InviteTargetKind = "email" | "github" | "invalid";

export function classifyInviteTarget(target: string): InviteTargetKind {
  const trimmed = target.trim();
  if (trimmed === "") return "invalid";
  if (trimmed.includes("@")) return EMAIL_RE.test(trimmed) ? "email" : "invalid";
  return GITHUB_LOGIN_RE.test(trimmed) ? "github" : "invalid";
}

// ---------------------------------------------------------------------------
// Team prefix and base filter
// ---------------------------------------------------------------------------

/**
 * Segments that GROUP additional items under a tool root. The prefix goes on
 * the ITEM (the next segment), not on the container: a team cannot rename
 * `skills/` to `team-acme-skills/`, or the CLI would stop finding the skills.
 * Outside these containers (a rule file at the root, settings) the prefix goes
 * on the file name itself.
 */
export const TEAM_CONTAINER_SEGMENTS: readonly string[] = ["skills", "agents", "commands", "rules"];

/** The materialized prefix: `team-<slug>-`. */
export function teamFilePrefix(slug: string): string {
  return `team-${slug}-`;
}

/** Last segment of a posix path, ignoring a trailing slash. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

function prefixBasename(path: string, prefix: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? `${prefix}${path}` : `${path.slice(0, at + 1)}${prefix}${path.slice(at + 1)}`;
}

/**
 * Materializes a team LOGICAL path into the LOCAL path, with the team prefix.
 * The server merges/stores by the path as it came; applying the prefix is the
 * app's job — this function is the only place that does it.
 *
 *   `{claude}/skills/foo/SKILL.md` -> `{claude}/skills/team-acme-foo/SKILL.md`
 *   `{claude}/CLAUDE.md`           -> `{claude}/team-acme-CLAUDE.md`
 *   `{codex}/config.toml`          -> UNCHANGED: the name is functional, so the
 *                                     member's own config is never overwritten
 *                                     by the team's.
 *
 * A memory path (`{project:...}`) never reaches here: publishing blocks it.
 */
export function applyTeamPrefix(logicalPath: string, slug: string): string {
  if (isTemplatedContentPath(logicalPath)) return logicalPath;
  const prefix = teamFilePrefix(slug);
  const close = logicalPath.startsWith("{") ? logicalPath.indexOf("}") : -1;
  if (close < 0) return basename(logicalPath) === "" ? logicalPath : prefixBasename(logicalPath, prefix);

  const marker = logicalPath.slice(0, close + 1);
  const rel = logicalPath.slice(close + 1).replace(/^\/+/, "");
  if (rel === "") return logicalPath;
  const segs = rel.split("/");
  const isContainer = segs.length >= 2 && TEAM_CONTAINER_SEGMENTS.includes(segs[0].toLowerCase());
  if (isContainer) segs[1] = `${prefix}${segs[1]}`;
  else segs[segs.length - 1] = `${prefix}${segs[segs.length - 1]}`;
  return `${marker}/${segs.join("/")}`;
}

/** Segments that NEVER travel in a team base (mirror of the backend rule). */
const TEAM_FORBIDDEN_SEGMENTS = new Set([
  "memory",
  "memories",
  "sessions",
  "history",
  "chats",
  "transcripts",
]);

/** The `stellar` bundle (a provider declaration) is personal: never in the base. */
export function isTeamForbiddenPath(logicalPath: string): boolean {
  if (markerTool(logicalPath) === "stellar") return true;
  for (const segment of logicalPath.split("/")) {
    if (TEAM_FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  return false;
}

/**
 * Filters a collected house down to a team base: out go memories, sessions,
 * history, chats and the `stellar` bundle. What is dropped is returned in
 * `dropped` — absence is STATED, never silent.
 */
export function teamSafeManifest(manifest: WorkHomeManifest): { manifest: WorkHomeManifest; dropped: string[] } {
  const dropped: string[] = [];
  const entries: WorkHomeManifestEntry[] = [];
  for (const entry of manifest.entries) {
    if (isTeamForbiddenPath(entry.path)) dropped.push(entry.path);
    else entries.push(entry);
  }
  const removals: string[] = [];
  for (const path of manifest.removals) {
    if (isTeamForbiddenPath(path)) dropped.push(path);
    else removals.push(path);
  }
  return { manifest: buildManifest(entries, removals), dropped };
}

function emptySummary(): WorkHomeApplyPlan["summary"] {
  return { add: 0, update: 0, unchanged: 0, keepLocal: 0, conflict: 0, pending: 0, remove: 0 };
}

/**
 * The member layer sits on top for CONFIGURATION files (settings, which carry
 * no prefix): a team config only FILLS A GAP, so a conflict with what the
 * member already has becomes `keep-local`. Without this, applying the team base
 * would flag the member's own config as a conflict and could overwrite it.
 */
export function preferLocalForTeamConfig(plan: WorkHomeApplyPlan): WorkHomeApplyPlan {
  let changed = false;
  const items: WorkHomeApplyPlanItem[] = plan.items.map((item) => {
    if (item.action === "conflict" && isTemplatedContentPath(item.path)) {
      changed = true;
      return { ...item, action: "keep-local", reason: "member config wins" };
    }
    return item;
  });
  if (!changed) return plan;
  const summary = emptySummary();
  for (const item of items) {
    if (item.action === "add") summary.add++;
    else if (item.action === "update") summary.update++;
    else if (item.action === "unchanged") summary.unchanged++;
    else if (item.action === "keep-local") summary.keepLocal++;
    else if (item.action === "conflict") summary.conflict++;
    else if (item.action === "remove") summary.remove++;
    else summary.pending++;
  }
  return { items, summary };
}

/** Base entries already prefixed, ready for the applier. */
export function prefixTeamManifest(manifest: WorkHomeManifest, slug: string): WorkHomeManifest {
  return buildManifest(
    manifest.entries.map((entry) => ({ ...entry, path: applyTeamPrefix(entry.path, slug) })),
    manifest.removals.map((path) => applyTeamPrefix(path, slug)),
  );
}

// ---------------------------------------------------------------------------
// Deep link `stellar://invite?token=...`
// ---------------------------------------------------------------------------

export type StellarDeepLink = { kind: "invite"; token: string };

/**
 * Reads the link that opens the app. Accepts `stellar://invite?token=...` and
 * the form without `//` (`stellar:invite?token=...`). An empty token is not an
 * invite: it returns `null` instead of an invented target.
 */
export function parseDeepLink(raw: string): StellarDeepLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "stellar:") return null;
  const host = url.host !== "" ? url.host : url.pathname.replace(/^\/+/, "").split("/")[0];
  if (host !== "invite") return null;
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (token === "") return null;
  return { kind: "invite", token };
}
