import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTeamQueue, readTeamQueue, reconcileTeamQueue, type TeamContext } from "../../src/main/team";

const UUID = {
  local: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  task: "33333333-3333-4333-8333-333333333333",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCtx(reports: Record<string, unknown>[]): TeamContext {
  const dir = mkdtempSync(join(tmpdir(), "stellar-team-queue-"));
  dirs.push(dir);
  const api = {
    async reportTeamTaskState(_token: string, _teamId: string, _taskId: string, report: Record<string, unknown>) {
      reports.push(report);
      return { ok: true as const, value: {} as never };
    },
  };
  return {
    api: api as unknown as TeamContext["api"],
    token: "t",
    baseUserDataDir: dir,
    homeDir: "/home/fake",
    installId: "install",
    now: 1,
    generateId: () => "g",
    agentProviders: [],
    activeProfile: { id: UUID.local, dir, homeMode: "isolated" },
  };
}

function seed(ctx: TeamContext) {
  appendTeamQueue(ctx.activeProfile.dir, {
    localTaskId: UUID.local,
    boardId: "board",
    teamId: UUID.team,
    teamTaskId: UUID.task,
    ref: "#1",
    title: "Fila de retries",
    reportDelivered: false,
    acceptedAt: 1,
  });
}

describe("team-queue: local Fila bridge (state only, never code)", () => {
  it("round-trips the queue file", () => {
    const ctx = makeCtx([]);
    seed(ctx);
    const entries = readTeamQueue(ctx.activeProfile.dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ localTaskId: UUID.local, teamTaskId: UUID.task, reportDelivered: false });
  });

  it("reports rodando when a card is live on the local task", async () => {
    const reports: Record<string, unknown>[] = [];
    const ctx = makeCtx(reports);
    seed(ctx);
    const res = await reconcileTeamQueue(ctx, (id) => (id === UUID.local ? { status: "pending", cardAlive: true } : null));
    expect(res.reports).toEqual([{ localTaskId: UUID.local, reported: true }]);
    expect(reports).toEqual([{ state: "rodando" }]);
  });

  it("reports the delivered state when the local task is done, and does not repeat it", async () => {
    const reports: Record<string, unknown>[] = [];
    const ctx = makeCtx(reports);
    seed(ctx);
    await reconcileTeamQueue(ctx, () => ({ status: "done", cardAlive: false }));
    expect(reports).toEqual([{ state: "aguardando_revisao", report_delivered: true }]);
    expect(readTeamQueue(ctx.activeProfile.dir)[0]?.reportDelivered).toBe(true);
    // Second pass: already delivered -> nothing new.
    await reconcileTeamQueue(ctx, () => ({ status: "done", cardAlive: false }));
    expect(reports).toHaveLength(1);
  });

  it("reports nothing for an idle local task", async () => {
    const reports: Record<string, unknown>[] = [];
    const ctx = makeCtx(reports);
    seed(ctx);
    const res = await reconcileTeamQueue(ctx, () => ({ status: "pending", cardAlive: false }));
    expect(res.reports).toEqual([]);
    expect(reports).toEqual([]);
  });
});
