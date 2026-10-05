/**
 * LINK between a local profile and its SERVER profile (A8) — the I/O shell.
 *
 * The (pure) decision lives in `profiles-cloud-decision.ts`; here are the
 * network (`GET`/`POST /v1/profiles`), the additive write of `cloudProfileId`
 * into `profiles.json` (through `profiles.ts`) and the "zero the base" step
 * when the link changes. No user file is deleted: only `work-home-base.json` —
 * the sync's own bookkeeping — so the next sync is a three-way from zero.
 */

import { rmSync } from "node:fs";
import type { CloudApi } from "./cloud-api";
import {
  readProfilesRegistry,
  setProfileCloudLink,
  profileDirectory,
  type ProfileEntry,
} from "./profiles";
import { workHomeBasePath } from "./work-home-sync";
import { decideCloudLink, type CloudProfileRef } from "./profiles-cloud-decision";

/** What the screen reads: the ACTIVE local profile, its link and the account's
 *  profiles. */
export type CloudLinkView = {
  profileId: string;
  cloudProfileId: string | null;
  available: { id: string; name: string; kind: string }[];
};

export type CloudLinkViewResult = { ok: true; view: CloudLinkView } | { ok: false; error: string };

function activeEntry(baseUserDataDir: string, localProfileId: string): ProfileEntry | null {
  const finding = readProfilesRegistry(baseUserDataDir);
  if (finding.kind !== "valid") return null;
  return finding.registry.profiles.find((p) => p.id === localProfileId) ?? null;
}

/**
 * Deletes the sync base of a local profile — the last-synced manifest. It is
 * the app's own bookkeeping (never a user file), so clearing it is how
 * "change the link" makes the NEXT sync a three-way merge from zero.
 */
function clearSyncBase(baseUserDataDir: string, localProfileId: string): void {
  try {
    rmSync(workHomeBasePath(profileDirectory(baseUserDataDir, localProfileId)), { force: true });
  } catch {
    // Missing file is the normal case; a permission error just leaves the old
    // base (the next sync may see a stale base, but nothing is deleted wrong).
  }
}

async function fetchCloudProfiles(api: CloudApi, token: string): Promise<{ ok: true; profiles: CloudProfileRef[] } | { ok: false; error: string }> {
  const res = await api.listProfiles(token);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, profiles: res.value };
}

/** The active profile's link + this account's server profiles. Requires login. */
export async function readCloudLinkView(input: {
  api: CloudApi;
  token: string;
  baseUserDataDir: string;
  localProfileId: string;
}): Promise<CloudLinkViewResult> {
  const entry = activeEntry(input.baseUserDataDir, input.localProfileId);
  if (!entry) return { ok: false, error: "perfil local não encontrado" };
  const listed = await fetchCloudProfiles(input.api, input.token);
  if (!listed.ok) return { ok: false, error: listed.error };
  return {
    ok: true,
    view: {
      profileId: entry.id,
      cloudProfileId: entry.cloudProfileId ?? null,
      available: listed.profiles.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    },
  };
}

/** Sets (or clears) the link, then zeroes that profile's sync base. */
export function writeCloudLink(input: {
  baseUserDataDir: string;
  localProfileId: string;
  cloudProfileId: string | null;
}): { ok: true } | { ok: false; error: string } {
  const res = setProfileCloudLink(input.baseUserDataDir, input.localProfileId, input.cloudProfileId);
  if (!res.ok) return { ok: false, error: res.reason };
  clearSyncBase(input.baseUserDataDir, input.localProfileId);
  return { ok: true };
}

/** Creates a PERSONAL server profile and links the given local profile to it. */
export async function createAndLinkCloudProfile(input: {
  api: CloudApi;
  token: string;
  baseUserDataDir: string;
  localProfileId: string;
  name: string;
}): Promise<CloudLinkViewResult> {
  const created = await input.api.createProfile(input.token, { kind: "personal", name: input.name });
  if (!created.ok) return { ok: false, error: created.error.message };
  const linked = writeCloudLink({
    baseUserDataDir: input.baseUserDataDir,
    localProfileId: input.localProfileId,
    cloudProfileId: created.value.id,
  });
  if (!linked.ok) return { ok: false, error: linked.error };
  return readCloudLinkView({
    api: input.api,
    token: input.token,
    baseUserDataDir: input.baseUserDataDir,
    localProfileId: input.localProfileId,
  });
}

export type EnsureCloudProfileIdResult =
  | { ok: true; cloudProfileId: string }
  | { ok: false; error: string };

/**
 * Resolves the SERVER id a house sync must use. If the local profile already
 * has one, it is returned untouched. Otherwise the account's profiles are read
 * and the pure decision either links an existing match, creates a personal
 * profile, or reports that a team profile is not on the server (its creation
 * belongs to the invite/accept flow). The resolved link is persisted.
 */
export async function ensureCloudProfileId(input: {
  api: CloudApi;
  token: string;
  baseUserDataDir: string;
  localProfileId: string;
}): Promise<EnsureCloudProfileIdResult> {
  const entry = activeEntry(input.baseUserDataDir, input.localProfileId);
  if (!entry) return { ok: false, error: "perfil local não encontrado" };
  if (entry.cloudProfileId) return { ok: true, cloudProfileId: entry.cloudProfileId };

  const listed = await fetchCloudProfiles(input.api, input.token);
  if (!listed.ok) return { ok: false, error: listed.error };

  const plan = decideCloudLink({
    local: {
      kind: entry.kind,
      name: entry.name,
      teamId: entry.team?.id ?? null,
      cloudProfileId: entry.cloudProfileId ?? null,
    },
    cloudProfiles: listed.profiles,
  });

  if (plan.action === "none") {
    return { ok: false, error: "o perfil de time ainda não existe no servidor; aceite o convite de novo" };
  }

  let cloudProfileId: string;
  if (plan.action === "use") {
    cloudProfileId = plan.cloudProfileId;
  } else {
    const created = await input.api.createProfile(input.token, { kind: plan.kind, name: plan.name });
    if (!created.ok) return { ok: false, error: created.error.message };
    cloudProfileId = created.value.id;
  }

  const linked = writeCloudLink({ baseUserDataDir: input.baseUserDataDir, localProfileId: entry.id, cloudProfileId });
  if (!linked.ok) return { ok: false, error: linked.error };
  return { ok: true, cloudProfileId };
}
