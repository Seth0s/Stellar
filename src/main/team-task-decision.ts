/**
 * TEAM TASKS — the pure DECISION layer, no I/O.
 *
 * Everything testable without network or disk: reading the B7 task/detail/sprint
 * replies, the role x action permission matrix (an EXACT mirror of
 * `internal/team/permissions.go`), the kanban column a server state falls in,
 * and the bridge that turns an accepted team task into the payload of a LOCAL
 * Fila task plus the state the app reports back (never code).
 *
 * The I/O shell is `team.ts`; the wiring is `team-ipc.ts`.
 *
 * BACKEND RULES THIS MODULE MIRRORS:
 *  - view/comment/claim: any member; create/edit/assign/decide/dispatch/archive/
 *    restore/delete/sprint: owner or admin; accept/return and report progress:
 *    the task's owner; move: the owner moves their own, owner/admin move any;
 *    verdict: any owner/admin EXCEPT the task's own owner (no self-approval).
 */

import { isOpaqueId } from "./local-identity-decision";
import type { TaskPurpose } from "../task-purpose";

// ---------------------------------------------------------------------------
// Server enums (mirror of internal/team/tasks.go)
// ---------------------------------------------------------------------------

export type TeamTaskState =
  | "sem_dono"
  | "atribuida"
  | "rodando"
  | "aguardando_revisao"
  | "concluida"
  | "arquivada";

export const TEAM_TASK_STATES: readonly TeamTaskState[] = [
  "sem_dono",
  "atribuida",
  "rodando",
  "aguardando_revisao",
  "concluida",
  "arquivada",
];

export type TeamTaskKind = "investigar" | "implementar" | "corrigir" | "medir" | "integrar";
export const TEAM_TASK_KINDS: readonly TeamTaskKind[] = ["investigar", "implementar", "corrigir", "medir", "integrar"];
export const TEAM_TASK_KIND_LABEL_KEY: Record<TeamTaskKind, string> = {
  investigar: "teamTask.kind.investigate",
  implementar: "teamTask.kind.implement",
  corrigir: "teamTask.kind.fix",
  medir: "teamTask.kind.measure",
  integrar: "teamTask.kind.integrate",
};

export type TeamTaskPriority = "baixa" | "media" | "alta" | "urgente";
export const TEAM_TASK_PRIORITIES: readonly TeamTaskPriority[] = ["baixa", "media", "alta", "urgente"];
export const TEAM_TASK_PRIORITY_LABEL_KEY: Record<TeamTaskPriority, string> = {
  baixa: "teamTask.priority.low",
  media: "teamTask.priority.normal",
  alta: "teamTask.priority.high",
  urgente: "teamTask.priority.urgent",
};

export type TeamTaskOrigin = "manual" | "slack" | "github" | "linear" | "jira" | "csv";
export type TeamTaskVerdict = "aprovado" | "reprovado";

export type TeamSprintState = "planejada" | "ativa" | "encerrada";

/** A gate is a bare command or `{cmd, exclusive}` (the `exclusive` gate runs
 *  last, under the machine lock). `exclusive` unknown values are dropped. */
export type TeamGate = string | { cmd: string; exclusive?: "repo" | "machine" };

function isTeamTaskState(value: unknown): value is TeamTaskState {
  return typeof value === "string" && (TEAM_TASK_STATES as readonly string[]).includes(value);
}
function isTeamTaskKind(value: unknown): value is TeamTaskKind {
  return typeof value === "string" && (TEAM_TASK_KINDS as readonly string[]).includes(value);
}
export function isTeamTaskPriority(value: unknown): value is TeamTaskPriority {
  return typeof value === "string" && (TEAM_TASK_PRIORITIES as readonly string[]).includes(value);
}
export function isTeamVerdict(value: unknown): value is TeamTaskVerdict {
  return value === "aprovado" || value === "reprovado";
}

// ---------------------------------------------------------------------------
// Permission matrix (mirror of permissions.go can(...))
// ---------------------------------------------------------------------------

export type TeamTaskAction =
  | "view"
  | "create"
  | "edit"
  | "assign"
  | "accept"
  | "return"
  | "claim"
  | "decide_claim"
  | "auto_dispatch"
  | "move"
  | "comment"
  | "archive"
  | "restore"
  | "delete"
  | "sprint"
  | "report"
  | "report_verdict";

import type { TeamRole } from "./team-decision";

/** Rank mirror: owner 3 > admin 2 > member 1. */
function rank(role: TeamRole): number {
  return role === "owner" ? 3 : role === "admin" ? 2 : 1;
}

/**
 * May this role do this action? `isAssignee`/`isReviewer` say whether the
 * account owns or reviews THIS task. The rules are the prototype's role matrix,
 * in one place. NOTE: verdict is granted to any admin/owner that is NOT the
 * assignee — the designated reviewer is not required (B7 deliberately).
 */
export function canTaskAction(
  role: TeamRole,
  action: TeamTaskAction,
  flags: { isAssignee: boolean; isReviewer: boolean } = { isAssignee: false, isReviewer: false },
): boolean {
  const { isAssignee, isReviewer } = flags;
  void isReviewer;
  switch (action) {
    case "view":
    case "comment":
    case "claim":
      return rank(role) >= 1;
    case "create":
    case "edit":
    case "assign":
    case "decide_claim":
    case "auto_dispatch":
    case "archive":
    case "restore":
    case "delete":
    case "sprint":
      return rank(role) >= 2;
    case "accept":
    case "return":
      return isAssignee;
    case "move":
      return isAssignee || rank(role) >= 2;
    case "report":
      return isAssignee;
    case "report_verdict":
      return rank(role) >= 2 && !isAssignee;
    default:
      return false;
  }
}

/** May this account be DESIGNATED a reviewer? Members cannot review. */
export function canBeReviewer(role: TeamRole): boolean {
  return rank(role) >= 2;
}

// ---------------------------------------------------------------------------
// Reading the B7 replies
// ---------------------------------------------------------------------------

export type TeamGateList = TeamGate[];

export type TeamTaskView = {
  id: string;
  teamId: string;
  shortId: number;
  ref: string;
  title: string;
  kind: TeamTaskKind;
  priority: TeamTaskPriority;
  state: TeamTaskState;
  sprintId: string | null;
  assigneeId: string | null;
  sessionLabel: string;
  reviewerId: string | null;
  provider: string;
  territory: string[];
  gates: TeamGateList;
  allowCommit: boolean;
  reportSchema: string[];
  maxRetries: number;
  autoDispatch: boolean;
  originKind: TeamTaskOrigin;
  originExternalId: string | null;
  createdBy: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  reportDeliveredAt: string | null;
  gatesPassed: number | null;
  gatesTotal: number | null;
  reviewVerdict: TeamTaskVerdict | null;
  version: number;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type TeamTaskDependency = { id: string; shortId: number; title: string; state: TeamTaskState };
export type TeamTaskEvent = { id: number; kind: string; actorId: string | null; actorName: string; payload: unknown; at: string | null };
export type TeamTaskComment = { id: string; authorId: string | null; authorName: string; body: string; mentions: string[]; createdAt: string | null };
export type TeamTaskClaim = { id: string; accountId: string; accountName: string; status: string; createdAt: string | null };
export type TeamTaskContract = { version: number; markdown: string; authorId: string | null; createdAt: string | null };
export type TeamTaskDetail = {
  task: TeamTaskView;
  contract: TeamTaskContract | null;
  versions: TeamTaskContract[];
  deps: TeamTaskDependency[];
  dependents: TeamTaskDependency[];
  events: TeamTaskEvent[];
  comments: TeamTaskComment[];
  claims: TeamTaskClaim[];
};
export type TeamTaskList = { tasks: TeamTaskView[]; total: number; limit: number; offset: number };

export type TeamSprintView = {
  id: string;
  teamId: string;
  name: string;
  goal: string;
  state: TeamSprintState;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `pgtype.<T>` marshals the value or null; anything else is treated as absent. */
function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asBool(value: unknown): boolean {
  return value === true;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v !== "");
}

function parseGates(value: unknown): TeamGateList {
  if (!Array.isArray(value)) return [];
  const gates: TeamGateList = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") {
      gates.push(item.trim());
      continue;
    }
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const cmd = asString(rec.cmd);
      if (!cmd) continue;
      const exclusive = rec.exclusive === "repo" || rec.exclusive === "machine" ? rec.exclusive : undefined;
      gates.push(exclusive ? { cmd, exclusive } : { cmd });
    }
  }
  return gates;
}

function parseTask(raw: unknown): TeamTaskView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!isOpaqueId(rec.id) || !isOpaqueId(rec.team_id)) return null;
  if (!isTeamTaskState(rec.state) || !isTeamTaskKind(rec.kind)) return null;
  if (typeof rec.title !== "string") return null;
  const shortId = asInt(rec.short_id);
  if (shortId === null) return null;
  return {
    id: rec.id,
    teamId: rec.team_id,
    shortId,
    ref: typeof rec.ref === "string" && rec.ref !== "" ? rec.ref : `#${shortId}`,
    title: rec.title,
    kind: rec.kind,
    priority: isTeamTaskPriority(rec.priority) ? rec.priority : "media",
    state: rec.state,
    sprintId: isOpaqueId(rec.sprint_id) ? rec.sprint_id : null,
    assigneeId: isOpaqueId(rec.assignee_id) ? rec.assignee_id : null,
    sessionLabel: typeof rec.session_label === "string" ? rec.session_label : "",
    reviewerId: isOpaqueId(rec.reviewer_id) ? rec.reviewer_id : null,
    provider: typeof rec.provider === "string" ? rec.provider : "",
    territory: parseStringArray(rec.territory),
    gates: parseGates(rec.gates),
    allowCommit: asBool(rec.allow_commit),
    reportSchema: parseStringArray(rec.report_schema),
    maxRetries: asInt(rec.max_retries) ?? 0,
    autoDispatch: asBool(rec.auto_dispatch),
    originKind: (typeof rec.origin_kind === "string" ? rec.origin_kind : "manual") as TeamTaskOrigin,
    originExternalId: asString(rec.origin_external_id),
    createdBy: isOpaqueId(rec.created_by) ? rec.created_by : null,
    acceptedAt: asString(rec.accepted_at),
    startedAt: asString(rec.started_at),
    reportDeliveredAt: asString(rec.report_delivered_at),
    gatesPassed: asInt(rec.gates_passed),
    gatesTotal: asInt(rec.gates_total),
    reviewVerdict: isTeamVerdict(rec.review_verdict) ? rec.review_verdict : null,
    version: asInt(rec.version) ?? 0,
    archivedAt: asString(rec.archived_at),
    createdAt: asString(rec.created_at),
    updatedAt: asString(rec.updated_at),
  };
}

export function parseTeamTaskList(raw: unknown): TeamTaskList | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const tasks: TeamTaskView[] = [];
  if (Array.isArray(rec.tasks)) {
    for (const item of rec.tasks) {
      const parsed = parseTask(item);
      if (parsed) tasks.push(parsed);
    }
  }
  return {
    tasks,
    total: asInt(rec.total) ?? tasks.length,
    limit: asInt(rec.limit) ?? tasks.length,
    offset: asInt(rec.offset) ?? 0,
  };
}

function parseDependency(raw: unknown): TeamTaskDependency | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = isOpaqueId(rec.depends_on) ? rec.depends_on : isOpaqueId(rec.task_id) ? rec.task_id : null;
  const shortId = asInt(rec.short_id);
  if (!id || shortId === null) return null;
  return { id, shortId, title: typeof rec.title === "string" ? rec.title : "", state: isTeamTaskState(rec.state) ? rec.state : "sem_dono" };
}

function parseContract(raw: unknown): TeamTaskContract | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const version = asInt(rec.version);
  if (version === null || typeof rec.markdown !== "string") return null;
  return { version, markdown: rec.markdown, authorId: isOpaqueId(rec.author_id) ? rec.author_id : null, createdAt: asString(rec.created_at) };
}

export function parseTeamTaskDetail(raw: unknown): TeamTaskDetail | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const task = parseTask(rec.task);
  if (!task) return null;
  const versions: TeamTaskContract[] = [];
  if (Array.isArray(rec.versions)) {
    for (const item of rec.versions) {
      const parsed = parseContract(item);
      if (parsed) versions.push(parsed);
    }
  }
  const deps: TeamTaskDependency[] = [];
  if (Array.isArray(rec.deps)) for (const item of rec.deps) { const p = parseDependency(item); if (p) deps.push(p); }
  const dependents: TeamTaskDependency[] = [];
  if (Array.isArray(rec.dependents)) for (const item of rec.dependents) { const p = parseDependency(item); if (p) dependents.push(p); }
  const events: TeamTaskEvent[] = [];
  if (Array.isArray(rec.events)) {
    for (const item of rec.events) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      events.push({
        id: asInt(e.id) ?? 0,
        kind: typeof e.kind === "string" ? e.kind : "",
        actorId: isOpaqueId(e.actor_id) ? e.actor_id : null,
        actorName: typeof e.actor_name === "string" ? e.actor_name : "",
        payload: e.payload ?? null,
        at: asString(e.at),
      });
    }
  }
  const comments: TeamTaskComment[] = [];
  if (Array.isArray(rec.comments)) {
    for (const item of rec.comments) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const c = item as Record<string, unknown>;
      if (!isOpaqueId(c.id) || typeof c.body !== "string") continue;
      comments.push({
        id: c.id,
        authorId: isOpaqueId(c.author_id) ? c.author_id : null,
        authorName: typeof c.author_name === "string" ? c.author_name : "",
        body: c.body,
        mentions: parseStringArray(c.mentions),
        createdAt: asString(c.created_at),
      });
    }
  }
  const claims: TeamTaskClaim[] = [];
  if (Array.isArray(rec.claims)) {
    for (const item of rec.claims) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const c = item as Record<string, unknown>;
      if (!isOpaqueId(c.id) || !isOpaqueId(c.account_id)) continue;
      claims.push({
        id: c.id,
        accountId: c.account_id,
        accountName: typeof c.account_name === "string" ? c.account_name : "",
        status: typeof c.status === "string" ? c.status : "",
        createdAt: asString(c.created_at),
      });
    }
  }
  return { task, contract: parseContract(rec.contract), versions, deps, dependents, events, comments, claims };
}

export function parseTeamSprint(raw: unknown): TeamSprintView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!isOpaqueId(rec.id) || !isOpaqueId(rec.team_id)) return null;
  const state = typeof rec.state === "string" ? rec.state : "planejada";
  return {
    id: rec.id,
    teamId: rec.team_id,
    name: typeof rec.name === "string" ? rec.name : "",
    goal: typeof rec.goal === "string" ? rec.goal : "",
    state: (state === "ativa" || state === "encerrada" ? state : "planejada") as TeamSprintState,
    startsAt: asString(rec.starts_at),
    endsAt: asString(rec.ends_at),
    createdBy: isOpaqueId(rec.created_by) ? rec.created_by : null,
    createdAt: asString(rec.created_at),
    updatedAt: asString(rec.updated_at),
  };
}

export function parseTeamSprintList(raw: unknown): TeamSprintView[] {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const sprints: TeamSprintView[] = [];
  if (Array.isArray(rec.sprints)) for (const item of rec.sprints) { const p = parseTeamSprint(item); if (p) sprints.push(p); }
  return sprints;
}

// ---------------------------------------------------------------------------
// Board columns and filters (tela 11)
// ---------------------------------------------------------------------------

/** The four live kanban columns; `concluida`/`arquivada` are the extras. */
export type TeamBoardColumn = "sem_dono" | "atribuida" | "rodando" | "aguardando_revisao";
export const TEAM_BOARD_COLUMNS: readonly TeamBoardColumn[] = ["sem_dono", "atribuida", "rodando", "aguardando_revisao"];

export function teamBoardColumn(state: TeamTaskState): TeamBoardColumn | null {
  switch (state) {
    case "sem_dono":
    case "atribuida":
    case "rodando":
    case "aguardando_revisao":
      return state;
    default:
      return null;
  }
}

/** Can a drag from `from` to `to` be requested for this account? Pure mirror of
 *  the state machine + `can(move)`. The server is still the authority. */
export function canMoveTeamTask(input: {
  role: TeamRole;
  isAssignee: boolean;
  from: TeamTaskState;
  to: TeamBoardColumn;
}): boolean {
  if (input.from === "concluida" || input.from === "arquivada") {
    return canTaskAction(input.role, "edit", { isAssignee: input.isAssignee, isReviewer: false });
  }
  if (!canTaskAction(input.role, "move", { isAssignee: input.isAssignee, isReviewer: false })) return false;
  // Only the adjacent transitions the server's `taskTransitions` allows.
  const allowed: Record<TeamTaskState, TeamTaskState[]> = {
    sem_dono: [],
    atribuida: ["rodando"],
    rodando: ["aguardando_revisao"],
    aguardando_revisao: ["rodando"],
    concluida: ["rodando"],
    arquivada: [],
  };
  return allowed[input.from].includes(input.to);
}

export type TeamBoardFilters = {
  assigneeId: string | null;
  origin: string | null;
  unassigned: boolean;
  search: string;
};

export function filterTeamTasks(tasks: readonly TeamTaskView[], filters: TeamBoardFilters): TeamTaskView[] {
  const q = filters.search.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.unassigned && task.assigneeId !== null) return false;
    if (filters.assigneeId && task.assigneeId !== filters.assigneeId) return false;
    if (filters.origin && task.originKind !== filters.origin) return false;
    if (q && !`${task.title} ${task.ref}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function groupTeamTasks(tasks: readonly TeamTaskView[]): Record<TeamBoardColumn, TeamTaskView[]> {
  const groups: Record<TeamBoardColumn, TeamTaskView[]> = { sem_dono: [], atribuida: [], rodando: [], aguardando_revisao: [] };
  for (const task of tasks) {
    const column = teamBoardColumn(task.state);
    if (column) groups[column].push(task);
  }
  return groups;
}

/** Tasks waiting for THIS member's action: assigned to them (accept/return) or
 *  an owned claim asking to be picked. */
export function incomingForMember(tasks: readonly TeamTaskView[], accountId: string | null): {
  offer: TeamTaskView[];
  mine: TeamTaskView[];
} {
  if (!accountId) return { offer: [], mine: [] };
  const offer = tasks.filter((t) => t.assigneeId === accountId && (t.state === "atribuida" || t.state === "sem_dono"));
  const mine = tasks.filter((t) => t.assigneeId === accountId && t.state !== "atribuida");
  return { offer, mine };
}

// ---------------------------------------------------------------------------
// Bridge: team task <-> local Fila task
// ---------------------------------------------------------------------------

export const TEAM_TASK_PURPOSE: Record<TeamTaskKind, TaskPurpose> = {
  investigar: "investigate",
  implementar: "implement",
  corrigir: "fix",
  medir: "measure",
  integrar: "integrate",
};

/** Gates as the local Fila declares them (bare command strings). */
export function localGateCommands(gates: TeamGateList): string[] {
  return gates.map((g) => (typeof g === "string" ? g : g.cmd)).filter((g) => g.trim() !== "");
}

/**
 * The local Fila task the member gets on accept: the team contract becomes the
 * briefing, with the team ref on the first line so the Fila shows WHERE it came
 * from. Code never travels — only the contract, the territory and the gates.
 */
export function teamTaskPrompt(task: TeamTaskView, contract: string | null): string {
  const lines: string[] = [`[do time ${task.ref}] ${task.title}`];
  const meta: string[] = [];
  if (task.territory.length > 0) meta.push(`território: ${task.territory.join(", ")}`);
  const cmds = localGateCommands(task.gates);
  if (cmds.length > 0) meta.push(`gates: ${cmds.join(" | ")}`);
  if (meta.length > 0) lines.push(meta.join(" · "));
  const body = contract?.trim();
  if (body) lines.push("", body);
  return lines.join("\n");
}

/** What the app reports to the server, derived from the LOCAL Fila task. This
 *  app never STORES `running` (the store coerces it to `pending`; "running"
 *  means "a card is on this task"), so the signal for `rodando` is a LIVE CARD.
 *  `done` is the delivered report. `null` = nothing to report. */
export function teamReportForLocal(input: { status: string; cardAlive: boolean }): { state?: TeamTaskState; reportDelivered?: boolean } | null {
  if (input.status === "done") return { state: "aguardando_revisao", reportDelivered: true };
  if (input.cardAlive) return { state: "rodando" };
  return null;
}

/** Progress between the two ends of the bridge, for the "Do time" section. */
export type TeamQueueEntry = {
  localTaskId: string;
  boardId: string;
  teamId: string;
  teamTaskId: string;
  ref: string;
  title: string;
  reportDelivered: boolean;
  acceptedAt: number;
};

export type TeamQueueFile = { entries: TeamQueueEntry[] };

export function parseTeamQueue(raw: unknown): TeamQueueEntry[] {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(rec.entries)) return [];
  const entries: TeamQueueEntry[] = [];
  for (const item of rec.entries) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    if (!isOpaqueId(e.localTaskId) || !isOpaqueId(e.teamId) || !isOpaqueId(e.teamTaskId)) continue;
    if (typeof e.ref !== "string" || typeof e.title !== "string") continue;
    entries.push({
      localTaskId: e.localTaskId,
      boardId: typeof e.boardId === "string" ? e.boardId : "",
      teamId: e.teamId,
      teamTaskId: e.teamTaskId,
      ref: e.ref,
      title: e.title,
      reportDelivered: e.reportDelivered === true,
      acceptedAt: asInt(e.acceptedAt) ?? 0,
    });
  }
  return entries;
}
