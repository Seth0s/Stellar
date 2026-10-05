/**
 * TEAM BOARD — pure presentation decisions for telas 11/12 (no React, no I/O).
 *
 * The component renders; the rules live here so they can be tested (same
 * pattern as `task-board-model.ts`/`home-decisions.ts`). The permission mirror
 * is the UI's copy of the server's `can(...)`; the server remains the authority.
 */

import type {
  TeamMemberInfo,
  TeamQueueEntryInfo,
  TeamRole,
  TeamTaskInfo,
  TeamTaskKindInfo,
  TeamTaskPriorityInfo,
  TeamTaskState,
} from "../../preload/index";
import type { MessageKey } from "../../shared/i18n";

export type TeamColumn = "sem_dono" | "atribuida" | "rodando" | "aguardando_revisao";
export const TEAM_COLUMNS: readonly TeamColumn[] = ["sem_dono", "atribuida", "rodando", "aguardando_revisao"];
export const TEAM_COLUMN_LABEL_KEY: Record<TeamColumn, MessageKey> = {
  sem_dono: "teamTask.column.noOwner",
  atribuida: "teamTask.column.assigned",
  rodando: "teamTask.column.running",
  aguardando_revisao: "teamTask.column.review",
};

export const TEAM_KIND_LABEL_KEY: Record<TeamTaskKindInfo, MessageKey> = {
  investigar: "teamTask.kind.investigate",
  implementar: "teamTask.kind.implement",
  corrigir: "teamTask.kind.fix",
  medir: "teamTask.kind.measure",
  integrar: "teamTask.kind.integrate",
};
export const TEAM_PRIORITY_LABEL_KEY: Record<TeamTaskPriorityInfo, MessageKey> = {
  baixa: "teamTask.priority.low",
  media: "teamTask.priority.normal",
  alta: "teamTask.priority.high",
  urgente: "teamTask.priority.urgent",
};
export const TEAM_STATE_LABEL_KEY: Record<TeamTaskState, MessageKey> = {
  sem_dono: "teamTask.column.noOwner",
  atribuida: "teamTask.column.assigned",
  rodando: "teamTask.column.running",
  aguardando_revisao: "teamTask.column.review",
  concluida: "teamTask.state.done",
  arquivada: "teamTask.state.archived",
};

export function teamTaskColumn(state: TeamTaskState): TeamColumn | null {
  return state === "sem_dono" || state === "atribuida" || state === "rodando" || state === "aguardando_revisao" ? state : null;
}

export function roleRank(role: TeamRole): number {
  return role === "owner" ? 3 : role === "admin" ? 2 : 1;
}
export function isOwnerOrAdmin(role: TeamRole | null): boolean {
  return role !== null && roleRank(role) >= 2;
}
/** The designated reviewer must be able to review (member cannot). */
export function canReviewRole(role: TeamRole): boolean {
  return roleRank(role) >= 2;
}
export function isAssignee(task: Pick<TeamTaskInfo, "assigneeId">, accountId: string | null): boolean {
  return accountId !== null && task.assigneeId === accountId;
}

/** May this account drag this task into `to`? Mirrors `canMoveTeamTask`. */
export function canDrag(input: {
  role: TeamRole | null;
  accountId: string | null;
  task: Pick<TeamTaskInfo, "state" | "assigneeId">;
  to: TeamColumn;
}): boolean {
  const { role, accountId, task, to } = input;
  if (!role) return false;
  const mine = isAssignee(task, accountId);
  if (!mine && !isOwnerOrAdmin(role)) return false;
  const allowed: Record<TeamTaskState, TeamColumn[]> = {
    sem_dono: [],
    atribuida: ["rodando"],
    rodando: ["aguardando_revisao"],
    aguardando_revisao: ["rodando"],
    concluida: ["rodando"],
    arquivada: [],
  };
  return allowed[task.state].includes(to);
}

export function memberName(members: readonly TeamMemberInfo[], accountId: string | null, selfId: string | null): string {
  if (!accountId) return "";
  if (accountId === selfId) return "self";
  return members.find((m) => m.accountId === accountId)?.accountId.slice(0, 8) ?? accountId.slice(0, 8);
}

export function initials(text: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Index of the per-person pastel avatar tone. Derived STABLY from the account
 *  id (same id ⇒ same tone), so a person keeps their color across the board. */
export function avatarTone(accountId: string): string {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) hash = (hash * 31 + accountId.charCodeAt(i)) >>> 0;
  return String(hash % 6);
}

/** The name to show for an account (B7.1 `display_name`), falling back to the
 *  short id when the server sends none. */
export function memberDisplayName(members: readonly TeamMemberInfo[], accountId: string | null): string {
  if (!accountId) return "";
  const member = members.find((m) => m.accountId === accountId);
  return member && member.displayName.trim() !== "" ? member.displayName : accountId.slice(0, 8);
}

/** Avatar glyphs (B7.1 `avatar_initials`, else derived) plus the stable tone. */
export function memberAvatar(members: readonly TeamMemberInfo[], accountId: string | null): { initials: string; tone: string } {
  if (!accountId) return { initials: "?", tone: "0" };
  const member = members.find((m) => m.accountId === accountId);
  const label = member && member.displayName.trim() !== "" ? member.displayName : accountId.slice(0, 8);
  const glyphs = member && member.avatarInitials.trim() !== "" ? member.avatarInitials : initials(label);
  return { initials: glyphs.slice(0, 2).toUpperCase(), tone: avatarTone(accountId) };
}

/** Accent for the running card's provider dot, mirroring the prototype's
 *  per-provider hues; an unknown provider falls back to the muted text tone. */
export const PROVIDER_DOT: Record<string, string> = {
  claude: "#ff8c3d",
  commandcode: "#e56aa6",
  codex: "#8ee6a8",
};
export function providerDot(provider: string): string {
  return PROVIDER_DOT[provider] ?? "#8d94a6";
}

/** Origin ("project") label keys — the chip's first token on the board. */
export const TEAM_ORIGIN_LABEL_KEY: Record<string, MessageKey> = {
  manual: "teamTask.origin.manual",
  slack: "teamTask.origin.slack",
  github: "teamTask.origin.github",
  linear: "teamTask.origin.linear",
  jira: "teamTask.origin.jira",
  csv: "teamTask.origin.csv",
};
export function originLabelKey(origin: string): MessageKey {
  return TEAM_ORIGIN_LABEL_KEY[origin] ?? "teamTask.origin.manual";
}
/** The distinct origins present on the board, for the "Projeto" filter. */
export function originOptions(tasks: readonly TeamTaskInfo[]): string[] {
  const seen: string[] = [];
  for (const task of tasks) {
    if (!seen.includes(task.originKind)) seen.push(task.originKind);
  }
  return seen;
}

/** The directory a territory glob covers, for a coarse overlap test. */
function territoryRoot(territory: string): string {
  return territory.replace(/\/\*\*.*$/, "").replace(/\/\*$/, "").replace(/\/+$/, "");
}
/** Do two territory globs touch the same tree? Coarse on purpose (prefix
 *  match after stripping the glob tail) — this is only a hint on the panel. */
export function territoriesOverlap(a: string, b: string): boolean {
  const ra = territoryRoot(a);
  const rb = territoryRoot(b);
  if (ra === "" || rb === "") return a === b;
  return ra === rb || ra.startsWith(`${rb}/`) || rb.startsWith(`${ra}/`);
}

/** Screen 16 — the timeline event's phrase, by backend kind. An unknown kind
 *  falls back to `null` so the caller can still show the raw kind (never a
 *  blank line). */
export const TEAM_EVENT_LABEL_KEY: Record<string, MessageKey> = {
  created: "teamTask.event.created",
  assigned: "teamTask.event.assigned",
  accepted: "teamTask.event.accepted",
  returned: "teamTask.event.returned",
  moved: "teamTask.event.moved",
  state: "teamTask.event.moved",
  reported: "teamTask.event.reported",
  commented: "teamTask.event.commented",
  contract: "teamTask.event.contract",
  contract_edited: "teamTask.event.contract",
  archived: "teamTask.event.archived",
  restored: "teamTask.event.restored",
};
export function teamEventKey(kind: string): MessageKey | null {
  return TEAM_EVENT_LABEL_KEY[kind] ?? null;
}

/** The timeline dot's accent for a kind. */
export function teamEventTone(kind: string): "muted" | "accent" | "warn" {
  if (kind === "created" || kind === "archived" || kind === "restored" || kind === "commented") return "muted";
  if (kind === "reported") return "warn";
  return "accent";
}

export type TeamBoardView = {
  accountId: string | null;
  assigneeId: string | null;
  project: string | null;
  unassigned: boolean;
  search: string;
  mine: boolean;
};

export function filterBoardTasks(tasks: readonly TeamTaskInfo[], view: TeamBoardView): TeamTaskInfo[] {
  const q = view.search.trim().toLowerCase();
  return tasks.filter((task) => {
    if (view.mine && task.assigneeId !== view.accountId) return false;
    if (view.unassigned && task.assigneeId !== null) return false;
    if (view.assigneeId && task.assigneeId !== view.assigneeId) return false;
    if (view.project && task.originKind !== view.project) return false;
    if (q && !`${task.title} ${task.ref}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function groupBoardTasks(tasks: readonly TeamTaskInfo[]): Record<TeamColumn, TeamTaskInfo[]> {
  const groups: Record<TeamColumn, TeamTaskInfo[]> = { sem_dono: [], atribuida: [], rodando: [], aguardando_revisao: [] };
  for (const task of tasks) {
    const column = teamTaskColumn(task.state);
    if (column) groups[column].push(task);
  }
  return groups;
}

export type TeamBoardStats = { open: number; unassigned: number; awaitingReview: number; done: number };

export function boardStats(tasks: readonly TeamTaskInfo[]): TeamBoardStats {
  let open = 0;
  let unassigned = 0;
  let awaitingReview = 0;
  let done = 0;
  for (const task of tasks) {
    if (task.state === "concluida") {
      done++;
      continue;
    }
    if (task.state === "arquivada") continue;
    open++;
    if (task.state === "sem_dono") unassigned++;
    if (task.state === "aguardando_revisao") awaitingReview++;
  }
  return { open, unassigned, awaitingReview, done };
}

/** Assignments waiting for accept/return (owner = me). */
export function incomingOffers(tasks: readonly TeamTaskInfo[], accountId: string | null): TeamTaskInfo[] {
  if (!accountId) return [];
  return tasks.filter((t) => t.assigneeId === accountId && (t.state === "atribuida" || t.state === "sem_dono"));
}

/** "Pedir para pegar": unowned tasks the member may ask for (not already asked). */
export function claimableTasks(tasks: readonly TeamTaskInfo[], accountId: string | null): TeamTaskInfo[] {
  if (!accountId) return [];
  return tasks.filter((t) => t.state === "sem_dono" && t.assigneeId === null);
}

export type DistributionCandidate = {
  accountId: string;
  running: number;
  tone: "free" | "normal" | "full";
  /** Target territories this person has a task in — the panel's "conhece …". */
  knows: string[];
};

/** The "Distribuir" panel list: each member with their running load and, when
 *  a target task is given, which of its territories they already work in. */
export function distributionCandidates(
  members: readonly TeamMemberInfo[],
  tasks: readonly TeamTaskInfo[],
  target?: Pick<TeamTaskInfo, "territory">,
): DistributionCandidate[] {
  const running = new Map<string, number>();
  for (const task of tasks) {
    if (task.state === "rodando" && task.assigneeId) {
      running.set(task.assigneeId, (running.get(task.assigneeId) ?? 0) + 1);
    }
  }
  const targetTerritory = target?.territory ?? [];
  return members.map((m) => {
    const load = running.get(m.accountId) ?? 0;
    const tone: DistributionCandidate["tone"] = load === 0 ? "free" : load >= 3 ? "full" : "normal";
    const knows = targetTerritory.filter((wanted) =>
      tasks.some(
        (task) =>
          task.assigneeId === m.accountId &&
          task.state !== "arquivada" &&
          task.territory.some((owned) => territoriesOverlap(owned, wanted)),
      ),
    );
    return { accountId: m.accountId, running: load, tone, knows };
  });
}

/** Queue entries that belong on a board the Fila card is showing. */
export function queueEntriesForBoard(entries: readonly TeamQueueEntryInfo[], boardId: string | null): TeamQueueEntryInfo[] {
  if (!boardId) return [];
  return entries.filter((e) => e.boardId === boardId);
}
