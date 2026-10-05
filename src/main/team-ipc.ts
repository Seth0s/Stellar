/**
 * TEAMS IN THE APP — the IPC surface.
 *
 * Registers the `team:*` handlers the UI uses: overview, create, detail,
 * invite/revoke, change role, remove/leave, preview+publish the base, and
 * preview+apply the (prefixed) base into the team profile. The logic lives in
 * `team.ts`/`team-decision.ts`; here there is only wiring and the assembly of
 * the `TeamContext` from the ACTIVE profile.
 *
 * Every handler requires a login: no account, no team. Absence is stated — the
 * error names what is missing instead of returning an empty state.
 */

import { ipcMain } from "electron";
import { createCloudApi, type CloudApi } from "./cloud-api";
import {
  acceptTeamInvite,
  applyTeamHouse,
  changeTeamMemberRole,
  createAccountTeam,
  createTeamInvite,
  fetchTeamDetail,
  fetchTeamOverview,
  leaveTeam,
  previewTeamPublish,
  publishTeamHouse,
  pullTeamHouse,
  removeTeamMember,
  revokeTeamInvite,
  type TeamActiveProfile,
  type TeamContext,
} from "./team";
import type { TeamRole } from "./team-decision";
import type { WorkHomeConflictChoice } from "./work-home-apply-decision";

export type TeamIpcDeps = {
  baseUserDataDir: () => string;
  activeProfile: () => TeamActiveProfile | null;
  homeDir: () => string;
  agentProviders: () => readonly { id: string; supportsConfigHome: boolean }[];
  ensureToken: () => Promise<string | null>;
  apiBaseUrl: () => string;
  installId: () => string;
  now: () => number;
  generateId: () => string;
};

export function registerTeamIpc(deps: TeamIpcDeps): void {
  let api: CloudApi | null = null;
  function cloudApi(): CloudApi {
    return (api ??= createCloudApi({ baseUrl: deps.apiBaseUrl() }));
  }

  async function context(): Promise<{ ok: true; ctx: TeamContext } | { ok: false; error: string }> {
    const profile = deps.activeProfile();
    if (!profile) return { ok: false, error: "sem perfil ativo" };
    const token = await deps.ensureToken();
    if (!token) return { ok: false, error: "não logado na conta Stellar" };
    const ctx: TeamContext = {
      api: cloudApi(),
      token,
      baseUserDataDir: deps.baseUserDataDir(),
      homeDir: deps.homeDir(),
      installId: deps.installId(),
      now: deps.now(),
      generateId: deps.generateId,
      agentProviders: deps.agentProviders(),
      activeProfile: profile,
    };
    return { ok: true, ctx };
  }

  ipcMain.handle("team:overview", async () => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    return fetchTeamOverview(built.ctx);
  });

  ipcMain.handle("team:create", async (_e, input: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    const rec = (typeof input === "object" && input !== null ? input : {}) as { name?: unknown; slug?: unknown };
    if (typeof rec.name !== "string" || rec.name.trim() === "") return { ok: false as const, error: "informe um nome para o time" };
    return createAccountTeam(built.ctx, {
      name: rec.name.trim(),
      slug: typeof rec.slug === "string" && rec.slug.trim() !== "" ? rec.slug.trim() : undefined,
    });
  });

  ipcMain.handle("team:detail", async (_e, teamId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    return fetchTeamDetail(built.ctx, teamId);
  });

  ipcMain.handle("team:invite", async (_e, teamId: unknown, input: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    const rec = (typeof input === "object" && input !== null ? input : {}) as { target?: unknown; role?: unknown };
    if (typeof rec.target !== "string" || typeof rec.role !== "string") return { ok: false as const, reason: "invalid-target" as const, error: "pedido de convite incompleto" };
    return createTeamInvite(built.ctx, teamId, { target: rec.target, role: rec.role as TeamRole });
  });

  ipcMain.handle("team:revoke-invite", async (_e, teamId: unknown, inviteId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof inviteId !== "string") return { ok: false as const, error: "convite inválido" };
    return revokeTeamInvite(built.ctx, teamId, inviteId);
  });

  ipcMain.handle("team:change-role", async (_e, teamId: unknown, accountId: unknown, role: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof accountId !== "string" || typeof role !== "string") {
      return { ok: false as const, error: "pedido de papel incompleto" };
    }
    return changeTeamMemberRole(built.ctx, teamId, accountId, role as TeamRole);
  });

  ipcMain.handle("team:remove-member", async (_e, teamId: unknown, accountId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof accountId !== "string") return { ok: false as const, error: "membro inválido" };
    return removeTeamMember(built.ctx, teamId, accountId);
  });

  ipcMain.handle("team:leave", async (_e, teamId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    return leaveTeam(built.ctx, teamId);
  });

  ipcMain.handle("team:accept-invite", async (_e, token: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, reason: "error" as const, error: built.error };
    if (typeof token !== "string" || token.trim() === "") return { ok: false as const, reason: "not-found" as const, error: "convite sem token" };
    return acceptTeamInvite(built.ctx, token.trim());
  });

  ipcMain.handle("team:publish-preview", async (_e, teamId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    return { ok: true as const, preview: previewTeamPublish(built.ctx) };
  });

  ipcMain.handle("team:publish", async (_e, teamId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, conflict: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, conflict: false as const, error: "time inválido" };
    return publishTeamHouse(built.ctx, teamId);
  });

  ipcMain.handle("team:pull-preview", async (_e, teamId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, reason: "error" as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, reason: "error" as const, error: "time inválido" };
    return pullTeamHouse(built.ctx, teamId);
  });

  ipcMain.handle("team:pull-apply", async (_e, teamId: unknown, choices: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, reason: "error" as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, reason: "error" as const, error: "time inválido" };
    const map = (typeof choices === "object" && choices !== null ? choices : {}) as Record<string, WorkHomeConflictChoice>;
    return applyTeamHouse(built.ctx, teamId, map);
  });
}
