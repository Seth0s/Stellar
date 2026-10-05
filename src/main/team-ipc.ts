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
  acceptTeamTaskOp,
  appendTeamQueue,
  applyTeamHouse,
  archiveTeamTaskOp,
  assignTeamTaskOp,
  autoDispatchTeamTaskOp,
  changeTeamMemberRole,
  claimTeamTaskOp,
  commentTeamTaskOp,
  createAccountTeam,
  createTeamInvite,
  createTeamTaskOp,
  decideTeamClaimOp,
  deleteTeamTaskOp,
  fetchTeamDetail,
  fetchTeamOverview,
  fetchTeamTask,
  fetchTeamTasks,
  leaveTeam,
  listTeamInvites,
  listTeamSprintsOp,
  moveTeamTaskStateOp,
  previewTeamPublish,
  publishTeamHouse,
  pullTeamHouse,
  readTeamQueue,
  reconcileTeamQueue,
  removeTeamMember,
  reportTeamTaskStateOp,
  restoreTeamTaskOp,
  returnTeamTaskOp,
  revokeTeamInvite,
  updateTeamTaskOp,
  type TeamActiveProfile,
  type TeamContext,
} from "./team";
import type { TeamRole } from "./team-decision";
import { TEAM_TASK_PURPOSE, localGateCommands, teamTaskPrompt, type TeamTaskView } from "./team-task-decision";
import type { TaskPurpose } from "../task-purpose";
import type { WorkHomeConflictChoice } from "./work-home-apply-decision";

export type LocalTeamTaskInput = {
  boardId: string;
  prompt: string;
  provider: string | null;
  purpose: TaskPurpose;
  territory: string[];
  gates: string[];
  allowCommit: boolean;
  reportSchema: string[];
};

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
  /** Creates the LOCAL Fila task the team task bridges into (accept). The main
   *  process owns the store; this module stays free of it. */
  createLocalTeamTask: (input: LocalTeamTaskInput) => { ok: true; taskId: string } | { ok: false; error: string };
  /** Local Fila task of a bridged entry, for the state reconcile: the stored
   *  status plus whether a card is live on it (this app never stores `running`). */
  getLocalTaskStatus: (taskId: string) => { status: string; cardAlive: boolean } | null;
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

  ipcMain.handle("team:invites", async (_e, teamId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    return listTeamInvites(built.ctx, teamId);
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

  // ---- TEAM TASKS (B7) ------------------------------------------------------

  const asStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

  ipcMain.handle("team:tasks-list", async (_e, teamId: unknown, filter: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    const f = rec(filter);
    return fetchTeamTasks(built.ctx, teamId, {
      state: asStr(f.state) ?? undefined,
      assignee: asStr(f.assignee) ?? undefined,
      sprint: asStr(f.sprint) ?? undefined,
      project: asStr(f.project) ?? undefined,
      unassigned: f.unassigned === true,
      includeArchived: f.includeArchived === true,
      q: asStr(f.q) ?? undefined,
    });
  });

  ipcMain.handle("team:task-detail", async (_e, teamId: unknown, taskId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    return fetchTeamTask(built.ctx, teamId, taskId);
  });

  ipcMain.handle("team:task-create", async (_e, teamId: unknown, input: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    return createTeamTaskOp(built.ctx, teamId, rec(input));
  });

  ipcMain.handle("team:task-update", async (_e, teamId: unknown, taskId: unknown, body: unknown, version: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, conflict: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string" || typeof version !== "number") {
      return { ok: false as const, conflict: false as const, error: "task inválida" };
    }
    return updateTeamTaskOp(built.ctx, teamId, taskId, rec(body), version);
  });

  ipcMain.handle("team:task-assign", async (_e, teamId: unknown, taskId: unknown, body: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    const b = rec(body);
    return assignTeamTaskOp(built.ctx, teamId, taskId, {
      ...(asStr(b.assignee_id) ? { assignee_id: asStr(b.assignee_id) as string } : {}),
      ...(asStr(b.session_label) ? { session_label: asStr(b.session_label) as string } : {}),
      ...(b.unassign === true ? { unassign: true } : {}),
    });
  });

  /** ACCEPT + BRIDGE: creates the LOCAL Fila task in the chosen board, marked
   *  "do time", carrying the contract, territory and gates — the code never
   *  leaves the machine. */
  ipcMain.handle("team:task-accept", async (_e, teamId: unknown, taskId: unknown, input: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    const boardId = asStr(rec(input).boardId);
    if (!boardId) return { ok: false as const, error: "escolha um board local para a Fila" };
    const accepted = await acceptTeamTaskOp(built.ctx, teamId, taskId);
    if (!accepted.ok) return accepted;
    const task: TeamTaskView = accepted.task;
    const created = deps.createLocalTeamTask({
      boardId,
      prompt: teamTaskPrompt(task, accepted.contract),
      provider: task.provider !== "" ? task.provider : null,
      purpose: TEAM_TASK_PURPOSE[task.kind],
      territory: task.territory,
      gates: localGateCommands(task.gates),
      allowCommit: task.allowCommit,
      reportSchema: task.reportSchema,
    });
    if (!created.ok) return created;
    appendTeamQueue(built.ctx.activeProfile.dir, {
      localTaskId: created.taskId,
      boardId,
      teamId,
      teamTaskId: task.id,
      ref: task.ref,
      title: task.title,
      reportDelivered: false,
      acceptedAt: deps.now(),
    });
    return { ok: true as const, task, localTaskId: created.taskId };
  });

  ipcMain.handle("team:task-return", async (_e, teamId: unknown, taskId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    return returnTeamTaskOp(built.ctx, teamId, taskId);
  });

  ipcMain.handle("team:task-claim", async (_e, teamId: unknown, taskId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    return claimTeamTaskOp(built.ctx, teamId, taskId);
  });

  ipcMain.handle("team:task-claim-decide", async (_e, teamId: unknown, taskId: unknown, claimId: unknown, approve: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string" || typeof claimId !== "string") {
      return { ok: false as const, error: "pedido inválido" };
    }
    return decideTeamClaimOp(built.ctx, teamId, taskId, claimId, approve === true);
  });

  ipcMain.handle("team:task-auto-dispatch", async (_e, teamId: unknown, taskId: unknown, enabled: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    return autoDispatchTeamTaskOp(built.ctx, teamId, taskId, enabled === true);
  });

  ipcMain.handle("team:task-move", async (_e, teamId: unknown, taskId: unknown, state: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string" || typeof state !== "string") {
      return { ok: false as const, error: "task inválida" };
    }
    return moveTeamTaskStateOp(built.ctx, teamId, taskId, state);
  });

  ipcMain.handle("team:task-comment", async (_e, teamId: unknown, taskId: unknown, body: unknown, mentions: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string" || typeof body !== "string") {
      return { ok: false as const, error: "comentário inválido" };
    }
    const ids = Array.isArray(mentions) ? mentions.filter((m): m is string => typeof m === "string") : [];
    return commentTeamTaskOp(built.ctx, teamId, taskId, body, ids);
  });

  ipcMain.handle("team:task-archive", async (_e, teamId: unknown, taskId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    return archiveTeamTaskOp(built.ctx, teamId, taskId);
  });

  ipcMain.handle("team:task-restore", async (_e, teamId: unknown, taskId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    return restoreTeamTaskOp(built.ctx, teamId, taskId);
  });

  ipcMain.handle("team:task-delete", async (_e, teamId: unknown, taskId: unknown, confirm: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string" || typeof confirm !== "string") {
      return { ok: false as const, error: "task inválida" };
    }
    return deleteTeamTaskOp(built.ctx, teamId, taskId, confirm);
  });

  ipcMain.handle("team:task-report", async (_e, teamId: unknown, taskId: unknown, report: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string" || typeof taskId !== "string") return { ok: false as const, error: "task inválida" };
    const r = rec(report);
    return reportTeamTaskStateOp(built.ctx, teamId, taskId, {
      ...(asStr(r.state) ? { state: asStr(r.state) as string } : {}),
      ...(typeof r.report_delivered === "boolean" ? { report_delivered: r.report_delivered } : {}),
      ...(typeof r.gates_passed === "number" ? { gates_passed: r.gates_passed } : {}),
      ...(typeof r.gates_total === "number" ? { gates_total: r.gates_total } : {}),
      ...(asStr(r.verdict) ? { verdict: asStr(r.verdict) as string } : {}),
    });
  });

  ipcMain.handle("team:sprints", async (_e, teamId: unknown) => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    if (typeof teamId !== "string") return { ok: false as const, error: "time inválido" };
    return listTeamSprintsOp(built.ctx, teamId);
  });

  const queueWithStatus = (profileDir: string) =>
    readTeamQueue(profileDir).map((e) => ({ ...e, localStatus: deps.getLocalTaskStatus(e.localTaskId)?.status ?? null }));

  ipcMain.handle("team:queue", async () => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    return { ok: true as const, entries: queueWithStatus(built.ctx.activeProfile.dir) };
  });

  ipcMain.handle("team:queue-sync", async () => {
    const built = await context();
    if (!built.ok) return { ok: false as const, error: built.error };
    const synced = await reconcileTeamQueue(built.ctx, deps.getLocalTaskStatus);
    return { ok: true as const, reports: synced.reports, entries: queueWithStatus(built.ctx.activeProfile.dir) };
  });
}
