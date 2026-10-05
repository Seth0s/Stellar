/**
 * CASA DE TRABALHO — o CLIENTE de sync v2 (A3b, BACKEND_V1.md §5.2/§5.3/§5.4).
 *
 * Junta as peças prontas: coletor/aplicador (A3a), login (cloud-*) e a API de
 * casa v2 (B6): `/v1/blobs/check`, `PUT/GET /v1/blobs/{sha}`,
 * `PUT/GET /v1/profiles/{id}/house`.
 *
 * PUXAR: GET do manifesto → baixa só os blobs que faltam (compara o sha do
 * arquivo local antes de pedir) → PRÉVIA pelo plano do aplicador (entra/muda/
 * pendente/conflito). Quem aplica é o chamador, com `applyPulledWorkHome`.
 *
 * EMPURRAR: coleta → GET do remoto → merge de três vias (`planPush`) → sobe só
 * o que falta → PUT com `If-Match`. Em `409`, o servidor devolve o manifesto
 * atual e a gente MERGEIA de novo: o que só o remoto mudou entra sozinho; o que
 * os dois mudaram vira CONFLITO para a UI escolher.
 *
 * A BASE (última revisão sincronizada) é um arquivo por perfil. Este módulo tem
 * I/O (rede via `api`, fs da base); a decisão pura está em
 * `work-home-sync-decision.ts`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloudApi } from "./cloud-api";
import {
  buildManifest,
  fromRemoteEntries,
  toRemoteEntries,
  type WorkHomeManifest,
  type WorkHomeManifestEntry,
  type WorkHomePackage,
  type WorkHomeTool,
} from "./work-home-manifest";
import type { ProjectClone } from "./work-home-remap";
import { collectWorkHome, mergeWorkHomePackages } from "./work-home-collect";
import { applyWorkHomePlan, sha256FileSync, type WorkHomeApplyResult } from "./work-home-apply";
import {
  planWorkHomeApply,
  resolveWorkHomeTarget,
  type WorkHomeApplyPlan,
  type WorkHomeConflictChoice,
} from "./work-home-apply-decision";
import { planPush, resolvePushConflicts, type PushConflict, type PushPlan } from "./work-home-sync-decision";
import type { PathValueContext } from "./work-home-path-values";

export const WORK_HOME_BASE_FILENAME = "work-home-base.json";

export type WorkHomeSyncContext = {
  api: CloudApi;
  /** A valid access token (the caller renews it before). */
  token: string;
  /**
   * The id of the profile on the SERVER (`/v1/profiles/{id}/house`) — NEVER the
   * local profile id. The caller resolves/creates the link before building the
   * context (`profiles-cloud.ts`); the server has never heard of the local id.
   */
  cloudProfileId: string;
  installId: string;
  homeDir: string;
  toolRoots: Partial<Record<WorkHomeTool, string>>;
  enabledTools: readonly WorkHomeTool[];
  projectClones: readonly ProjectClone[];
  stellar?: { config: Record<string, unknown>; credentialNames: readonly string[] };
};

// ---- base local (manifesto sincronizado) ------------------------------------

export function workHomeBasePath(dataDir: string): string {
  return join(dataDir, WORK_HOME_BASE_FILENAME);
}

export function readBaseManifest(dataDir: string): WorkHomeManifest | null {
  let raw: string;
  try {
    raw = readFileSync(workHomeBasePath(dataDir), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as WorkHomeManifest;
    return parsed && Array.isArray(parsed.entries) ? buildManifest(parsed.entries, parsed.removals ?? []) : null;
  } catch {
    return null;
  }
}

export function writeBaseManifest(dataDir: string, manifest: WorkHomeManifest): void {
  const path = workHomeBasePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---- coleta local -----------------------------------------------------------

/**
 * Only what the collector reads — NOT the whole sync context. This lets a
 * caller that just wants the local package (the team publish path) build it
 * without inventing a `cloudProfileId` it has no reason to know.
 */
export type WorkHomeCollectContext = Pick<
  WorkHomeSyncContext,
  "homeDir" | "toolRoots" | "enabledTools" | "projectClones" | "stellar"
>;

export function collectLocalWorkHome(ctx: WorkHomeCollectContext): { package: WorkHomePackage; warnings: string[] } {
  const packages: WorkHomePackage[] = [];
  const warnings: string[] = [];
  for (const tool of ctx.enabledTools) {
    const root = ctx.toolRoots[tool];
    if (!root) {
      warnings.push(`${tool}: raiz não informada — não coletada`);
      continue;
    }
    const result = collectWorkHome({
      tool,
      rootDir: root,
      homeDir: ctx.homeDir,
      projectClones: ctx.projectClones,
      stellar: tool === "stellar" ? ctx.stellar : undefined,
    });
    packages.push(result.package);
    for (const w of result.warnings) warnings.push(`${tool}: ${w}`);
  }
  return { package: mergeWorkHomePackages(packages), warnings };
}

function filterManifestByTools(manifest: WorkHomeManifest | null, tools: readonly WorkHomeTool[]): WorkHomeManifest | null {
  if (!manifest) return null;
  const set = new Set(tools);
  const entries = manifest.entries.filter((e) => set.has(e.tool));
  // Remoções não têm tool própria; preserva as que casam com um entry conhecido
  // do próprio manifesto — o filtro por tool é aplicado nos entries.
  return buildManifest(entries, manifest.removals);
}

// ---- PUXAR ------------------------------------------------------------------

export type PullOutcome =
  | { ok: false; error: string }
  | {
      ok: true;
      revision: number;
      /** Manifesto remoto COMPLETO (a base avança para ele após aplicar). */
      remote: WorkHomeManifest;
      /** Pacote pronto para aplicar (manifesto filtrado por tool + blobs baixados). */
      incoming: WorkHomePackage;
      plan: WorkHomeApplyPlan;
      warnings: string[];
    };

/**
 * Puxa a casa: manifesto remoto → baixa os blobs que faltam → plano de prévia.
 * Não escreve no disco do usuário; quem aplica é `applyPulledWorkHome`.
 */
export async function pullWorkHome(ctx: WorkHomeSyncContext, base: WorkHomeManifest | null): Promise<PullOutcome> {
  const house = await ctx.api.getHouseManifest(ctx.token, ctx.cloudProfileId);
  if (!house.ok) return { ok: false, error: house.error.message };
  const remote = fromRemoteEntries(house.value.manifest);

  const blobs = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  const targetCtx = { toolRoots: ctx.toolRoots, homeDir: ctx.homeDir, projectClones: ctx.projectClones };

  for (const entry of remote.entries) {
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

  const incoming: WorkHomePackage = { manifest: filterManifestByTools(remote, ctx.enabledTools) ?? remote, blobs };
  const plan = planWorkHomeApply({
    incoming,
    base: filterManifestByTools(base, ctx.enabledTools),
    toolRoots: ctx.toolRoots,
    homeDir: ctx.homeDir,
    projectClones: ctx.projectClones,
    shaOf: sha256FileSync,
  });
  return { ok: true, revision: house.value.revision, remote, incoming, plan, warnings };
}

/** Aplica um pull já pré-visto. O chamador grava a base quando não há pendência. */
export function applyPulledWorkHome(input: {
  incoming: WorkHomePackage;
  plan: WorkHomeApplyPlan;
  choices?: Readonly<Record<string, WorkHomeConflictChoice>>;
  backupRoot: string;
  now: number;
  pathValues: PathValueContext;
}): WorkHomeApplyResult {
  return applyWorkHomePlan({
    plan: input.plan,
    blobs: input.incoming.blobs,
    choices: input.choices,
    backupRoot: input.backupRoot,
    now: input.now,
    pathValues: input.pathValues,
  });
}

// ---- EMPURRAR ---------------------------------------------------------------

export type PushOutcome =
  | { ok: false; error: string }
  | { ok: true; kind: "pushed"; revision: number; uploaded: number; manifest: WorkHomeManifest; warnings: string[] }
  | {
      ok: true;
      kind: "conflicts";
      conflicts: PushConflict[];
      /** Manifesto tentativo (por path; conflitos com a versão LOCAL). */
      manifest: WorkHomeManifest;
      /** Manifesto remoto que gerou os conflitos (para a UI ver o outro lado). */
      remote: WorkHomeManifest;
      revision: number;
      warnings: string[];
    };

async function uploadMissing(
  ctx: WorkHomeSyncContext,
  shas: readonly string[],
  blobs: ReadonlyMap<string, Uint8Array>,
): Promise<{ uploaded: number; warnings: string[] }> {
  const warnings: string[] = [];
  let uploaded = 0;
  if (shas.length === 0) return { uploaded, warnings };
  const check = await ctx.api.checkBlobs(ctx.token, [...shas]);
  if (!check.ok) return { uploaded, warnings: [`blobs/check falhou: ${check.error.message}`] };
  for (const sha of check.value) {
    const bytes = blobs.get(sha);
    if (!bytes) {
      warnings.push(`blob ${sha.slice(0, 8)} falta no remoto e não está no pacote local`);
      continue;
    }
    const put = await ctx.api.putBlob(ctx.token, sha, bytes);
    if (!put.ok) warnings.push(`blob ${sha.slice(0, 8)} não subiu: ${put.error.message}`);
    else uploaded++;
  }
  return { uploaded, warnings };
}

async function putManifest(
  ctx: WorkHomeSyncContext,
  manifest: WorkHomeManifest,
  revision: number,
  lookup: WorkHomeManifest | null,
): Promise<
  | { ok: true; revision: number; manifest: WorkHomeManifest }
  | { ok: false; conflict: true; revision: number; remote: WorkHomeManifest }
  | { ok: false; conflict: false; error: string }
> {
  const { entries, droppedRemovals } = toRemoteEntries(manifest, lookup);
  void droppedRemovals;
  const res = await ctx.api.putHouseManifest(ctx.token, ctx.cloudProfileId, {
    revision,
    manifest: entries,
    installId: ctx.installId,
  });
  if (res.ok) return { ok: true, revision: res.value.revision, manifest: fromRemoteEntries(res.value.manifest) };
  if (res.conflict) {
    return { ok: false, conflict: true, revision: res.currentRevision, remote: fromRemoteEntries(res.currentManifest) };
  }
  return { ok: false, conflict: false, error: res.error.message };
}

/**
 * Empurra a casa. `local` é injetável (testes); em produção sai de
 * `collectLocalWorkHome`. Em `409`, remergeia contra o remoto atual UMA vez.
 */
export async function pushWorkHome(
  ctx: WorkHomeSyncContext,
  input: { base: WorkHomeManifest | null; local?: WorkHomePackage },
): Promise<PushOutcome> {
  const localPkg = input.local ?? collectLocalWorkHome(ctx).package;
  const base = filterManifestByTools(input.base, ctx.enabledTools);
  const warnings: string[] = [];

  const house = await ctx.api.getHouseManifest(ctx.token, ctx.cloudProfileId);
  if (!house.ok) return { ok: false, error: house.error.message };
  let remote = fromRemoteEntries(house.value.manifest);
  let revision = house.value.revision;

  for (let attempt = 0; attempt < 2; attempt++) {
    const plan: PushPlan = planPush(localPkg.manifest, remote, base);
    if (plan.conflicts.length > 0) {
      return {
        ok: true,
        kind: "conflicts",
        conflicts: plan.conflicts,
        manifest: plan.manifest,
        remote,
        revision,
        warnings,
      };
    }
    const up = await uploadMissing(ctx, plan.shas, localPkg.blobs);
    warnings.push(...up.warnings);
    const put = await putManifest(ctx, plan.manifest, revision, remote);
    if (put.ok) return { ok: true, kind: "pushed", revision: put.revision, uploaded: up.uploaded, manifest: put.manifest, warnings };
    if (!put.conflict) return { ok: false, error: put.error };
    // 409: remergeia contra o remoto atual e tenta de novo.
    remote = put.remote;
    revision = put.revision;
    warnings.push("revisão divergente; mergeando com o manifesto atual");
  }
  return { ok: false, error: "duas tentativas de PUT e a revisão continuou divergente" };
}

/** Empurra com as escolhas da UI para os conflitos (manter local/remoto/both). */
export async function pushResolvedConflicts(
  ctx: WorkHomeSyncContext,
  input: {
    base: WorkHomeManifest | null;
    manifest: WorkHomeManifest;
    conflicts: readonly PushConflict[];
    remote: WorkHomeManifest;
    revision: number;
    choices: Readonly<Record<string, "local" | "remote" | "both">>;
    local?: WorkHomePackage;
  },
): Promise<PushOutcome> {
  const resolved = resolvePushConflicts({
    manifest: input.manifest,
    conflicts: input.conflicts,
    remote: input.remote,
    choices: input.choices,
  });
  const localPkg = input.local ?? collectLocalWorkHome(ctx).package;
  const shas = [...new Set(resolved.entries.map((e: WorkHomeManifestEntry) => e.sha256))];
  const up = await uploadMissing(ctx, shas, localPkg.blobs);
  const put = await putManifest(ctx, resolved, input.revision, input.remote);
  if (put.ok) {
    return { ok: true, kind: "pushed", revision: put.revision, uploaded: up.uploaded, manifest: put.manifest, warnings: up.warnings };
  }
  if (put.conflict) {
    return { ok: false, error: "revisão mudou de novo durante a resolução; sincronize de novo" };
  }
  return { ok: false, error: put.error };
}
