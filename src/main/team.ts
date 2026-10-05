/**
 * TEAMS IN THE APP — the I/O shell.
 *
 * Wires the HTTP client (`cloud-api`), the profile registry (`profiles`) and
 * the house machinery: create/manage the team, accept an invite (creating the
 * isolated local `team` profile), publish the base from the ACTIVE profile's
 * house, and materialize the base into the team profile with the
 * `team-<slug>-` prefix.
 *
 * The DECISION layer (roles, prefix, memory filter, deep link) lives in
 * `team-decision.ts`; here there is only side effect.
 *
 * Nothing is deleted: leaving a team marks the profile as turned off
 * (`detachTeamProfile`).
 */

import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloudApi } from "./cloud-api";
import {
  buildManifest,
  fromRemoteEntries,
  toRemoteEntries,
  type WorkHomeManifest,
  type WorkHomePackage,
  type WorkHomeTool,
} from "./work-home-manifest";
import { collectLocalWorkHome } from "./work-home-sync";
import { readWorkHomePrefs, resolveWorkHomeToolRoots } from "./work-home-profile";
import { applyWorkHomePlan, sha256FileSync, type WorkHomeApplyResult } from "./work-home-apply";
import {
  planWorkHomeApply,
  resolveWorkHomeTarget,
  type WorkHomeApplyPlan,
  type WorkHomeConflictChoice,
} from "./work-home-apply-decision";
import {
  detachTeamProfile,
  ensureTeamProfile,
  findTeamProfile,
  profileDirectory,
  type ProfileEntry,
  type ProfileTeam,
} from "./profiles";
import {
  classifyInviteTarget,
  preferLocalForTeamConfig,
  prefixTeamManifest,
  teamSafeManifest,
  type TeamDetailView,
  type TeamInviteView,
  type TeamListView,
  type TeamMemberView,
  type TeamRole,
  type TeamSummary,
} from "./team-decision";
import type { ProviderHomeMode } from "./config-home-decision";

export const TEAM_HOUSE_BASE_FILENAME = "team-house-base.json";

export type TeamActiveProfile = { id: string; dir: string; homeMode: ProviderHomeMode };

export type TeamContext = {
  api: CloudApi;
  token: string;
  /** Root of `userData` (where `profiles.json` lives). */
  baseUserDataDir: string;
  homeDir: string;
  installId: string;
  now: number;
  generateId: () => string;
  /** Agent providers, to resolve tool roots per house mode. */
  agentProviders: readonly { id: string; supportsConfigHome: boolean }[];
  /** ACTIVE profile — the house the base is PUBLISHED from. */
  activeProfile: TeamActiveProfile;
};

// ---- local team-house base (what we materialized last) ----------------------

export function teamHouseBasePath(profileDir: string): string {
  return join(profileDir, TEAM_HOUSE_BASE_FILENAME);
}

export function readTeamHouseBase(profileDir: string): WorkHomeManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(teamHouseBasePath(profileDir), "utf-8")) as WorkHomeManifest;
    return parsed && Array.isArray(parsed.entries) ? buildManifest(parsed.entries, parsed.removals ?? []) : null;
  } catch {
    return null;
  }
}

export function writeTeamHouseBase(profileDir: string, manifest: WorkHomeManifest): void {
  const path = teamHouseBasePath(profileDir);
  mkdirSync(profileDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---- tool roots -------------------------------------------------------------

function toolRootsFor(input: {
  homeDir: string;
  profileDir: string;
  homeMode: ProviderHomeMode;
  providers: readonly { id: string; supportsConfigHome: boolean }[];
}): Partial<Record<WorkHomeTool, string>> {
  return resolveWorkHomeToolRoots(input);
}

// ---- team: read and manage --------------------------------------------------

export async function fetchTeamOverview(ctx: TeamContext): Promise<{ ok: true; view: TeamListView } | { ok: false; error: string }> {
  const res = await ctx.api.meFull(ctx.token);
  return res.ok ? { ok: true, view: res.value } : { ok: false, error: res.error.message };
}

export async function fetchTeamDetail(ctx: TeamContext, teamId: string): Promise<{ ok: true; detail: TeamDetailView } | { ok: false; error: string }> {
  const res = await ctx.api.getTeam(ctx.token, teamId);
  return res.ok ? { ok: true, detail: res.value } : { ok: false, error: res.error.message };
}

export type CreatedTeam = { team: TeamSummary; profile: ProfileEntry; profileCreated: boolean };

export async function createAccountTeam(
  ctx: TeamContext,
  input: { name: string; slug?: string },
): Promise<{ ok: true; value: CreatedTeam } | { ok: false; error: string }> {
  const res = await ctx.api.createTeam(ctx.token, { name: input.name, slug: input.slug });
  if (!res.ok) return { ok: false, error: res.error.message };
  const team: ProfileTeam = { id: res.value.id, slug: res.value.slug, name: res.value.name };
  const ensured = ensureTeamProfile(ctx.baseUserDataDir, { team, now: ctx.now, generateId: ctx.generateId });
  if (!ensured.ok) return { ok: false, error: `perfil do time não criado: ${ensured.reason}` };
  return { ok: true, value: { team: res.value, profile: ensured.profile, profileCreated: ensured.created } };
}

export type AcceptedInvite = { team: TeamSummary; membership: TeamMemberView; profile: ProfileEntry; profileCreated: boolean };

/** Local reasons for an accept; `identity-mismatch` covers the backend 403. */
export type AcceptFailure =
  | "identity-mismatch"
  | "expired"
  | "used"
  | "revoked"
  | "not-found"
  | "already-member"
  | "error";

function mapAcceptError(code: string, status: number): AcceptFailure {
  switch (code) {
    case "invite_target_mismatch":
      return "identity-mismatch";
    case "invite_expired":
      return "expired";
    case "invite_used":
      return "used";
    case "invite_revoked":
      return "revoked";
    case "already_member":
      return "already-member";
    case "not_found":
      return "not-found";
    default:
      return status === 403 ? "identity-mismatch" : "error";
  }
}

/**
 * Accepts the invite and creates (or updates) the team's LOCAL profile. The
 * profile is created only when the backend ACCEPTS: a wrong identity (403)
 * leaves no local trace — that is the `identity-mismatch` the UI explains.
 */
export async function acceptTeamInvite(
  ctx: TeamContext,
  rawToken: string,
): Promise<{ ok: true; value: AcceptedInvite } | { ok: false; reason: AcceptFailure; error: string }> {
  const res = await ctx.api.acceptInvite(ctx.token, rawToken);
  if (!res.ok) return { ok: false, reason: mapAcceptError(res.error.code, res.error.status), error: res.error.message };
  const team: ProfileTeam = { id: res.value.team.id, slug: res.value.team.slug, name: res.value.team.name };
  const ensured = ensureTeamProfile(ctx.baseUserDataDir, { team, now: ctx.now, generateId: ctx.generateId });
  if (!ensured.ok) return { ok: false, reason: "error", error: `perfil do time não criado: ${ensured.reason}` };
  return { ok: true, value: { team: res.value.team, membership: res.value.membership, profile: ensured.profile, profileCreated: ensured.created } };
}

export async function createTeamInvite(
  ctx: TeamContext,
  teamId: string,
  input: { target: string; role: TeamRole },
): Promise<{ ok: true; invite: TeamInviteView } | { ok: false; reason: "invalid-target" | "forbidden" | "error"; error: string }> {
  if (classifyInviteTarget(input.target) === "invalid") {
    return { ok: false, reason: "invalid-target", error: "informe um e-mail ou um login do GitHub válido" };
  }
  const res = await ctx.api.createInvite(ctx.token, teamId, { target: input.target.trim(), role: input.role });
  if (res.ok) return { ok: true, invite: res.value };
  return { ok: false, reason: res.error.status === 403 ? "forbidden" : "error", error: res.error.message };
}

export async function revokeTeamInvite(ctx: TeamContext, teamId: string, inviteId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await ctx.api.revokeInvite(ctx.token, teamId, inviteId);
  return res.ok ? { ok: true } : { ok: false, error: res.error.message };
}

export async function changeTeamMemberRole(
  ctx: TeamContext,
  teamId: string,
  accountId: string,
  role: TeamRole,
): Promise<{ ok: true; member: TeamMemberView } | { ok: false; error: string }> {
  const res = await ctx.api.changeRole(ctx.token, teamId, accountId, role);
  return res.ok ? { ok: true, member: res.value } : { ok: false, error: res.error.message };
}

/** Removes a third party, or leaves (`accountId` = own account). On removal the
 *  team's local profile is turned OFF (nothing is deleted). */
export async function removeTeamMember(
  ctx: TeamContext,
  teamId: string,
  accountId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.removeMember(ctx.token, teamId, accountId);
  if (!res.ok) return { ok: false, error: res.error.message };
  const profile = findTeamProfile(ctx.baseUserDataDir, teamId);
  if (profile) detachTeamProfile(ctx.baseUserDataDir, profile.id);
  return { ok: true };
}

/** Leaves the team: finds the own account in `/me` and calls remove (self). */
export async function leaveTeam(ctx: TeamContext, teamId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await ctx.api.meFull(ctx.token);
  if (!me.ok) return { ok: false, error: me.error.message };
  if (!me.value.accountId) return { ok: false, error: "não deu para saber a conta logada" };
  return removeTeamMember(ctx, teamId, me.value.accountId);
}

// ---- team house: publish ----------------------------------------------------

export type TeamPublishPreview = {
  entries: { path: string; tool: WorkHomeTool; size: number }[];
  dropped: string[];
  warnings: string[];
};

function collectActivePackage(ctx: TeamContext): { pkg: WorkHomePackage; dropped: string[]; warnings: string[] } {
  const prefs = readWorkHomePrefs(ctx.activeProfile.dir);
  const roots = toolRootsFor({
    homeDir: ctx.homeDir,
    profileDir: ctx.activeProfile.dir,
    homeMode: ctx.activeProfile.homeMode,
    providers: ctx.agentProviders,
  });
  const collected = collectLocalWorkHome({
    api: ctx.api,
    token: ctx.token,
    profileId: ctx.activeProfile.id,
    installId: ctx.installId,
    homeDir: ctx.homeDir,
    toolRoots: roots,
    enabledTools: prefs.enabledTools,
    projectClones: [],
  });
  const safe = teamSafeManifest(collected.package.manifest);
  return {
    pkg: { manifest: safe.manifest, blobs: collected.package.blobs },
    dropped: safe.dropped,
    warnings: collected.warnings,
  };
}

/** Preview of what goes into the base: only rules/skills/agents/config; memory out. */
export function previewTeamPublish(ctx: TeamContext): TeamPublishPreview {
  const collected = collectActivePackage(ctx);
  return {
    entries: collected.pkg.manifest.entries.map((e) => ({ path: e.path, tool: e.tool, size: e.size })),
    dropped: collected.dropped,
    warnings: collected.warnings,
  };
}

async function uploadMissing(
  api: CloudApi,
  token: string,
  shas: readonly string[],
  blobs: ReadonlyMap<string, Uint8Array>,
): Promise<{ uploaded: number; warnings: string[] }> {
  const warnings: string[] = [];
  let uploaded = 0;
  if (shas.length === 0) return { uploaded, warnings };
  const check = await api.checkBlobs(token, [...shas]);
  if (!check.ok) return { uploaded, warnings: [`blobs/check falhou: ${check.error.message}`] };
  for (const sha of check.value) {
    const bytes = blobs.get(sha);
    if (!bytes) {
      warnings.push(`blob ${sha.slice(0, 8)} falta no pacote local`);
      continue;
    }
    const put = await api.putBlob(token, sha, bytes);
    if (!put.ok) warnings.push(`blob ${sha.slice(0, 8)} não subiu: ${put.error.message}`);
    else uploaded++;
  }
  return { uploaded, warnings };
}

export type TeamPublishOutcome =
  | { ok: true; revision: number; uploaded: number; count: number; dropped: string[]; warnings: string[] }
  | { ok: false; conflict: true; currentRevision: number }
  | { ok: false; conflict: false; error: string };

/** Publishes the team base from the ACTIVE profile's house (admin/owner on the
 *  server). `If-Match` is the current revision; a `409` returns to the preview. */
export async function publishTeamHouse(ctx: TeamContext, teamId: string): Promise<TeamPublishOutcome> {
  const collected = collectActivePackage(ctx);
  const house = await ctx.api.getTeamHouse(ctx.token, teamId);
  if (!house.ok) return { ok: false, conflict: false, error: house.error.message };

  const { entries } = toRemoteEntries(collected.pkg.manifest, null);
  const shas = [...new Set(entries.filter((e) => !e.deleted).map((e) => e.sha256))];
  const up = await uploadMissing(ctx.api, ctx.token, shas, collected.pkg.blobs);
  const put = await ctx.api.putTeamHouse(ctx.token, teamId, { revision: house.value.revision, manifest: entries });
  if (put.ok) {
    return {
      ok: true,
      revision: put.value.revision,
      uploaded: up.uploaded,
      count: collected.pkg.manifest.entries.length,
      dropped: collected.dropped,
      warnings: [...collected.warnings, ...up.warnings],
    };
  }
  if (put.conflict) return { ok: false, conflict: true, currentRevision: put.currentRevision };
  return { ok: false, conflict: false, error: put.error.message };
}

// ---- team house: materialize on the member ----------------------------------

export type TeamPullPlan = {
  profileId: string;
  profileDir: string;
  slug: string;
  revision: number;
  plan: WorkHomeApplyPlan;
  warnings: string[];
};

function teamProfileRoots(ctx: TeamContext, profile: ProfileEntry): Partial<Record<WorkHomeTool, string>> {
  return toolRootsFor({
    homeDir: ctx.homeDir,
    profileDir: profileDirectory(ctx.baseUserDataDir, profile.id),
    homeMode: profile.homeMode,
    providers: ctx.agentProviders,
  });
}

/** Manifest to materialize: the prefixed remote base plus removals for paths
 *  that disappeared from the remote since the local base. */
function incomingFor(remote: WorkHomeManifest, slug: string, base: WorkHomeManifest | null): WorkHomeManifest {
  const prefixed = prefixTeamManifest(remote, slug);
  const remotePaths = new Set(prefixed.entries.map((e) => e.path));
  const extraRemovals = (base?.entries ?? []).map((e) => e.path).filter((p) => !remotePaths.has(p));
  return buildManifest(prefixed.entries, [...prefixed.removals, ...extraRemovals]);
}

type PulledTeamHouse = {
  profile: ProfileEntry;
  profileDir: string;
  slug: string;
  revision: number;
  incoming: WorkHomePackage;
  plan: WorkHomeApplyPlan;
  warnings: string[];
};

async function pullTeamHouseInternal(
  ctx: TeamContext,
  teamId: string,
): Promise<{ ok: true; value: PulledTeamHouse } | { ok: false; reason: "no-profile" | "no-slug" | "error"; error: string }> {
  const profile = findTeamProfile(ctx.baseUserDataDir, teamId);
  if (!profile) return { ok: false, reason: "no-profile", error: "não há perfil local deste time" };
  const slug = profile.team?.slug;
  if (!slug) return { ok: false, reason: "no-slug", error: "o perfil do time não tem slug — não dá para prefixar a base" };

  const house = await ctx.api.getTeamHouse(ctx.token, teamId);
  if (!house.ok) return { ok: false, reason: "error", error: house.error.message };

  const profileDir = profileDirectory(ctx.baseUserDataDir, profile.id);
  const remote = fromRemoteEntries(house.value.manifest);
  const roots = teamProfileRoots(ctx, profile);
  const base = readTeamHouseBase(profileDir);
  const manifest = incomingFor(remote, slug, base);

  const blobs = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  const targetCtx = { toolRoots: roots, homeDir: ctx.homeDir, projectClones: [] };
  for (const entry of manifest.entries) {
    if (blobs.has(entry.sha256)) continue;
    const target = resolveWorkHomeTarget(entry.path, targetCtx);
    if (target.kind === "resolved" && sha256FileSync(target.absPath) === entry.sha256) continue;
    const got = await ctx.api.getBlob(ctx.token, entry.sha256);
    if (!got.ok) {
      warnings.push(`${entry.path}: blob ${entry.sha256.slice(0, 8)} não baixou (${got.error.message})`);
      continue;
    }
    blobs.set(entry.sha256, got.value);
  }

  const incoming: WorkHomePackage = { manifest, blobs };
  const rawPlan = planWorkHomeApply({
    incoming,
    base,
    toolRoots: roots,
    homeDir: ctx.homeDir,
    projectClones: [],
    shaOf: sha256FileSync,
  });
  const plan = preferLocalForTeamConfig(rawPlan);
  return { ok: true, value: { profile, profileDir, slug, revision: house.value.revision, incoming, plan, warnings } };
}

/** Preview of the incoming team base on the member's profile (serializable). */
export async function pullTeamHouse(
  ctx: TeamContext,
  teamId: string,
): Promise<{ ok: true; value: TeamPullPlan } | { ok: false; reason: "no-profile" | "no-slug" | "error"; error: string }> {
  const pulled = await pullTeamHouseInternal(ctx, teamId);
  if (!pulled.ok) return pulled;
  const v = pulled.value;
  return {
    ok: true,
    value: {
      profileId: v.profile.id,
      profileDir: v.profileDir,
      slug: v.slug,
      revision: v.revision,
      plan: v.plan,
      warnings: v.warnings,
    },
  };
}

export type TeamApplyOutcome =
  | { ok: true; result: WorkHomeApplyResult; baseUpdated: boolean }
  | { ok: false; reason: "no-profile" | "no-slug" | "error"; error: string };

/** Applies the team base into the member's profile. The local base advances
 *  only when no conflict and no pending item remains — nothing is declared
 *  applied halfway. */
export async function applyTeamHouse(
  ctx: TeamContext,
  teamId: string,
  choices: Readonly<Record<string, WorkHomeConflictChoice>> = {},
): Promise<TeamApplyOutcome> {
  const pulled = await pullTeamHouseInternal(ctx, teamId);
  if (!pulled.ok) return pulled;
  const v = pulled.value;
  const result = applyWorkHomePlan({
    plan: v.plan,
    blobs: v.incoming.blobs,
    choices,
    backupRoot: join(v.profileDir, "backups"),
    now: ctx.now,
    pathValues: { homeDir: ctx.homeDir, projectClones: [] },
  });
  const baseUpdated = result.conflicts.length === 0 && result.pending.length === 0;
  if (baseUpdated) writeTeamHouseBase(v.profileDir, v.incoming.manifest);
  return { ok: true, result, baseUpdated };
}
