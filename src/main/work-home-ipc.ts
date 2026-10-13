/**
 * CASA DE TRABALHO — a superfície IPC (A3b, BACKEND_V1.md §5).
 *
 * Registra os handlers `workhome:*` que a UI do perfil usa: estado, liga/desliga
 * por ferramenta, pastas de trabalho, prévia, aplicar, sincronizar agora,
 * resolver conflitos e "copiar do sistema". Toda a lógica mora nos módulos
 * puros/casca (`work-home-sync`, `work-home-apply`, `profile-home-copy`); aqui
 * só há o encanamento — e a montagem da `WorkHomeSyncContext` a partir do PERFIL
 * ativo (raízes da A3c, identidade, pastas de trabalho).
 */

import { ipcMain } from "electron";
import { join } from "node:path";
import { createCloudApi, type CloudApi } from "./cloud-api";
import {
  applyPulledWorkHome,
  collectLocalWorkHome,
  pullWorkHome,
  pushResolvedConflicts,
  pushWorkHome,
  readBaseManifest,
  writeBaseManifest,
  type WorkHomeSyncContext,
} from "./work-home-sync";
import { readWorkHomePrefs, resolveWorkHomeToolRoots, writeWorkHomePrefs, type WorkHomePrefs } from "./work-home-profile";
import { ensureCloudProfileId } from "./profiles-cloud";
import { applyCopyFromSystem, previewCopyFromSystem } from "./profile-home-copy";
import { collectWorkHome } from "./work-home-collect";
import { discoverProjectClones } from "./work-home-remap";
import {
  buildManifest,
  manifestByPath,
  projectIdOf,
  relPathOf,
  WORK_HOME_TOOLS,
  isWorkHomeTool,
  type WorkHomeManifest,
  type WorkHomeManifestEntry,
  type WorkHomeTool,
} from "./work-home-manifest";
import type { ProviderHomeMode } from "./config-home-decision";
import type { WorkHomeConflictChoice } from "./work-home-apply-decision";
import { createWorkHomePendingCache, decideWorkHomeSync, deriveWorkHomeSyncStatus } from "./work-home-sync-decision";

export type ActiveProfileInfo = {
  id: string;
  /** Diretório do perfil (`profiles/<id>`). */
  dir: string;
  homeMode: ProviderHomeMode;
};

export type WorkHomeIpcDeps = {
  activeProfile: () => ActiveProfileInfo | null;
  /** Root of `userData` — where `profiles.json` lives (the local→server link). */
  baseUserDataDir: () => string;
  homeDir: () => string;
  /** Providers de agente: id + se declaram `configHome` (A3c). */
  agentProviders: () => readonly { id: string; supportsConfigHome: boolean }[];
  /** Access token válido, renovando antes de expirar. `null` = precisa entrar. */
  ensureToken: () => Promise<string | null>;
  apiBaseUrl: () => string;
  installId: () => string;
  now: () => number;
};

type Status = {
  loggedIn: boolean;
  profileId: string | null;
  autoSync: boolean;
  enabledTools: WorkHomeTool[];
  toolRoots: Partial<Record<WorkHomeTool, string>>;
  workFolders: string[];
  lastRevision: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  syncStatus: ReturnType<typeof deriveWorkHomeSyncStatus>;
};

export function registerWorkHomeIpc(deps: WorkHomeIpcDeps): void {
  let api: CloudApi | null = null;
  const syncingProfiles = new Set<string>();
  const pendingCache = createWorkHomePendingCache();
  async function trackSync<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    syncingProfiles.add(profileId);
    try {
      return await operation();
    } finally {
      syncingProfiles.delete(profileId);
      pendingCache.invalidate(profileId);
    }
  }
  function cloudApi(): CloudApi {
    return (api ??= createCloudApi({ baseUrl: deps.apiBaseUrl() }));
  }

  function prefsOf(profile: ActiveProfileInfo): WorkHomePrefs {
    return readWorkHomePrefs(profile.dir, { defaultEnabledTools: [] });
  }

  function toolRootsOf(profile: ActiveProfileInfo): Partial<Record<WorkHomeTool, string>> {
    return resolveWorkHomeToolRoots({
      homeDir: deps.homeDir(),
      profileDir: profile.dir,
      homeMode: profile.homeMode,
      providers: deps.agentProviders(),
    });
  }

  function pendingForManifest(profile: ActiveProfileInfo, local: WorkHomeManifest): boolean {
    const localByPath = manifestByPath(local);
    const baseByPath = manifestByPath(baseOf(profile));
    if (localByPath.size !== baseByPath.size) return true;
    for (const [path, entry] of localByPath) {
      const synced = baseByPath.get(path);
      if (synced?.sha256 !== entry.sha256 || synced.mode !== entry.mode) return true;
    }
    return false;
  }

  function hasPendingLocalChanges(profile: ActiveProfileInfo): boolean {
    const prefs = prefsOf(profile);
    return pendingCache.get(profile.id, deps.now(), prefs.lastSyncAt, () => {
      if (prefs.enabledTools.length === 0) return false;
      try {
        const local = collectLocalWorkHome({
          homeDir: deps.homeDir(),
          toolRoots: toolRootsOf(profile),
          enabledTools: prefs.enabledTools,
          projectClones: discoverProjectClones(prefs.workFolders),
        }).package.manifest;
        return pendingForManifest(profile, local);
      } catch {
        return false;
      }
    });
  }

  function status(): Status {
    const profile = deps.activeProfile();
    if (!profile) {
      return {
        loggedIn: false,
        profileId: null,
        autoSync: false,
        enabledTools: [],
        toolRoots: {},
        workFolders: [],
        lastRevision: null,
        lastSyncAt: null,
        lastError: null,
        syncStatus: { kind: "never" },
      };
    }
    const prefs = prefsOf(profile);
    return {
      loggedIn: true,
      profileId: profile.id,
      autoSync: prefs.autoSync,
      enabledTools: prefs.enabledTools,
      toolRoots: toolRootsOf(profile),
      workFolders: prefs.workFolders,
      lastRevision: prefs.lastRevision,
      lastSyncAt: prefs.lastSyncAt,
      lastError: prefs.lastError,
      syncStatus: deriveWorkHomeSyncStatus({
        lastSyncAt: prefs.lastSyncAt,
        lastError: prefs.lastError,
        syncing: syncingProfiles.has(profile.id),
        pending: hasPendingLocalChanges(profile),
      }),
    };
  }

  /** Builds the sync context for the active profile; `null`/error become an
   *  honest result (never an invented profile). The id used for the house is
   *  the SERVER id: the link is resolved (or created) here, once per profile. */
  async function buildContext(origin: "manual" | "auto"): Promise<{ ok: true; ctx: WorkHomeSyncContext; profile: ActiveProfileInfo } | { ok: false; error: string }> {
    const profile = deps.activeProfile();
    if (!profile) return { ok: false, error: "sem perfil ativo" };
    if (!decideWorkHomeSync(origin, prefsOf(profile).autoSync).allowed) {
      return { ok: false, error: "sincronização automática da casa desativada neste perfil" };
    }
    const token = await deps.ensureToken();
    if (!token) return { ok: false, error: "não logado na conta Stellar" };
    const linked = await ensureCloudProfileId({
      api: cloudApi(),
      token,
      baseUserDataDir: deps.baseUserDataDir(),
      localProfileId: profile.id,
    });
    if (!linked.ok) return { ok: false, error: linked.error };
    const prefs = prefsOf(profile);
    const ctx: WorkHomeSyncContext = {
      api: cloudApi(),
      token,
      cloudProfileId: linked.cloudProfileId,
      installId: deps.installId(),
      homeDir: deps.homeDir(),
      toolRoots: toolRootsOf(profile),
      enabledTools: prefs.enabledTools,
      projectClones: discoverProjectClones(prefs.workFolders),
    };
    return { ok: true, ctx, profile };
  }

  function remember(profile: ActiveProfileInfo, patch: Partial<WorkHomePrefs>): void {
    writeWorkHomePrefs(profile.dir, { ...prefsOf(profile), ...patch });
  }

  ipcMain.handle("workhome:status", () => status());

  /**
   * Per-tool counts for the Work home screen. Runs the collector over each
   * tool root and tallies its manifest by category — the same collector that
   * decides what travels, so the count and the package cannot disagree.
   */
  ipcMain.handle("workhome:tool-summary", () => {
    const profile = deps.activeProfile();
    if (!profile) return { ok: false as const, reason: "no-profile" as const };
    const roots = toolRootsOf(profile);
    const prefs = prefsOf(profile);
    const projectClones = discoverProjectClones(prefs.workFolders);
    const tools: Partial<Record<WorkHomeTool, { skills: number; agents: number; memories: number; rules: number; files: number }>> = {};
    const selectedEntries: WorkHomeManifestEntry[] = [];
    for (const tool of WORK_HOME_TOOLS) {
      const root = roots[tool];
      if (!root) continue;
      try {
        const { package: pkg } = collectWorkHome({ tool, rootDir: root, homeDir: deps.homeDir(), projectClones });
        if (prefs.enabledTools.includes(tool)) selectedEntries.push(...pkg.manifest.entries);
        let skills = 0;
        let agents = 0;
        let rules = 0;
        const memoryProjects = new Set<string>();
        for (const entry of pkg.manifest.entries) {
          const rel = relPathOf(entry.path);
          const projectId = projectIdOf(entry.path);
          if (projectId !== null && rel.startsWith("memory")) memoryProjects.add(projectId);
          else if (rel.startsWith("skills/") || rel.includes("/skills/")) skills++;
          else if (rel.startsWith("agents/") || rel.includes("/agents/")) agents++;
          else if (/^(CLAUDE|AGENTS|GEMINI)\.md$/.test(rel)) rules++;
        }
        tools[tool] = { skills, agents, memories: memoryProjects.size, rules, files: pkg.manifest.entries.length };
      } catch {
        /* a root that cannot be read contributes no counts — never invented */
      }
    }
    if (prefs.lastSyncAt !== null) {
      pendingCache.set(profile.id, deps.now(), prefs.lastSyncAt, pendingForManifest(profile, buildManifest(selectedEntries)));
    }
    return { ok: true as const, tools };
  });

  ipcMain.handle("workhome:set-tools", (_e, tools: unknown) => {
    const profile = deps.activeProfile();
    if (!profile) return status();
    const enabled = Array.isArray(tools) ? tools.filter(isWorkHomeTool) : [];
    remember(profile, { enabledTools: enabled });
    pendingCache.invalidate(profile.id);
    return status();
  });

  ipcMain.handle("workhome:set-auto-sync", (_e, enabled: unknown) => {
    const profile = deps.activeProfile();
    if (!profile) return status();
    remember(profile, { autoSync: enabled === true });
    return status();
  });

  ipcMain.handle("workhome:set-work-folders", (_e, folders: unknown) => {
    const profile = deps.activeProfile();
    if (!profile) return status();
    const next = Array.isArray(folders)
      ? folders.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim())
      : [];
    remember(profile, { workFolders: next });
    pendingCache.invalidate(profile.id);
    return status();
  });

  // A base local (última revisão sincronizada) vive no diretório do perfil.
  function baseOf(profile: ActiveProfileInfo) {
    return readBaseManifest(profile.dir);
  }

  ipcMain.handle("workhome:preview", async () => {
    const built = await buildContext("manual");
    if (!built.ok) return { ok: false as const, error: built.error };
    const pulled = await trackSync(built.profile.id, () => pullWorkHome(built.ctx, baseOf(built.profile)));
    if (!pulled.ok) {
      remember(built.profile, { lastError: pulled.error });
      return { ok: false as const, error: pulled.error };
    }
    return { ok: true as const, revision: pulled.revision, plan: pulled.plan, warnings: pulled.warnings };
  });

  ipcMain.handle("workhome:apply", async (_e, choices: unknown) => {
    const built = await buildContext("manual");
    if (!built.ok) return { ok: false as const, error: built.error };
    const pulled = await trackSync(built.profile.id, () => pullWorkHome(built.ctx, baseOf(built.profile)));
    if (!pulled.ok) {
      remember(built.profile, { lastError: pulled.error });
      return { ok: false as const, error: pulled.error };
    }
    const result = applyPulledWorkHome({
      incoming: pulled.incoming,
      plan: pulled.plan,
      choices: (choices && typeof choices === "object" ? choices : {}) as Record<string, WorkHomeConflictChoice>,
      backupRoot: join(built.profile.dir, "backups"),
      now: deps.now(),
      pathValues: { homeDir: built.ctx.homeDir, projectClones: built.ctx.projectClones },
    });
    pendingCache.invalidate(built.profile.id);
    // A base só avança quando não sobrou conflito/pendência: nada é declarado
    // sincronizado enquanto houver trabalho por resolver.
    if (result.conflicts.length === 0 && result.pending.length === 0) {
      writeBaseManifest(built.profile.dir, pulled.remote);
    }
    remember(built.profile, {
      lastRevision: pulled.revision,
      lastSyncAt: deps.now(),
      lastError: result.warnings.length > 0 ? result.warnings[0] : null,
    });
    return { ok: true as const, result, baseUpdated: result.conflicts.length === 0 && result.pending.length === 0 };
  });

  ipcMain.handle("workhome:sync-now", async () => {
    const built = await buildContext("manual");
    if (!built.ok) return { ok: false as const, error: built.error };
    const out = await trackSync(built.profile.id, () => pushWorkHome(built.ctx, { base: baseOf(built.profile) }));
    if (out.ok && out.kind === "pushed") {
      writeBaseManifest(built.profile.dir, out.manifest);
      remember(built.profile, { lastRevision: out.revision, lastSyncAt: deps.now(), lastError: out.warnings[0] ?? null });
    } else if (!out.ok) {
      remember(built.profile, { lastError: out.error });
    }
    return out;
  });

  ipcMain.handle("workhome:resolve-conflicts", async (_e, payload: unknown) => {
    const built = await buildContext("manual");
    if (!built.ok) return { ok: false as const, error: built.error };
    const rec = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (!rec.manifest || !Array.isArray(rec.conflicts) || !rec.remote || typeof rec.revision !== "number") {
      return { ok: false as const, error: "payload de conflito incompleto" };
    }
    const revision = rec.revision;
    const out = await trackSync(built.profile.id, () => pushResolvedConflicts(built.ctx, {
      base: baseOf(built.profile),
      manifest: rec.manifest as never,
      conflicts: rec.conflicts as never,
      remote: rec.remote as never,
      revision,
      choices: (rec.choices && typeof rec.choices === "object" ? rec.choices : {}) as Record<string, "local" | "remote" | "both">,
    }));
    if (out.ok && out.kind === "pushed") {
      writeBaseManifest(built.profile.dir, out.manifest);
      remember(built.profile, { lastRevision: out.revision, lastSyncAt: deps.now(), lastError: out.warnings[0] ?? null });
    } else if (!out.ok) {
      remember(built.profile, { lastError: out.error });
    }
    return out;
  });

  ipcMain.handle("workhome:copy-preview", (_e, providerId: unknown) => {
    const profile = deps.activeProfile();
    if (!profile || typeof providerId !== "string") return { ok: false as const, reason: "unsupported-provider" as const };
    const preview = previewCopyFromSystem({ providerId, profileDir: profile.dir, homeDir: deps.homeDir() });
    if (!preview.ok) return preview;
    return { ok: true as const, providerId, tool: preview.tool, source: preview.source, destination: preview.destination, plan: preview.plan, warnings: preview.warnings };
  });

  ipcMain.handle("workhome:copy-apply", (_e, providerId: unknown) => {
    const profile = deps.activeProfile();
    if (!profile || typeof providerId !== "string") return { ok: false as const, reason: "unsupported-provider" as const };
    const preview = previewCopyFromSystem({ providerId, profileDir: profile.dir, homeDir: deps.homeDir() });
    if (!preview.ok) return preview;
    const result = applyCopyFromSystem({ preview, backupRoot: join(profile.dir, "backups"), now: deps.now() });
    pendingCache.invalidate(profile.id);
    return { ok: true as const, result };
  });
}
