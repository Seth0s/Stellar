/**
 * TEAM PAGE CACHE — the thin `localStorage` side of `team-load-decision.ts`.
 *
 * What the page last saw of each section, kept on this machine so a start with
 * no connection (or a slow one) still has something to show — always marked as
 * stale until the backend confirms it. The backend stays the source of truth:
 * nothing here is ever sent anywhere or trusted over a live answer.
 */

import {
  parseCacheEntry,
  serializeCacheEntry,
  teamCacheKey,
  type TeamCacheEntry,
  type TeamSection,
} from "./team-load-decision";

export function readTeamCache<T>(section: TeamSection, scope: string, isData: (value: unknown) => value is T): TeamCacheEntry<T> | null {
  try {
    return parseCacheEntry(localStorage.getItem(teamCacheKey(section, scope)), isData);
  } catch {
    return null;
  }
}

export function writeTeamCache<T>(section: TeamSection, scope: string, data: T, savedAtMs: number, owner: string | null = null): void {
  try {
    localStorage.setItem(teamCacheKey(section, scope), serializeCacheEntry(data, savedAtMs, owner));
  } catch {
    /* storage full or blocked: the page works without a cache */
  }
}
