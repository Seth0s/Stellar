import { describe, expect, it } from "vitest";
import type { TeamMemberInfo, TeamTaskInfo } from "../../src/preload/index";
import {
  agentPreviewLines,
  emptyTaskForm,
  showsDistribution,
  submitLabelKey,
  territoryConflicts,
  toLocalPrompt,
  toTeamTaskBody,
  validateTaskForm,
  whereAppearsKey,
} from "../../src/renderer/src/team-task-form-decisions";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

function task(overrides: Partial<TeamTaskInfo> = {}): TeamTaskInfo {
  return {
    id: "t1",
    teamId: "team",
    shortId: 41,
    ref: "#41",
    title: "Cliente HTTP com timeout",
    kind: "implementar",
    priority: "media",
    state: "rodando",
    sprintId: null,
    assigneeId: B,
    sessionLabel: "",
    reviewerId: null,
    provider: "",
    territory: ["src/queue/**"],
    gates: [],
    allowCommit: false,
    reportSchema: [],
    maxRetries: 0,
    autoDispatch: false,
    originKind: "manual",
    originExternalId: null,
    createdBy: null,
    acceptedAt: null,
    startedAt: null,
    reportDeliveredAt: null,
    gatesPassed: null,
    gatesTotal: null,
    reviewVerdict: null,
    version: 1,
    archivedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const members: TeamMemberInfo[] = [
  { accountId: A, role: "owner", joinedAt: null, displayName: "Ana Ribeiro", avatarInitials: "AR", email: null },
  { accountId: B, role: "member", joinedAt: null, displayName: "Bruno Melo", avatarInitials: "BM", email: null },
];

describe("team-task-form-decisions", () => {
  it("warns about running tasks whose territory overlaps the draft", () => {
    const form = { ...emptyTaskForm(), territory: ["src/queue/**"] };
    expect(territoryConflicts(form.territory, [task()])).toHaveLength(1);
    expect(territoryConflicts(form.territory, [task({ state: "concluida" })])).toHaveLength(0);
    expect(territoryConflicts(["src/api/**"], [task()])).toHaveLength(0);
  });

  it("switches destination and assignment copy", () => {
    expect(showsDistribution("team")).toBe(true);
    expect(showsDistribution("board")).toBe(false);
    expect(whereAppearsKey("board", "open")).toBe("teamTask.form.where.board");
    expect(whereAppearsKey("team", "person")).toBe("teamTask.form.where.person");
    expect(submitLabelKey("board", "open")).toBe("teamTask.form.submit.board");
    expect(submitLabelKey("team", "person")).toBe("teamTask.form.submit.person");
  });

  it("only requires a title", () => {
    expect(validateTaskForm(emptyTaskForm()).ok).toBe(false);
    expect(validateTaskForm({ ...emptyTaskForm(), title: "  " }).missingTitle).toBe(true);
    expect(validateTaskForm({ ...emptyTaskForm(), title: "x" }).ok).toBe(true);
  });

  it("builds the team body for both destinations", () => {
    const base = { ...emptyTaskForm(), title: "Fila", territory: ["src/queue/**"], gates: [{ cmd: "npm test", exclusive: true }] };
    const open = toTeamTaskBody(base);
    expect(open.gates).toEqual([{ cmd: "npm test", exclusive: "repo" }]);
    expect(open.state).toBeUndefined();
    const person = toTeamTaskBody({ ...base, assignment: "person", assigneeId: B, priority: "alta" });
    expect(person.assignee_id).toBe(B);
    expect(person.state).toBe("atribuida");
    expect(person.priority).toBe("alta");
    const auto = toTeamTaskBody({ ...base, assignment: "auto" });
    expect(auto.auto_dispatch).toBe(true);
    expect(auto.assignee_id).toBeUndefined();
  });

  it("builds the local Fila briefing", () => {
    const prompt = toLocalPrompt({ ...emptyTaskForm(), title: "Corrigir timezone", territory: ["src/reports/**"], gates: [{ cmd: "npm test", exclusive: false }], contract: "## Objetivo" });
    expect(prompt.split("\n")[0]).toBe("Corrigir timezone");
    expect(prompt).toContain("território: src/reports/**");
    expect(prompt).toContain("gates: npm test");
    expect(prompt).toContain("## Objetivo");
  });

  it("renders the agent preview with the reviewer name", () => {
    const lines = agentPreviewLines(
      { ...emptyTaskForm(), title: "Fila", territory: ["src/queue/**"], gates: [{ cmd: "npm test", exclusive: true }], reviewerId: A, allowCommit: false },
      members,
    );
    expect(lines[0]).toBe("Fila");
    expect(lines).toContain("TERRITÓRIO  src/queue/**");
    expect(lines).toContain("GATES       npm test (exclusivo)");
    expect(lines).toContain("REVISÃO     Ana Ribeiro");
    expect(lines.some((l) => l.startsWith("COMMIT      não"))).toBe(true);
  });
});
