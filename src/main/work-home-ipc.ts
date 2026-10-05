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
  pullWorkHome,
  pushResolvedConflicts,
  pushWorkHome,
  readBaseManifest,
  writeBaseManifest,
  type WorkHomeSyncContext,
} from "./work-home-sync";
import { readWorkHomePrefs, resolveWorkHomeToolRoots, writeWorkHomePrefs, type WorkHomePrefs } from "./work-home-profile";
import { applyCopyFromSystem, previewCopyFromSystem } from "./profile-home-copy";
import { collectWorkHome } from "./work-home-collect";
import { discoverProjectClones } from "./work-home-remap";
import { projectIdOf, relPathOf, WORK_HOME_TOOLS, isWorkHomeTool, type WorkHomeTool } from "./work-home-manifest";
import type { ProviderHomeMode } from "./config-home-decision";
import type { WorkHomeConflictChoice } from "./work-home-apply-decision";

export type ActiveProfileInfo = {
  id: string;
  /** Diretório do perfil (`profiles/<id>`). */
  dir: string;
  homeMode: ProviderHomeMode;
};

export type WorkHomeIpcDeps = {
  activeProfile: () => ActiveProfileInfo | null;
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
  enabledTools: WorkHomeTool[];
  toolRoots: Partial<Record<WorkHomeTool, string>>;
  workFolders: string[];
  lastRevision: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
};

export function registerWorkHomeIpc(deps: WorkHomeIpcDeps): void {
  let api: CloudApi | null = null;
  function cloudApi(): CloudApi {
    return (api ??= createCloudApi({ baseUrl: deps.apiBaseUrl() }));
  }

  function prefsOf(profile: ActiveProfileInfo): WorkHomePrefs {
    return readWorkHomePrefs(profile.dir);
  }

  function toolRootsOf(profile: ActiveProfileInfo): Partial<Record<WorkHomeTool, string>> {
    return resolveWorkHomeToolRoots({
      homeDir: deps.homeDir(),
      profileDir: profile.dir,
      homeMode: profile.homeMode,
      providers: deps.agentProviders(),
    });
  }

  function status(): Status {
    const profile = deps.activeProfile();
    if (!profile) {
      return {
        loggedIn: false,
        profileId: null,
        enabledTools: [...WORK_HOME_TOOLS],
        toolRoots: {},
        workFolders: [],
        lastRevision: null,
        lastSyncAt: null,
        lastError: null,
      };
    }
    const prefs = prefsOf(profile);
    return {
      loggedIn: true,
      profileId: profile.id,
      enabledTools: prefs.enabledTools,
      toolRoots: toolRootsOf(profile),
      workFolders: prefs.workFolders,
      lastRevision: prefs.lastRevision,
      lastSyncAt: prefs.lastSyncAt,
      lastError: prefs.lastError,
    };
  }

  /** Monta o contexto do sync para o perfil ativo; `null`/erro viram um
   *  resultado honesto (nunca inventam um perfil). */
  async function buildContext(): Promise<{ ok: true; ctx: WorkHomeSyncContext; profile: ActiveProfileInfo } | { ok: false; error: string }> {
    const profile = deps.activeProfile();
    if (!profile) return { ok: false, error: "sem perfil ativo" };
    const token = await deps.ensureToken();
    if (!token) return { ok: false, error: "não logado na conta Stellar" };
    const prefs = prefsOf(profile);
    const ctx: WorkHomeSyncContext = {
      api: cloudApi(),
      token,
      profileId: profile.id,
      installId: deps.installId(),
      homeDir: deps.homeDir(),
      toolRoots: toolRootsOf(profile),
      enabledTools: prefs.enabledTools,
      projectClones: discoverProjectClones(prefs.workFolders),
    };
    return { ok: true, ctx, profile };
  }

  function remember(profile: ActiveProfileInfo, patch: Partial<WorkHomePrefs>): void {
    writeWorkHomePrefs(profile.dir, { ...readWorkHomePrefs(profile.dir), ...patch });
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
    for (const tool of WORK_HOME_TOOLS) {
      const root = roots[tool];
      if (!root) continue;
      try {
        const { package: pkg } = collectWorkHome({ tool, rootDir: root, homeDir: deps.homeDir(), projectClones });
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
    return { ok: true as const, tools };
  });

  ipcMain.handle("workhome:set-tools", (_e, tools: unknown) => {
    const profile = deps.activeProfile();
    if (!profile) return status();
    const enabled = Array.isArray(tools) ? tools.filter(isWorkHomeTool) : [...WORK_HOME_TOOLS];
    remember(profile, { enabledTools: enabled });
    return status();
  });

  ipcMain.handle("workhome:set-work-folders", (_e, folders: unknown) => {
    const profile = deps.activeProfile();
    if (!profile) return status();
    const next = Array.isArray(folders)
      ? folders.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim())
      : [];
    remember(profile, { workFolders: next });
    return status();
  });

  // A base local (última revisão sincronizada) vive no diretório do perfil.
  function baseOf(profile: ActiveProfileInfo) {
    return readBaseManifest(profile.dir);
  }

  ipcMain.handle("workhome:preview", async () => {
    const built = await buildContext();
    if (!built.ok) return { ok: false as const, error: built.error };
    const pulled = await pullWorkHome(built.ctx, baseOf(built.profile));
    if (!pulled.ok) {
      return { ok: false as const, error: pulled.error };
    }
    return { ok: true as const, revision: pulled.revision, plan: pulled.plan, warnings: pulled.warnings };
  });

  ipcMain.handle("workhome:apply", async (_e, choices: unknown) => {
    const built = await buildContext();
    if (!built.ok) return { ok: false as const, error: built.error };
    const pulled = await pullWorkHome(built.ctx, baseOf(built.profile));
    if (!pulled.ok) return { ok: false as const, error: pulled.error };
    const result = applyPulledWorkHome({
      incoming: pulled.incoming,
      plan: pulled.plan,
      choices: (choices && typeof choices === "object" ? choices : {}) as Record<string, WorkHomeConflictChoice>,
      backupRoot: join(built.profile.dir, "backups"),
      now: deps.now(),
      pathValues: { homeDir: built.ctx.homeDir, projectClones: built.ctx.projectClones },
    });
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
    const built = await buildContext();
    if (!built.ok) return { ok: false as const, error: built.error };
    const out = await pushWorkHome(built.ctx, { base: baseOf(built.profile) });
    if (out.ok && out.kind === "pushed") {
      writeBaseManifest(built.profile.dir, out.manifest);
      remember(built.profile, { lastRevision: out.revision, lastSyncAt: deps.now(), lastError: out.warnings[0] ?? null });
    } else if (!out.ok) {
      remember(built.profile, { lastError: out.error });
    }
    return out;
  });

  ipcMain.handle("workhome:resolve-conflicts", async (_e, payload: unknown) => {
    const built = await buildContext();
    if (!built.ok) return { ok: false as const, error: built.error };
    const rec = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (!rec.manifest || !Array.isArray(rec.conflicts) || !rec.remote || typeof rec.revision !== "number") {
      return { ok: false as const, error: "payload de conflito incompleto" };
    }
    const out = await pushResolvedConflicts(built.ctx, {
      base: baseOf(built.profile),
      manifest: rec.manifest as never,
      conflicts: rec.conflicts as never,
      remote: rec.remote as never,
      revision: rec.revision,
      choices: (rec.choices && typeof rec.choices === "object" ? rec.choices : {}) as Record<string, "local" | "remote" | "both">,
    });
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
    return { ok: true as const, result };
  });
}
