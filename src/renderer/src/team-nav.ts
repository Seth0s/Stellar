/**
 * TEAM SECTION NAVIGATION — which section of the team page is open, shared
 * between the sidebar (where the sections sit nested under "Team") and the team
 * page (which renders the content and knows which sections the person may see).
 * A tiny external store: no provider, readable from both sides.
 */

import { useSyncExternalStore } from "react";

export type TeamSub = "overview" | "board" | "members" | "home" | "audit" | "import" | "integrations" | "settings";

export const TEAM_SUBS: readonly TeamSub[] = ["overview", "board", "members", "home", "import", "integrations", "audit", "settings"];

export function isTeamSub(value: unknown): value is TeamSub {
  return typeof value === "string" && (TEAM_SUBS as readonly string[]).includes(value);
}

export type TeamNavState = { sub: TeamSub; available: readonly TeamSub[] };

let state: TeamNavState = { sub: "overview", available: [] };
const listeners = new Set<() => void>();

function set(next: TeamNavState): void {
  if (next.sub === state.sub && next.available === state.available) return;
  state = next;
  for (const cb of listeners) cb();
}

export function getTeamNav(): TeamNavState {
  return state;
}

export function subscribeTeamNav(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setTeamSub(sub: TeamSub): void {
  set({ ...state, sub });
}

/** The team page announces the sections it offers (empty when it is not showing a team). */
export function publishTeamSubs(available: readonly TeamSub[]): void {
  const same = available.length === state.available.length && available.every((s, i) => s === state.available[i]);
  if (!same) set({ ...state, available });
}

export function useTeamNav(): TeamNavState {
  return useSyncExternalStore(subscribeTeamNav, getTeamNav, getTeamNav);
}
