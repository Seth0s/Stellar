/**
 * LINK between a local profile and its SERVER profile (A8) — the DECISION, no I/O.
 *
 * Every local profile stores `cloudProfileId` (the server id) additively; the
 * LOCAL id stays the key (the folder name). On the first sync of a profile
 * without a link, the app reads the account's profiles (`GET /v1/profiles`) and
 * decides:
 *
 *  - ALREADY linked          -> use the declared id (never re-link silently:
 *    changing the link is the person's explicit gesture);
 *  - TEAM profile            -> match by `team_id` (the server creates the team
 *    profile during invite accept); with no match it does NOT create — `POST
 *    /v1/profiles` refuses `kind:"team"`;
 *  - PERSONAL profile        -> match by `kind` + normalized name; with no
 *    match, `POST /v1/profiles` and link whatever id comes back.
 *
 * Pure: no fs, no network, no clock. The I/O shell is `profiles-cloud.ts`.
 */

import { isOpaqueId } from "./local-identity-decision";
import type { ProfileKind } from "./profiles-decision";

/**
 * A profile OF THE ACCOUNT, as the server returns it (`GET /v1/profiles` and
 * `POST /v1/profiles`). `teamId` is null on a personal one.
 */
export type CloudProfileRef = {
  id: string;
  kind: string;
  name: string;
  teamId: string | null;
};

/** Compares names ignoring case/space — "Pessoal" and " pessoal " are the same
 *  name for the link. */
export function normalizeCloudName(name: string): string {
  return name.trim().toLowerCase();
}

/** Reads ONE server profile; an id that is not opaque is refused (the server
 *  uses UUIDs, and such an id never becomes a sync target). Missing fields
 *  degrade to an honest value, never taking the whole read down. */
export function parseCloudProfile(raw: unknown): CloudProfileRef | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!isOpaqueId(rec.id)) return null;
  return {
    id: rec.id,
    kind: typeof rec.kind === "string" ? rec.kind : "unknown",
    name: typeof rec.name === "string" ? rec.name : "",
    teamId: isOpaqueId(rec.team_id) ? rec.team_id : null,
  };
}

/** Reads the list response: accepts `{profiles:[…]}` (the backend's shape) or a
 *  raw array. Invalid entries are DROPPED, never "repaired". */
export function parseCloudProfileList(raw: unknown): CloudProfileRef[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).profiles)
      ? ((raw as Record<string, unknown>).profiles as unknown[])
      : [];
  const profiles: CloudProfileRef[] = [];
  for (const item of list) {
    const parsed = parseCloudProfile(item);
    if (parsed) profiles.push(parsed);
  }
  return profiles;
}

/** The local profile we want to link (only what the link decision needs). */
export type LocalCloudLinkInput = {
  kind: ProfileKind;
  name: string;
  teamId: string | null;
  cloudProfileId: string | null;
};

export type CloudLinkPlan =
  /** Already linked, or a server profile matches: use this id. */
  | { action: "use"; cloudProfileId: string }
  /** Create a PERSONAL server profile and link the id that comes back. */
  | { action: "create"; kind: "personal"; name: string }
  /** Team profile with no server match: it cannot be created from here. */
  | { action: "none"; reason: "team-not-on-server" };

/**
 * Decides the link. Order matters: a declared `cloudProfileId` WINS — the
 * person may have picked another profile on purpose, and re-linking by name
 * would betray that. Only a profile without a link looks up/creates.
 */
export function decideCloudLink(input: {
  local: LocalCloudLinkInput;
  cloudProfiles: readonly CloudProfileRef[];
}): CloudLinkPlan {
  const { local } = input;

  if (local.cloudProfileId && isOpaqueId(local.cloudProfileId)) {
    return { action: "use", cloudProfileId: local.cloudProfileId };
  }

  if (local.kind === "team") {
    if (local.teamId) {
      const match = input.cloudProfiles.find((p) => p.kind === "team" && p.teamId === local.teamId);
      if (match) return { action: "use", cloudProfileId: match.id };
    }
    return { action: "none", reason: "team-not-on-server" };
  }

  const wanted = normalizeCloudName(local.name);
  const match = input.cloudProfiles.find((p) => p.kind === "personal" && normalizeCloudName(p.name) === wanted);
  if (match) return { action: "use", cloudProfileId: match.id };
  return { action: "create", kind: "personal", name: local.name.trim() || "Pessoal" };
}
