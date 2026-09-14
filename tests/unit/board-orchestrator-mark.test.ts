import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type BoardRow, type CardRow, type TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import { decideReportNotifyTarget } from "../../src/main/report-notify-routing";
import {
  decideJudgmentWrite,
  describeReviewWantedJudgmentRefusal,
} from "../../src/main/judgment-write-decision";

/**
 * Board orchestrator mark — real store + bus. Gates from the owner
 * contract (2026-09-14): UI-only mark lives on boards; delegated
 * signature stamps actor `orchestrator`; participation still wins;
 * unmarked board identical to today; mark drops on card close; reports
 * route to the marked card when alive.
 */

function makeBoard(id: string): BoardRow {
  const now = Date.now();
  return {
    id,
    name: `Board ${id}`,
    project: "",
    cwd: "",
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    autonomous: false,
    concurrency_cap: null,
    orchestrator_card_id: null,
  };
}

function makeCard(id: string, boardId: string, kind = "terminal"): CardRow {
  const now = Date.now();
  return {
    id,
    board_id: boardId,
    kind,
    provider: kind === "terminal" ? "claude" : "",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: now,
    messages_json: null,
    archived_at: null,
    created_at: now,
  };
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id: "t1",
    prompt: "faz X",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildRig(dir: string, opts: { alive?: (id: string) => boolean } = {}) {
  const store = openStore(dir);
  const onTaskDoneCalls: string[] = [];
  let bus: ReturnType<typeof createMessageBus> | null = null;
  const funnel = createTaskWriteFunnel({
    upsertTask: (task) => store.upsertTask(task),
    applyColumnDrop: (dragged, siblings) => store.applyColumnDrop(dragged, siblings),
    afterWrite: () => {},
    onTaskDone: (taskId) => {
      onTaskDoneCalls.push(taskId);
      bus?.onTaskDone(taskId);
    },
  });
  const alive = opts.alive ?? (() => true);
  const callbacks = new Proxy(
    {
      listTasks: () => store.listTasks(),
      getTask: (id: string) => store.getTask(id),
      upsertTask: (task: TaskRow) => funnel.persistTask(task),
      setStatusAsk: (taskId: string, ask: Parameters<typeof store.setStatusAsk>[1]) => store.setStatusAsk(taskId, ask),
      getTaskCards: (taskId: string) => store.getTaskCards(taskId),
      listTaskCardsForCard: (cardId: string) => store.listTaskCardsForCard(cardId),
      linkTaskCard: (taskId: string, cardId: string, role: string) => store.linkTaskCard(taskId, cardId, role),
      boardExists: () => true,
      getCardBoardId: (id: string) => store.getCard(id)?.board_id,
      isBoardAutonomous: () => false,
      getBoardOrchestratorCardId: (boardId: string) => store.getBoard(boardId)?.orchestrator_card_id ?? null,
      isCardAlive: (id: string) => alive(id),
      countRunningAgentsOnBoard: () => 0,
      getBoardConcurrencyCap: () => 4,
      listCards: () => store.listCards("b1"),
      listAllConnectors: () => store.listAllConnectors(),
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
  bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { store, bus, funnel, onTaskDoneCalls };
}

describe("board orchestrator mark (store real)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("marked card signs done and trail records actor orchestrator (never human)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-orch-sign-"));
    rig = buildRig(dir);
    rig.store.upsertBoard(makeBoard("b1"));
    rig.store.upsertCard(makeCard("orch-1", "b1"));
    expect(rig.store.setBoardOrchestratorCardId("b1", "orch-1")).toBe(true);
    expect(rig.store.getBoard("b1")!.orchestrator_card_id).toBe("orch-1");

    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");

    const res = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "orch-1",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(rig.store.getTask("t1")!.status).toBe("done");
    expect(rig.onTaskDoneCalls).toEqual(["t1"]);

    const trail = rig.store.getTask("t1")!.transitions!;
    const statusRows = trail.filter((r) => r.kind === "status" && r.to_value === "done");
    expect(statusRows.some((r) => r.actor === "orchestrator")).toBe(true);
    expect(statusRows.every((r) => r.actor !== "human")).toBe(true);
  });

  it("SAME card as implementer of the task does NOT sign — only asks (participation wins)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-orch-part-"));
    rig = buildRig(dir);
    rig.store.upsertBoard(makeBoard("b1"));
    rig.store.upsertCard(makeCard("orch-impl", "b1"));
    expect(rig.store.setBoardOrchestratorCardId("b1", "orch-impl")).toBe(true);

    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "orch-impl", actor: "agent" }));
    rig.store.linkTaskCard("t1", "orch-impl", "implementer");

    const write = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "orch-impl",
    } as BusRequest);
    expect(write.ok).toBe(false);
    expect(String(write.error)).toContain("request_task_status");
    expect(rig.store.getTask("t1")!.status).toBe("pending");
    expect(rig.onTaskDoneCalls).toEqual([]);
  });

  it("unmarked board: outsider update_task still applies as agent (identical to today)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-orch-unmarked-"));
    rig = buildRig(dir);
    rig.store.upsertBoard(makeBoard("b1"));
    rig.store.upsertCard(makeCard("outsider", "b1"));
    expect(rig.store.getBoard("b1")!.orchestrator_card_id).toBeNull();

    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");

    const res = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "outsider",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(rig.store.getTask("t1")!.status).toBe("done");
    const trail = rig.store.getTask("t1")!.transitions!;
    const done = trail.filter((r) => r.kind === "status" && r.to_value === "done");
    expect(done.some((r) => r.actor === "agent")).toBe(true);
    expect(done.every((r) => r.actor !== "orchestrator")).toBe(true);
  });

  it("mark falls when the card is deleted — board returns to unmarked", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-orch-close-"));
    rig = buildRig(dir);
    rig.store.upsertBoard(makeBoard("b1"));
    rig.store.upsertCard(makeCard("orch-1", "b1"));
    expect(rig.store.setBoardOrchestratorCardId("b1", "orch-1")).toBe(true);
    rig.store.deleteCard("orch-1");
    expect(rig.store.getBoard("b1")!.orchestrator_card_id).toBeNull();
  });

  it("one column: setting a second card replaces the first (two marks inexpressible)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-orch-one-"));
    rig = buildRig(dir);
    rig.store.upsertBoard(makeBoard("b1"));
    rig.store.upsertCard(makeCard("a", "b1"));
    rig.store.upsertCard(makeCard("b", "b1"));
    expect(rig.store.setBoardOrchestratorCardId("b1", "a")).toBe(true);
    expect(rig.store.setBoardOrchestratorCardId("b1", "b")).toBe(true);
    expect(rig.store.getBoard("b1")!.orchestrator_card_id).toBe("b");
  });

  it("refuses sticky/non-terminal and foreign-board cards", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-orch-refuse-"));
    rig = buildRig(dir);
    rig.store.upsertBoard(makeBoard("b1"));
    rig.store.upsertBoard(makeBoard("b2"));
    rig.store.upsertCard(makeCard("sticky-1", "b1", "sticky"));
    rig.store.upsertCard(makeCard("other", "b2"));
    expect(rig.store.setBoardOrchestratorCardId("b1", "sticky-1")).toBe(false);
    expect(rig.store.setBoardOrchestratorCardId("b1", "other")).toBe(false);
    expect(rig.store.getBoard("b1")!.orchestrator_card_id).toBeNull();
  });
});

describe("decideReportNotifyTarget — orchestrator mark", () => {
  const base = {
    directiveFromId: null as string | null,
    directiveFromAlive: false,
    spawnedById: "spawner-1" as string | null,
    spawnedByAlive: true,
  };

  it("alive mark wins over spawned lineage", () => {
    expect(
      decideReportNotifyTarget({
        ...base,
        orchestratorCardId: "orch-board",
        orchestratorAlive: true,
      }),
    ).toEqual({ targetId: "orch-board", source: "orchestrator" });
  });

  it("dead mark escalates to human (none) — does not fall through to spawner", () => {
    expect(
      decideReportNotifyTarget({
        ...base,
        orchestratorCardId: "orch-board",
        orchestratorAlive: false,
      }),
    ).toEqual({ targetId: null, source: "none" });
  });

  it("unmarked keeps spawned behavior (identical to today)", () => {
    expect(decideReportNotifyTarget({ ...base })).toEqual({
      targetId: "spawner-1",
      source: "spawned",
    });
  });
});

describe("decideJudgmentWrite — reviewWanted extension point", () => {
  it("when reviewWanted, outsider/orchestrator is refused; reviewer still allowed", () => {
    const refused = decideJudgmentWrite({
      proposedStatus: "done",
      requesterRoleOnTask: null,
      reviewWanted: true,
    });
    expect(refused).toEqual({
      action: "refuse",
      error: describeReviewWantedJudgmentRefusal("done"),
    });
    expect(
      decideJudgmentWrite({
        proposedStatus: "done",
        requesterRoleOnTask: "reviewer",
        reviewWanted: true,
      }),
    ).toEqual({ action: "allow" });
  });
});
