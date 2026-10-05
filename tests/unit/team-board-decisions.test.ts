import { describe, expect, it } from "vitest";
import type { TeamMemberInfo, TeamQueueEntryInfo, TeamTaskInfo } from "../../src/preload/index";
import {
  avatarTone,
  boardStats,
  canDrag,
  claimableTasks,
  distributionCandidates,
  filterBoardTasks,
  groupBoardTasks,
  incomingOffers,
  initials,
  memberAvatar,
  memberDisplayName,
  originOptions,
  providerDot,
  teamEventKey,
  teamEventTone,
  territoriesOverlap,
} from "../../src/renderer/src/team-board-decisions";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

function task(overrides: Partial<TeamTaskInfo> = {}): TeamTaskInfo {
  return {
    id: "t1",
    teamId: "team",
    shortId: 1,
    ref: "#1",
    title: "Tarefa",
    kind: "implementar",
    priority: "media",
    state: "sem_dono",
    sprintId: null,
    assigneeId: null,
    sessionLabel: "",
    reviewerId: null,
    provider: "",
    territory: [],
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
    updatedAt: "2026-10-05T12:00:00Z",
    ...overrides,
  };
}

const members: TeamMemberInfo[] = [
  { accountId: A, role: "owner", joinedAt: null, displayName: "Ana Ribeiro", avatarInitials: "AR", email: "ana@x.com" },
  { accountId: B, role: "member", joinedAt: null, displayName: "Bruno Melo", avatarInitials: "BM", email: null },
];

describe("team-board-decisions", () => {
  it("groups the four live columns and ignores the extras", () => {
    const grouped = groupBoardTasks([task(), task({ id: "t2", state: "rodando" }), task({ id: "t3", state: "concluida" })]);
    expect(grouped.sem_dono).toHaveLength(1);
    expect(grouped.rodando).toHaveLength(1);
    expect(grouped.atribuida).toHaveLength(0);
  });

  it("counts open/unassigned/review/done", () => {
    const stats = boardStats([
      task({ id: "a", state: "sem_dono" }),
      task({ id: "b", state: "atribuida" }),
      task({ id: "c", state: "aguardando_revisao" }),
      task({ id: "d", state: "concluida" }),
      task({ id: "e", state: "arquivada" }),
    ]);
    expect(stats).toEqual({ open: 3, unassigned: 1, awaitingReview: 1, done: 1 });
  });

  it("filters by mine, unassigned and search", () => {
    const tasks = [task({ assigneeId: A }), task({ id: "x", assigneeId: null })];
    const view = { accountId: A, assigneeId: null, project: null, unassigned: false, search: "", mine: true };
    expect(filterBoardTasks(tasks, view)).toHaveLength(1);
    expect(filterBoardTasks(tasks, { ...view, mine: false, search: "Tarefa" })).toHaveLength(2);
  });

  it("mirrors the drag rules", () => {
    expect(canDrag({ role: "member", accountId: A, task: task({ state: "atribuida", assigneeId: A }), to: "rodando" })).toBe(true);
    expect(canDrag({ role: "member", accountId: A, task: task({ state: "atribuida", assigneeId: B }), to: "rodando" })).toBe(false);
    expect(canDrag({ role: "admin", accountId: A, task: task({ state: "rodando", assigneeId: B }), to: "aguardando_revisao" })).toBe(true);
    expect(canDrag({ role: "member", accountId: A, task: task({ state: "rodando", assigneeId: A }), to: "aguardando_revisao" })).toBe(true);
  });

  it("computes member load for the distribution panel", () => {
    const cands = distributionCandidates(members, [task({ state: "rodando", assigneeId: A })]);
    expect(cands.find((c) => c.accountId === A)).toMatchObject({ running: 1, tone: "normal" });
    expect(cands.find((c) => c.accountId === B)).toMatchObject({ running: 0, tone: "free" });
  });

  it("separates offers from claimable tasks", () => {
    const tasks = [task({ assigneeId: A, state: "atribuida" }), task({ id: "c", assigneeId: null, state: "sem_dono" })];
    expect(incomingOffers(tasks, A)).toHaveLength(1);
    expect(claimableTasks(tasks, A)).toHaveLength(1);
  });

  it("formats initials", () => {
    expect(initials("Ana Ribeiro")).toBe("AR");
    expect(initials("ana@x.com")).toBe("AN");
  });

  it("keeps only the queue entries of the given board", () => {
    const entries: TeamQueueEntryInfo[] = [
      { localTaskId: "1", boardId: "board-a", teamId: "team", teamTaskId: "t", ref: "#1", title: "x", reportDelivered: false, acceptedAt: 0, localStatus: null },
      { localTaskId: "2", boardId: "board-b", teamId: "team", teamTaskId: "t", ref: "#2", title: "y", reportDelivered: false, acceptedAt: 0, localStatus: null },
    ];
    expect(entries.filter((e) => e.boardId === "board-a")).toHaveLength(1);
  });

  it("maps a provider to its accent dot with a muted fallback", () => {
    expect(providerDot("commandcode")).toBe("#e56aa6");
    expect(providerDot("claude")).toBe("#ff8c3d");
    expect(providerDot("unknown")).toBe("#8d94a6");
  });

  it("lists the distinct origins for the project filter", () => {
    const opts = originOptions([task({ originKind: "manual" }), task({ id: "x", originKind: "github" }), task({ id: "y", originKind: "manual" })]);
    expect(opts).toEqual(["manual", "github"]);
  });

  it("overlaps territory globs coarsely", () => {
    expect(territoriesOverlap("src/queue/**", "src/queue/retry.ts")).toBe(true);
    expect(territoriesOverlap("src/queue/**", "src/api/**")).toBe(false);
  });

  it("flags the candidate who already knows the target territory", () => {
    const target = task({ territory: ["src/queue/**"] });
    const cands = distributionCandidates(
      members,
      [task({ state: "rodando", assigneeId: B, territory: ["src/queue/**"] })],
      target,
    );
    expect(cands.find((c) => c.accountId === B)?.knows).toEqual(["src/queue/**"]);
    expect(cands.find((c) => c.accountId === A)?.knows).toEqual([]);
  });

  it("derives the avatar tone stably from the account id", () => {
    expect(avatarTone(A)).toBe(avatarTone(A));
    expect(avatarTone(B)).toBe(avatarTone(B));
    expect(Number(avatarTone(A))).toBeLessThan(6);
  });

  it("shows display_name, falling back to the short id", () => {
    expect(memberDisplayName(members, A)).toBe("Ana Ribeiro");
    const noName: TeamMemberInfo[] = [{ accountId: A, role: "owner", joinedAt: null, displayName: "", avatarInitials: "", email: null }];
    expect(memberDisplayName(noName, A)).toBe(A.slice(0, 8));
  });

  it("uses B7.1 initials when present, else derives them", () => {
    expect(memberAvatar(members, A)).toEqual({ initials: "AR", tone: avatarTone(A) });
    const noInitials: TeamMemberInfo[] = [{ accountId: B, role: "member", joinedAt: null, displayName: "Bruno Melo", avatarInitials: "", email: null }];
    expect(memberAvatar(noInitials, B).initials).toBe("BM");
    expect(memberAvatar(members, null).initials).toBe("?");
  });

  it("maps a timeline event kind to a catalog key, unknown falls back", () => {
    expect(teamEventKey("created")).toBe("teamTask.event.created");
    expect(teamEventKey("assigned")).toBe("teamTask.event.assigned");
    expect(teamEventKey("nope")).toBeNull();
  });

  it("picks a timeline dot tone per kind", () => {
    expect(teamEventTone("created")).toBe("muted");
    expect(teamEventTone("assigned")).toBe("accent");
    expect(teamEventTone("reported")).toBe("warn");
  });
});
