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
  readProfilesRegistry,
  type ProfileEntry,
  type ProfileTeam,
} from "./profiles";
import {
  classifyInviteTarget,
  preferLocalForTeamConfig,
  prefixTeamManifest,
  teamErrorMeansDetached,
  teamSafeManifest,
  type TeamDetailView,
  type TeamInviteView,
  type TeamListView,
  type TeamMemberView,
  type TeamRole,
  type TeamSummary,
} from "./team-decision";
import {
  parseTeamQueue,
  teamReportForLocal,
  type TeamSprintView,
  type TeamTaskDetail,
  type TeamTaskList,
  type TeamTaskView,
} from "./team-task-decision";
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

// ---- "member removed" switching ---------------------------------------------

/**
 * Turns the local team profile OFF (nothing is deleted). Idempotent: a profile
 * already detached is left alone. Returns true when it actually detached.
 */
function detachLocalTeamProfile(ctx: TeamContext, teamId: string): boolean {
  const profile = findTeamProfile(ctx.baseUserDataDir, teamId);
  if (!profile || profile.detached === true) return false;
  detachTeamProfile(ctx.baseUserDataDir, profile.id);
  return true;
}

/**
 * A team endpoint answered with an error that means the caller is no longer a
 * member: the local team profile is turned OFF so the screen stops offering
 * team actions. Only the caller's OWN membership is inferred here — a 403 that
 * is a role refusal does not count (see `teamErrorMeansDetached`).
 */
function noteTeamAccessDenied(ctx: TeamContext, teamId: string, error: { status: number; code: string }): boolean {
  if (!teamErrorMeansDetached(error.status, error.code)) return false;
  return detachLocalTeamProfile(ctx, teamId);
}

/**
 * `/me` is the source of truth for the account's teams: a local team profile
 * whose team is NOT in the list belongs to a membership that no longer exists.
 * Reconciles on every overview read — how a removed member (who still holds the
 * local profile) finds out without the SSE channel.
 */
function reconcileTeamProfiles(ctx: TeamContext, teams: readonly TeamSummary[]): void {
  const finding = readProfilesRegistry(ctx.baseUserDataDir);
  if (finding.kind !== "valid") return;
  const present = new Set(teams.map((t) => t.id));
  for (const profile of finding.registry.profiles) {
    const teamId = profile.team?.id;
    if (!teamId || profile.detached === true) continue;
    if (!present.has(teamId)) detachTeamProfile(ctx.baseUserDataDir, profile.id);
  }
}

// ---- team: read and manage --------------------------------------------------

export async function fetchTeamOverview(ctx: TeamContext): Promise<{ ok: true; view: TeamListView } | { ok: false; error: string }> {
  const res = await ctx.api.meFull(ctx.token);
  if (!res.ok) return { ok: false, error: res.error.message };
  // A team that vanished from `/me` turns that local profile off.
  reconcileTeamProfiles(ctx, res.value.teams);
  return { ok: true, view: res.value };
}

export async function fetchTeamDetail(ctx: TeamContext, teamId: string): Promise<{ ok: true; detail: TeamDetailView } | { ok: false; error: string }> {
  const res = await ctx.api.getTeam(ctx.token, teamId);
  if (!res.ok) {
    noteTeamAccessDenied(ctx, teamId, res.error);
    return { ok: false, error: res.error.message };
  }
  return { ok: true, detail: res.value };
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
  | "seats-exceeded"
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
    // The team already uses every paid seat — a plan refusal, not a role one.
    case "seats_exceeded":
      return "seats-exceeded";
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
): Promise<{ ok: true; invite: TeamInviteView } | { ok: false; reason: "invalid-target" | "forbidden" | "seats-exceeded" | "error"; error: string }> {
  if (classifyInviteTarget(input.target) === "invalid") {
    return { ok: false, reason: "invalid-target", error: "informe um e-mail ou um login do GitHub válido" };
  }
  const res = await ctx.api.createInvite(ctx.token, teamId, { target: input.target.trim(), role: input.role });
  if (res.ok) return { ok: true, invite: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  // The team uses every paid seat — a plan refusal the UI explains.
  const reason = res.error.code === "seats_exceeded" ? "seats-exceeded" : res.error.status === 403 ? "forbidden" : "error";
  return { ok: false, reason, error: res.error.message };
}

export async function revokeTeamInvite(ctx: TeamContext, teamId: string, inviteId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await ctx.api.revokeInvite(ctx.token, teamId, inviteId);
  if (res.ok) return { ok: true };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export type TeamInvitesResult = { ok: true; invites: TeamInviteView[] } | { ok: false; error: string };

/** Pending invites of a team (owner/admin only — a member gets a 403 stated back). */
export async function listTeamInvites(ctx: TeamContext, teamId: string): Promise<TeamInvitesResult> {
  const res = await ctx.api.listInvites(ctx.token, teamId);
  if (res.ok) return { ok: true, invites: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export async function changeTeamMemberRole(
  ctx: TeamContext,
  teamId: string,
  accountId: string,
  role: TeamRole,
): Promise<{ ok: true; member: TeamMemberView } | { ok: false; error: string }> {
  const res = await ctx.api.changeRole(ctx.token, teamId, accountId, role);
  if (res.ok) return { ok: true, member: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

/**
 * Removes a THIRD PARTY (admin/owner). The caller's own team profile stays
 * ACTIVE: a 404 here can mean the TARGET is not a member, which says nothing
 * about the caller — turning the caller's profile off would be a false
 * statement. Leaving the team yourself goes through `leaveTeam`.
 */
export async function removeTeamMember(
  ctx: TeamContext,
  teamId: string,
  accountId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.removeMember(ctx.token, teamId, accountId);
  return res.ok ? { ok: true } : { ok: false, error: res.error.message };
}

/**
 * Leaves the team. The server may answer 404 because we are ALREADY gone (a
 * removed member) — that is not a failure to leave: either way our local team
 * profile is turned OFF (nothing deleted), and the answer is honest about it.
 */
export async function leaveTeam(ctx: TeamContext, teamId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await ctx.api.meFull(ctx.token);
  if (!me.ok) return { ok: false, error: me.error.message };
  if (!me.value.accountId) return { ok: false, error: "não deu para saber a conta logada" };
  const res = await ctx.api.removeMember(ctx.token, teamId, me.value.accountId);
  if (!res.ok && !teamErrorMeansDetached(res.error.status, res.error.code)) {
    return { ok: false, error: res.error.message };
  }
  detachLocalTeamProfile(ctx, teamId);
  return { ok: true };
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
  if (!house.ok) {
    noteTeamAccessDenied(ctx, teamId, house.error);
    return { ok: false, conflict: false, error: house.error.message };
  }

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
  if (!house.ok) {
    noteTeamAccessDenied(ctx, teamId, house.error);
    return { ok: false, reason: "error", error: house.error.message };
  }

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

// ---- team tasks (B7) --------------------------------------------------------

export type TeamTaskListResult = { ok: true; list: TeamTaskList } | { ok: false; error: string };

export async function fetchTeamTasks(
  ctx: TeamContext,
  teamId: string,
  filter: Parameters<CloudApi["listTeamTasks"]>[2] = {},
): Promise<TeamTaskListResult> {
  const res = await ctx.api.listTeamTasks(ctx.token, teamId, filter);
  if (res.ok) return { ok: true, list: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export type TeamTaskDetailResult = { ok: true; detail: TeamTaskDetail } | { ok: false; error: string };

export async function fetchTeamTask(ctx: TeamContext, teamId: string, taskId: string): Promise<TeamTaskDetailResult> {
  const res = await ctx.api.getTeamTask(ctx.token, teamId, taskId);
  if (res.ok) return { ok: true, detail: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export async function createTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  const res = await ctx.api.createTeamTask(ctx.token, teamId, input);
  if (res.ok) return { ok: true, task: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export type TeamTaskUpdateOutcome =
  | { ok: true; task: TeamTaskView }
  | { ok: false; conflict: true; current: TeamTaskView | null }
  | { ok: false; conflict: false; error: string };

export async function updateTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  body: Record<string, unknown>,
  version: number,
): Promise<TeamTaskUpdateOutcome> {
  const res = await ctx.api.updateTeamTask(ctx.token, teamId, taskId, body, version);
  if (res.ok) return { ok: true, task: res.value };
  if (res.conflict) return { ok: false, conflict: true, current: res.current };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, conflict: false, error: res.error.message };
}

async function simpleTaskAction(
  res: Awaited<ReturnType<CloudApi["acceptTeamTask"]>>,
  ctx: TeamContext,
  teamId: string,
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  if (res.ok) return { ok: true, task: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export async function assignTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  body: { assignee_id?: string; session_label?: string; unassign?: boolean },
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  return simpleTaskAction(await ctx.api.assignTeamTask(ctx.token, teamId, taskId, body), ctx, teamId);
}

/** Accept with the contract, so the bridge can build the local Fila briefing.
 *  The contract is read BEFORE the accept (the accept answer has no contract). */
export async function acceptTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
): Promise<{ ok: true; task: TeamTaskView; contract: string | null } | { ok: false; error: string }> {
  const detail = await ctx.api.getTeamTask(ctx.token, teamId, taskId);
  if (!detail.ok) {
    noteTeamAccessDenied(ctx, teamId, detail.error);
    return { ok: false, error: detail.error.message };
  }
  const res = await ctx.api.acceptTeamTask(ctx.token, teamId, taskId);
  if (!res.ok) {
    noteTeamAccessDenied(ctx, teamId, res.error);
    return { ok: false, error: res.error.message };
  }
  return { ok: true, task: res.value, contract: detail.value.contract?.markdown ?? null };
}

export async function returnTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  return simpleTaskAction(await ctx.api.returnTeamTask(ctx.token, teamId, taskId), ctx, teamId);
}

export async function claimTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.claimTeamTask(ctx.token, teamId, taskId);
  if (res.ok) return { ok: true };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export async function decideTeamClaimOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  claimId: string,
  approve: boolean,
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  return simpleTaskAction(await ctx.api.decideTeamClaim(ctx.token, teamId, taskId, claimId, approve), ctx, teamId);
}

export async function autoDispatchTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  enabled: boolean,
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  return simpleTaskAction(await ctx.api.autoDispatchTeamTask(ctx.token, teamId, taskId, enabled), ctx, teamId);
}

export async function moveTeamTaskStateOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  state: string,
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  return simpleTaskAction(await ctx.api.moveTeamTaskState(ctx.token, teamId, taskId, state), ctx, teamId);
}

export async function commentTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  body: string,
  mentions: string[] = [],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.commentTeamTask(ctx.token, teamId, taskId, body, mentions);
  if (res.ok) return { ok: true };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export async function archiveTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.archiveTeamTask(ctx.token, teamId, taskId);
  if (res.ok) return { ok: true };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export async function restoreTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  return simpleTaskAction(await ctx.api.restoreTeamTask(ctx.token, teamId, taskId), ctx, teamId);
}

export async function deleteTeamTaskOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  confirm: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.deleteTeamTask(ctx.token, teamId, taskId, confirm);
  if (res.ok) return { ok: true };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

export async function reportTeamTaskStateOp(
  ctx: TeamContext,
  teamId: string,
  taskId: string,
  report: { state?: string; report_delivered?: boolean; gates_passed?: number; gates_total?: number; verdict?: string },
): Promise<{ ok: true; task: TeamTaskView } | { ok: false; error: string }> {
  return simpleTaskAction(await ctx.api.reportTeamTaskState(ctx.token, teamId, taskId, report), ctx, teamId);
}

export type TeamSprintsResult = { ok: true; sprints: TeamSprintView[] } | { ok: false; error: string };

export async function listTeamSprintsOp(ctx: TeamContext, teamId: string): Promise<TeamSprintsResult> {
  const res = await ctx.api.listTeamSprints(ctx.token, teamId);
  if (res.ok) return { ok: true, sprints: res.value };
  noteTeamAccessDenied(ctx, teamId, res.error);
  return { ok: false, error: res.error.message };
}

// ---- local Fila queue: "do time" tasks accepted on this machine ---------------

export const TEAM_QUEUE_FILENAME = "team-queue.json";

export function teamQueuePath(profileDir: string): string {
  return join(profileDir, TEAM_QUEUE_FILENAME);
}

export function readTeamQueue(profileDir: string): ReturnType<typeof parseTeamQueue> {
  try {
    return parseTeamQueue(JSON.parse(readFileSync(teamQueuePath(profileDir), "utf-8")));
  } catch {
    return [];
  }
}

export function writeTeamQueue(profileDir: string, entries: ReturnType<typeof parseTeamQueue>): void {
  const path = teamQueuePath(profileDir);
  mkdirSync(profileDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function appendTeamQueue(profileDir: string, entry: ReturnType<typeof parseTeamQueue>[number]): void {
  const entries = readTeamQueue(profileDir).filter((e) => e.localTaskId !== entry.localTaskId);
  entries.push(entry);
  writeTeamQueue(profileDir, entries);
}

export function removeTeamQueue(profileDir: string, localTaskId: string): void {
  writeTeamQueue(
    profileDir,
    readTeamQueue(profileDir).filter((e) => e.localTaskId !== localTaskId),
  );
}

export type TeamQueueReport = { localTaskId: string; reported: boolean; error?: string };

/**
 * The state bridge: for every accepted team task, read the LOCAL Fila task and
 * report the matching server state (a live card → rodando; done → report
 * delivered + aguardando_revisao). Only state travels — never code, never the
 * diff.
 */
export async function reconcileTeamQueue(
  ctx: TeamContext,
  getLocalTask: (localTaskId: string) => { status: string; cardAlive: boolean } | null,
): Promise<{ reports: TeamQueueReport[] }> {
  const entries = readTeamQueue(ctx.activeProfile.dir);
  const reports: TeamQueueReport[] = [];
  let changed = false;
  for (const entry of entries) {
    const local = getLocalTask(entry.localTaskId);
    if (!local) continue;
    const derived = teamReportForLocal(local);
    if (!derived) continue;
    // Never downgrade a delivered task back to `rodando`.
    if (entry.reportDelivered && derived.state === "rodando") continue;
    if (derived.reportDelivered === true && entry.reportDelivered) continue;
    const res = await ctx.api.reportTeamTaskState(ctx.token, entry.teamId, entry.teamTaskId, {
      ...(derived.state ? { state: derived.state } : {}),
      ...(derived.reportDelivered !== undefined ? { report_delivered: derived.reportDelivered } : {}),
    });
    if (res.ok) {
      if (derived.reportDelivered === true && !entry.reportDelivered) {
        entry.reportDelivered = true;
        changed = true;
      }
      reports.push({ localTaskId: entry.localTaskId, reported: true });
    } else {
      reports.push({ localTaskId: entry.localTaskId, reported: false, error: res.error.message });
    }
  }
  if (changed) writeTeamQueue(ctx.activeProfile.dir, entries);
  return { reports };
}
