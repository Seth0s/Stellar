import { describe, expect, it } from "vitest";
import {
  TEAM_TASK_PURPOSE,
  canBeReviewer,
  canMoveTeamTask,
  canTaskAction,
  filterTeamTasks,
  groupTeamTasks,
  incomingForMember,
  localGateCommands,
  parseTeamQueue,
  parseTeamSprintList,
  parseTeamTaskDetail,
  parseTeamTaskList,
  teamReportForLocal,
  teamTaskPrompt,
  type TeamTaskView,
} from "../../src/main/team-task-decision";

const UUID = {
  a: "11111111-1111-1111-1111-111111111111",
  b: "22222222-2222-2222-2222-222222222222",
  t: "33333333-3333-3333-3333-333333333333",
  s: "44444444-4444-4444-4444-444444444444",
};

function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID.a,
    team_id: UUID.t,
    short_id: 58,
    ref: "#58",
    title: "Fila de retries",
    kind: "implementar",
    priority: "normal",
    state: "atribuida",
    sprint_id: null,
    assignee_id: UUID.b,
    session_label: "",
    reviewer_id: null,
    provider: "commandcode",
    territory: ["src/queue/**"],
    gates: ["npm test", { cmd: "npm run e2e", exclusive: "machine" }],
    allow_commit: false,
    report_schema: [],
    max_retries: 2,
    auto_dispatch: false,
    origin_kind: "manual",
    origin_external_id: null,
    created_by: UUID.a,
    accepted_at: null,
    started_at: null,
    report_delivered_at: null,
    gates_passed: null,
    gates_total: null,
    review_verdict: null,
    version: 3,
    archived_at: null,
    created_at: "2026-10-05T12:00:00Z",
    updated_at: "2026-10-05T12:05:00Z",
    ...overrides,
  };
}

describe("team-task-decision: permission matrix (mirror of permissions.go)", () => {
  const cases: { role: "owner" | "admin" | "member"; action: Parameters<typeof canTaskAction>[1]; isAssignee: boolean; want: boolean }[] = [
    { role: "member", action: "create", isAssignee: false, want: false },
    { role: "admin", action: "create", isAssignee: false, want: true },
    { role: "member", action: "move", isAssignee: true, want: true },
    { role: "member", action: "move", isAssignee: false, want: false },
    { role: "admin", action: "move", isAssignee: false, want: true },
    { role: "member", action: "claim", isAssignee: false, want: true },
    { role: "member", action: "archive", isAssignee: false, want: false },
    { role: "admin", action: "archive", isAssignee: false, want: true },
    { role: "member", action: "accept", isAssignee: true, want: true },
    { role: "member", action: "accept", isAssignee: false, want: false },
    { role: "admin", action: "report", isAssignee: false, want: false },
    { role: "member", action: "report", isAssignee: true, want: true },
    { role: "admin", action: "report_verdict", isAssignee: false, want: true },
    { role: "admin", action: "report_verdict", isAssignee: true, want: false },
    { role: "owner", action: "report_verdict", isAssignee: false, want: true },
    { role: "member", action: "report_verdict", isAssignee: false, want: false },
    { role: "owner", action: "delete", isAssignee: false, want: true },
  ];
  for (const c of cases) {
    it(`${c.role} ${c.action} (assignee=${c.isAssignee}) => ${c.want}`, () => {
      expect(canTaskAction(c.role, c.action, { isAssignee: c.isAssignee, isReviewer: false })).toBe(c.want);
    });
  }

  it("only owner/admin can be a designated reviewer", () => {
    expect(canBeReviewer("member")).toBe(false);
    expect(canBeReviewer("admin")).toBe(true);
    expect(canBeReviewer("owner")).toBe(true);
  });
});

describe("team-task-decision: parsing", () => {
  it("parses a task view, coercing jsonb gates and uuids", () => {
    const list = parseTeamTaskList({ tasks: [rawTask()], total: 1, limit: 50, offset: 0 });
    expect(list).not.toBeNull();
    const task = list!.tasks[0]!;
    expect(task).toMatchObject({ id: UUID.a, ref: "#58", kind: "implementar", state: "atribuida", version: 3 });
    expect(task.territory).toEqual(["src/queue/**"]);
    expect(task.gates).toEqual(["npm test", { cmd: "npm run e2e", exclusive: "machine" }]);
    expect(localGateCommands(task.gates)).toEqual(["npm test", "npm run e2e"]);
  });

  it("drops a malformed task instead of inventing fields", () => {
    const list = parseTeamTaskList({ tasks: [{ id: "x" }, rawTask()] });
    expect(list!.tasks).toHaveLength(1);
  });

  it("parses the detail with contract, deps and events", () => {
    const detail = parseTeamTaskDetail({
      task: rawTask(),
      contract: { version: 1, markdown: "# contrato", author_id: UUID.a, created_at: null },
      versions: [{ version: 1, markdown: "# contrato", author_id: UUID.a, created_at: null }],
      deps: [{ depends_on: UUID.s, short_id: 40, title: "Dep", state: "concluida" }],
      dependents: [],
      events: [{ id: 7, kind: "created", actor_id: UUID.a, actor_name: "Ana", payload: { x: 1 }, at: null }],
      comments: [],
      claims: [],
    });
    expect(detail).not.toBeNull();
    expect(detail!.contract?.markdown).toBe("# contrato");
    expect(detail!.deps[0]?.shortId).toBe(40);
    expect(detail!.events[0]?.kind).toBe("created");
  });

  it("parses sprints", () => {
    const sprints = parseTeamSprintList({
      sprints: [{ id: UUID.s, team_id: UUID.t, name: "Sprint 14", goal: "", state: "ativa", starts_at: null, ends_at: null, created_by: null, created_at: null, updated_at: null }],
    });
    expect(sprints).toHaveLength(1);
    expect(sprints[0]?.state).toBe("ativa");
  });
});

describe("team-task-decision: board columns and moves", () => {
  const membro = "member" as const;
  it("maps server states to live columns", () => {
    expect(groupTeamTasks(parseTeamTaskList({ tasks: [rawTask()] })!.tasks).atribuida).toHaveLength(1);
    expect(groupTeamTasks(parseTeamTaskList({ tasks: [rawTask({ state: "concluida" })] })!.tasks).atribuida).toHaveLength(0);
  });

  it("allows only the adjacent transitions the server allows", () => {
    expect(canMoveTeamTask({ role: membro, isAssignee: true, from: "atribuida", to: "rodando" })).toBe(true);
    expect(canMoveTeamTask({ role: membro, isAssignee: true, from: "atribuida", to: "aguardando_revisao" })).toBe(false);
    expect(canMoveTeamTask({ role: membro, isAssignee: false, from: "rodando", to: "aguardando_revisao" })).toBe(false);
    expect(canMoveTeamTask({ role: "admin", isAssignee: false, from: "rodando", to: "aguardando_revisao" })).toBe(true);
  });

  it("filters by assignee, origin and search", () => {
    const tasks = parseTeamTaskList({
      tasks: [rawTask(), rawTask({ id: UUID.s, assignee_id: null, state: "sem_dono", title: "Outra", origin_kind: "slack" })],
    })!.tasks;
    expect(filterTeamTasks(tasks, { assigneeId: null, origin: null, unassigned: true, search: "" })).toHaveLength(1);
    expect(filterTeamTasks(tasks, { assigneeId: UUID.b, origin: null, unassigned: false, search: "" })).toHaveLength(1);
    expect(filterTeamTasks(tasks, { assigneeId: null, origin: "slack", unassigned: false, search: "" })).toHaveLength(1);
    expect(filterTeamTasks(tasks, { assigneeId: null, origin: null, unassigned: false, search: "retries" })).toHaveLength(1);
  });

  it("computes the member's incoming offers", () => {
    const tasks = parseTeamTaskList({ tasks: [rawTask()] })!.tasks;
    expect(incomingForMember(tasks, UUID.b).offer).toHaveLength(1);
    expect(incomingForMember(tasks, UUID.a).offer).toHaveLength(0);
  });
});

describe("team-task-decision: the local Fila bridge", () => {
  it("maps team kinds to local purposes", () => {
    expect(TEAM_TASK_PURPOSE).toMatchObject({ investigar: "investigate", implementar: "implement", corrigir: "fix", medir: "measure", integrar: "integrate" });
  });

  it("builds the local briefing with contract, territory and gates", () => {
    const task = parseTeamTaskList({ tasks: [rawTask()] })!.tasks[0]!;
    const prompt = teamTaskPrompt(task, "# contrato\npasso 1");
    expect(prompt.split("\n")[0]).toBe("[do time #58] Fila de retries");
    expect(prompt).toContain("território: src/queue/**");
    expect(prompt).toContain("gates: npm test | npm run e2e");
    expect(prompt).toContain("# contrato");
  });

  it("derives the reported state from the local Fila task", () => {
    // This app never stores `running`: a live card is the `rodando` signal.
    expect(teamReportForLocal({ status: "pending", cardAlive: true })).toEqual({ state: "rodando" });
    expect(teamReportForLocal({ status: "done", cardAlive: false })).toEqual({ state: "aguardando_revisao", reportDelivered: true });
    expect(teamReportForLocal({ status: "pending", cardAlive: false })).toBeNull();
    expect(teamReportForLocal({ status: "failed", cardAlive: false })).toBeNull();
  });

  it("round-trips the queue file and drops malformed entries", () => {
    const entries = parseTeamQueue({
      entries: [
        { localTaskId: UUID.a, boardId: "b1", teamId: UUID.t, teamTaskId: UUID.s, ref: "#58", title: "X", reportDelivered: true, acceptedAt: 5 },
        { localTaskId: "nope" },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ boardId: "b1", reportDelivered: true, acceptedAt: 5 });
  });
});

describe("team-task-decision: TaskView type stays aligned", () => {
  it("exposes the parsed task shape", () => {
    const task: TeamTaskView = parseTeamTaskList({ tasks: [rawTask()] })!.tasks[0]!;
    expect(task.gatesTotal).toBeNull();
  });
});
