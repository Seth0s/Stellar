/**
 * TEAM PAGE LOAD — what each section of the page is, right now.
 *
 * The page no longer waits for the whole backend answer to paint: it paints at
 * once and every section fills in when ITS answer arrives. This file is the pure
 * decision of what a section shows — loading (skeleton), ready, error or stale
 * (cache, marked out of date, with the time it was last refreshed, the same
 * wording the account uses offline) — plus the shape of the on-machine cache.
 * No React, no storage, no clock: the caller passes the facts.
 */

import { formatStaleStamp } from "./account-display-decision";

/** The parts of the page that depend on the backend, each with its own request. */
export type TeamSection = "overview" | "detail" | "sprints" | "invites" | "tasks";

/** Sections that belong to the SELECTED team (the overview is the account's). */
export const TEAM_SCOPED_SECTIONS: readonly Exclude<TeamSection, "overview">[] = ["detail", "sprints", "invites", "tasks"];

/** How many placeholder cards each board column gets while the tasks load (a fixed rhythm, not data). */
export const COLUMN_SKELETON_CARDS: readonly number[] = [2, 2, 1, 1];

export type SectionState = "loading" | "ready" | "error" | "stale";

/** Where the data on screen came from: nowhere yet, the on-machine cache, or the backend. */
export type SectionSource = "none" | "cache" | "live";

export type SectionRecord = {
  source: SectionSource;
  /** A request for this section is out. */
  inFlight: boolean;
  /** The last request failed with this message (cleared when a new one starts). */
  error: string | null;
  /** When the data on screen was last confirmed by the backend (cache: when it was saved). */
  savedAtMs: number | null;
};

export const EMPTY_SECTION: SectionRecord = { source: "none", inFlight: false, error: null, savedAtMs: null };

/**
 * - no data yet: `loading` until the request fails, then `error`;
 * - data from the cache: always `stale` — only the backend can make it `ready`;
 * - data from the backend: `ready`, unless the latest refresh failed (`stale`:
 *   the data is still shown, but it is no longer confirmed).
 */
export function decideSectionState(rec: SectionRecord): SectionState {
  if (rec.source === "none") return rec.error !== null ? "error" : "loading";
  if (rec.source === "cache") return "stale";
  return rec.error !== null ? "stale" : "ready";
}

/** A request starts. Data already on screen stays; a previous error is cleared. */
export function beginLoad(rec: SectionRecord): SectionRecord {
  return { ...rec, inFlight: true, error: null };
}

/** The cache answered. It never replaces what the backend already confirmed. */
export function applyCache(rec: SectionRecord, savedAtMs: number): SectionRecord {
  if (rec.source !== "none") return rec;
  return { ...rec, source: "cache", savedAtMs };
}

/** The backend answered. */
export function applyLive(nowMs: number): SectionRecord {
  return { source: "live", inFlight: false, error: null, savedAtMs: nowMs };
}

/** The request failed: whatever was on screen stays, now marked by the error. */
export function applyFailure(rec: SectionRecord, error: string): SectionRecord {
  return { ...rec, inFlight: false, error };
}

/** Whether the section shows the skeleton instead of content. */
export function showsSkeleton(rec: SectionRecord): boolean {
  return decideSectionState(rec) === "loading";
}

export type SectionNotice =
  | { kind: "stale"; when: string }
  /** Stale with no known time (cannot happen for a saved entry; kept honest). */
  | { kind: "stale-unknown" }
  | { kind: "error"; message: string };

/** What a section says about its freshness, or `null` when it has nothing to say. */
export function sectionNotice(rec: SectionRecord, locale: string): SectionNotice | null {
  const state = decideSectionState(rec);
  if (state === "error") return { kind: "error", message: rec.error ?? "" };
  if (state !== "stale") return null;
  return rec.savedAtMs === null ? { kind: "stale-unknown" } : { kind: "stale", when: formatStaleStamp(rec.savedAtMs, locale) };
}

/** Sections in the order the page lists them. */
export const TEAM_SECTION_ORDER: readonly TeamSection[] = ["overview", "detail", "sprints", "invites", "tasks"];

/** Sections that say the same thing (same stamp, same failure) share one notice. */
export type NoticeGroup = { sections: TeamSection[]; notice: SectionNotice };

function sameNotice(a: SectionNotice, b: SectionNotice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "stale" && b.kind === "stale") return a.when === b.when;
  if (a.kind === "error" && b.kind === "error") return a.message === b.message;
  return true;
}

/**
 * The notices to show, one per distinct message: five sections last refreshed in
 * the same minute (an offline start) are one line, not five.
 */
export function groupSectionNotices(sections: Record<TeamSection, SectionRecord>, locale: string): NoticeGroup[] {
  const groups: NoticeGroup[] = [];
  for (const section of TEAM_SECTION_ORDER) {
    const notice = sectionNotice(sections[section], locale);
    if (notice === null) continue;
    const hit = groups.find((g) => sameNotice(g.notice, notice));
    if (hit) hit.sections.push(section);
    else groups.push({ sections: [section], notice });
  }
  return groups;
}

// ---- the on-machine cache ---------------------------------------------------

export type TeamCacheEntry<T> = { data: T; savedAtMs: number; owner: string | null };

export const TEAM_CACHE_PREFIX = "stellar.team.cache.v1.";

/** Storage key of a section's cache: `scope` is the team id (the overview uses "account"). */
export function teamCacheKey(section: TeamSection, scope: string): string {
  return `${TEAM_CACHE_PREFIX}${section}.${scope}`;
}

export function serializeCacheEntry<T>(data: T, savedAtMs: number, owner: string | null): string {
  return JSON.stringify({ data, savedAtMs, owner });
}

/**
 * Reads a stored entry back. Anything that is not exactly what `serialize`
 * wrote — or whose data fails the section's own shape check — is no cache.
 */
export function parseCacheEntry<T>(raw: string | null, isData: (value: unknown) => value is T): TeamCacheEntry<T> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as { data?: unknown; savedAtMs?: unknown; owner?: unknown };
  if (typeof rec.savedAtMs !== "number" || !Number.isFinite(rec.savedAtMs)) return null;
  if (!isData(rec.data)) return null;
  return { data: rec.data, savedAtMs: rec.savedAtMs, owner: typeof rec.owner === "string" ? rec.owner : null };
}

export function isListData(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isOverviewData(value: unknown): value is { teams: unknown[]; accountId: string | null; displayName: string } {
  return typeof value === "object" && value !== null && Array.isArray((value as { teams?: unknown }).teams);
}

export function isDetailData(value: unknown): value is { team: unknown; members: unknown[] } {
  const rec = value as { team?: unknown; members?: unknown } | null;
  return typeof rec === "object" && rec !== null && typeof rec.team === "object" && rec.team !== null && Array.isArray(rec.members);
}

/**
 * The overview cache is the account's: it is shown only to the account that
 * saved it. An entry with no owner, or another one, is not shown.
 */
export function overviewCacheBelongsTo(entryOwner: string | null, currentOwner: string | null): boolean {
  return entryOwner !== null && currentOwner !== null && entryOwner === currentOwner;
}
