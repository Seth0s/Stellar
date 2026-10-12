/**
 * Account scope — the one state behind the profile switcher and the content.
 *
 * A signed-in user looks at the app through ONE of two scopes: `local` (this
 * machine's sessions) or `account` (what comes from the account: inbox, team,
 * work home). The switcher and the content read the scope computed here, so
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

/** Account profile as the sidebar needs it: the personal one, or one per team. */
export type AccountProfileView = { id: string; name: string; kind: "personal" | "team"; teamId: string | null };

/** What the scope needs to know to shape the sidebar. `team` = the account profile in view is a team's. */
export type ScopeShape = { team?: boolean };

/**
 * Sidebar sections of a scope. Stats is the only one both share. The account
 * scope has its own Sessões; Time shows only under a team profile (what a role
 * may do inside it still comes from the server).
 */
export function scopeNavSections(scope: AccountScope, shape: ScopeShape = {}): AccountModeShellSection[] {
  if (scope === "local") return ["sessions", "stats"];
  return shape.team ? ["sessions", "inbox", "workhome", "team", "stats"] : ["sessions", "inbox", "workhome", "stats"];
}

/** Both scopes land on their Sessões. */
export function scopeLanding(_scope: AccountScope): "sessions" {
  return "sessions";
}

/** Whether a section belongs to the scope in view (the account page is account-only). */
export function sectionAllowedInScope(section: string, scope: AccountScope, shape: ScopeShape = {}): boolean {
  if (section === "account") return scope === "account";
  return (scopeNavSections(scope, shape) as string[]).includes(section);
}

// ---------------------------------------------------------------------------
// Account profiles (Pro, one per team) and the sessions that belong to them.
// ---------------------------------------------------------------------------

type RawAccountProfile = { id: string; kind: string; teamId: string | null; name: string };

/**
 * The account's profiles for the switcher: personal first, then teams by name.
 * A team the account belongs to always gets an entry, even when the server has
 * no profile row for it yet, so its Time section is never out of reach.
 */
export function accountProfilesFrom(
  raw: readonly RawAccountProfile[],
  teams: readonly { id: string; name: string }[] = [],
): AccountProfileView[] {
  const views = raw.map((p): AccountProfileView => ({
    id: p.id,
    name: p.name,
    kind: p.kind === "team" || p.teamId !== null ? "team" : "personal",
    teamId: p.teamId,
  }));
  const withProfile = new Set(views.map((v) => v.teamId).filter((id): id is string => id !== null));
  for (const team of teams) {
    if (!withProfile.has(team.id)) views.push({ id: `team:${team.id}`, name: team.name, kind: "team", teamId: team.id });
  }
  const rank = (p: AccountProfileView) => (p.kind === "personal" ? 0 : 1);
  return views.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * Whether the Time section shows. Under a team profile, always. Under the
 * personal one it is hidden — unless the account has no team at all: then Time
 * is where a team is created or joined, so hiding it would leave no way in.
 * (While the profile list is still unknown it stays hidden.)
 */
export function teamSectionVisible(selected: AccountProfileView | null, list: readonly AccountProfileView[], listKnown: boolean): boolean {
  if (selected?.kind === "team") return true;
  return listKnown && !list.some((p) => p.kind === "team");
}

/** The profile in view: the stored one if it still exists, else the personal one, else the first. */
export function effectiveAccountProfile(list: readonly AccountProfileView[], storedId: string | null): AccountProfileView | null {
  return list.find((p) => p.id === storedId) ?? list.find((p) => p.kind === "personal") ?? list[0] ?? null;
}

/** The last account-profile list the server gave, kept for an offline start. */
export type CachedAccountProfiles = { profiles: AccountProfileView[]; savedAtMs: number };

export function profilesCacheKey(profileId: string | null): string {
  return `ac.acctProfilesCache.${profileId ?? "default"}`;
}

export function readProfilesCache(storage: Pick<Storage, "getItem"> | null, profileId: string | null): CachedAccountProfiles | null {
  try {
    const raw = storage?.getItem(profilesCacheKey(profileId)) ?? null;
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { profiles?: unknown; savedAtMs?: unknown };
    if (!Array.isArray(parsed.profiles) || typeof parsed.savedAtMs !== "number") return null;
    const profiles = parsed.profiles.filter(
      (p): p is AccountProfileView =>
        typeof p === "object" && p !== null && typeof (p as AccountProfileView).id === "string" && typeof (p as AccountProfileView).name === "string" &&
        ((p as AccountProfileView).kind === "personal" || (p as AccountProfileView).kind === "team"),
    );
    return { profiles, savedAtMs: parsed.savedAtMs };
  } catch {
    return null;
  }
}

export function writeProfilesCache(storage: Pick<Storage, "setItem"> | null, profileId: string | null, value: CachedAccountProfiles): void {
  try {
    storage?.setItem(profilesCacheKey(profileId), JSON.stringify(value));
  } catch {
    /* storage unavailable: an offline start just has no list to show */
  }
}

export function accountProfileStorageKey(profileId: string | null): string {
  return `ac.acctProfile.${profileId ?? "default"}`;
}

export function readStoredAccountProfile(storage: Pick<Storage, "getItem"> | null, profileId: string | null): string | null {
  try {
    const raw = storage?.getItem(accountProfileStorageKey(profileId)) ?? null;
    return raw !== null && raw !== "" ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredAccountProfile(storage: Pick<Storage, "setItem"> | null, profileId: string | null, accountProfileId: string): void {
  try {
    storage?.setItem(accountProfileStorageKey(profileId), accountProfileId);
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
}

/** Which account profile each session (board) belongs to. A session absent from the map is local. */
export type SessionAssignments = Record<string, string>;

/** The owners the database holds: only the sessions that belong to an account profile. */
export function assignmentsFromRows(rows: readonly { id: string; account_profile_id?: string | null }[]): SessionAssignments {
  const out: SessionAssignments = {};
  for (const row of rows) if (typeof row.account_profile_id === "string" && row.account_profile_id !== "") out[row.id] = row.account_profile_id;
  return out;
}

// ---------------------------------------------------------------------------
// One-time move of the old renderer-side partition into the database.
// ---------------------------------------------------------------------------

/** The renderer storage key the partition used to live under (read once, then removed). */
export function legacyAssignmentsKey(profileId: string | null): string {
  return `ac.acctSessions.${profileId ?? "default"}`;
}

/**
 * Reads the old partition (board id → account profile id) and groups it by
 * owner, so each owner is written to the database in one call. Garbage reads
 * as nothing to move. `present` tells whether the key exists at all (an empty
 * or unreadable one is still removed).
 */
export function planLegacyMigration(raw: string | null): { present: boolean; groups: { owner: string; ids: string[] }[] } {
  if (raw === null) return { present: false, groups: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, groups: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { present: true, groups: [] };
  const byOwner = new Map<string, string[]>();
  for (const [boardId, owner] of Object.entries(parsed)) {
    if (typeof owner !== "string" || owner === "") continue;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), boardId]);
  }
  return { present: true, groups: [...byOwner].map(([owner, ids]) => ({ owner, ids })) };
}

/**
 * Moves the old renderer-side partition into the database and clears the old
 * key. Idempotent: with the key gone there is nothing to do; with a database
 * write that failed the key stays so the next start tries again.
 */
export async function migrateLegacyAssignments(
  storage: Pick<Storage, "getItem" | "removeItem"> | null,
  profileId: string | null,
  setOwner: (ids: string[], owner: string) => Promise<unknown>,
): Promise<{ moved: boolean }> {
  let raw: string | null;
  try {
    raw = storage?.getItem(legacyAssignmentsKey(profileId)) ?? null;
  } catch {
    return { moved: false };
  }
  const plan = planLegacyMigration(raw);
  if (!plan.present) return { moved: false };
  try {
    for (const group of plan.groups) await setOwner(group.ids, group.owner);
  } catch {
    return { moved: false };
  }
  try {
    storage?.removeItem(legacyAssignmentsKey(profileId));
  } catch {
    /* storage unavailable: the next start sees the same key and writes the same owners */
  }
  return { moved: plan.groups.length > 0 };
}

export type SessionsView = { scope: "local" } | { scope: "account"; accountProfileId: string | null };

/**
 * The sessions of a view. Local shows what no account profile owns; an account
 * profile shows only its own. The two never mix.
 */
export function partitionBoards<T extends { id: string }>(boards: readonly T[], assignments: SessionAssignments, view: SessionsView): T[] {
  if (view.scope === "local") return boards.filter((b) => assignments[b.id] === undefined);
  return boards.filter((b) => assignments[b.id] !== undefined && assignments[b.id] === view.accountProfileId);
}

/** Drops the entries of sessions that no longer exist. Returns the same object when nothing changed. */
export function pruneAssignments(assignments: SessionAssignments, existingIds: ReadonlySet<string>): SessionAssignments {
  const kept = Object.entries(assignments).filter(([boardId]) => existingIds.has(boardId));
  return kept.length === Object.keys(assignments).length ? assignments : Object.fromEntries(kept);
}

/** Moves the given sessions to an account profile. */
export function assignBoards(assignments: SessionAssignments, boardIds: readonly string[], accountProfileId: string): SessionAssignments {
  const next = { ...assignments };
  for (const id of boardIds) next[id] = accountProfileId;
  return next;
}

/** Ids present now that were not in `before`: the session that just got created. */
export function newBoardIds(before: ReadonlySet<string>, boards: readonly { id: string }[]): string[] {
  return boards.filter((b) => !before.has(b.id)).map((b) => b.id);
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
