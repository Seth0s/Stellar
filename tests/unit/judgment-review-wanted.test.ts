import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import {
  decideJudgmentWrite,
  describeReviewWantedJudgmentRefusal,
} from "../../src/main/judgment-write-decision";
import { deriveCompletionProposal, describeReviewWantedNotice } from "../../src/renderer/src/task-board-model";

/**
 * CAMADA 1 — `tasks.review = "wanted"` wired into CAMADA 4's gate.
 * Real store + bus: implementer / outsider / orchestrator refused;
 * reviewer allowed; undeclared review identical to today; refusal names
 * the field.
 */

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

function buildRig(dir: string) {
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
      getCardBoardId: () => "b1",
      getBoardOrchestratorCardId: (boardId: string) => (boardId === "b1" ? "orch-1" : null),
      isBoardAutonomous: () => false,
      isCardAlive: () => true,
      countRunningAgentsOnBoard: () => 0,
      getBoardConcurrencyCap: () => 4,
      listCards: () => [],
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
  bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { store, bus, onTaskDoneCalls };
}

describe("CAMADA 1: review=wanted (store real)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("create with review=wanted persists; omit stays null (undeclared)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-review-create-"));
    rig = buildRig(dir);
    const wanted = await rig.bus.handleRequest({
      cmd: "create_task",
      prompt: "risky",
      provider: "claude",
      boardId: "b1",
      review: "wanted",
    } as BusRequest);
    expect(wanted.ok).toBe(true);
    const id = (wanted as { taskId: string }).taskId;
    expect(rig.store.getTask(id)!.review).toBe("wanted");

    const bare = await rig.bus.handleRequest({
      cmd: "create_task",
      prompt: "plain",
      provider: "claude",
      boardId: "b1",
    } as BusRequest);
    expect(bare.ok).toBe(true);
    expect(rig.store.getTask((bare as { taskId: string }).taskId)!.review).toBeNull();

    const got = (await rig.bus.handleRequest({ cmd: "get_task", taskId: id } as BusRequest)) as {
      task: { review: unknown };
    };
    expect(got.task.review).toBe("wanted");
  });

  it("invalid review on create is refused (names the field)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-review-bad-"));
    rig = buildRig(dir);
    const res = await rig.bus.handleRequest({
      cmd: "create_task",
      prompt: "x",
      review: "none",
    } as BusRequest);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("review");
    expect(String(res.error)).toContain("wanted");
    expect(rig.store.listTasks()).toHaveLength(0);
  });

  it("review is mutable via update_task (set wanted later; clear with null)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-review-mut-"));
    rig = buildRig(dir);
    const created = await rig.bus.handleRequest({
      cmd: "create_task",
      prompt: "escalates",
      provider: "claude",
      boardId: "b1",
    } as BusRequest);
    const id = (created as { taskId: string }).taskId;
    expect(rig.store.getTask(id)!.review).toBeNull();

    const set = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: id,
      review: "wanted",
    } as BusRequest);
    expect(set.ok).toBe(true);
    expect(rig.store.getTask(id)!.review).toBe("wanted");

    const clear = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: id,
      review: null,
    } as BusRequest);
    expect(clear.ok).toBe(true);
    expect(rig.store.getTask(id)!.review).toBeNull();
  });

  it("with review=wanted: refuses done from implementer, outsider, AND orchestrator; names review", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-review-gate-"));
    rig = buildRig(dir);
    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", review: "wanted", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");

    const asImpl = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "impl-1",
    } as BusRequest);
    expect(asImpl.ok).toBe(false);
    expect(String(asImpl.error)).toContain('review="wanted"');
    expect(String(asImpl.error)).toContain("role=reviewer");

    const asOutsider = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "outsider-9",
    } as BusRequest);
    expect(asOutsider.ok).toBe(false);
    expect(String(asOutsider.error)).toBe(describeReviewWantedJudgmentRefusal("done"));

    const asOrch = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "orch-1",
    } as BusRequest);
    expect(asOrch.ok).toBe(false);
    expect(String(asOrch.error)).toContain("orchestrator");
    expect(rig.store.getTask("t1")!.status).toBe("pending");
    expect(rig.onTaskDoneCalls).toEqual([]);
  });

  it("with review=wanted: reviewer may write done", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-review-ok-"));
    rig = buildRig(dir);
    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", review: "wanted", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");
    rig.store.linkTaskCard("t1", "rev-1", "reviewer");

    const res = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "rev-1",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(rig.store.getTask("t1")!.status).toBe("done");
    expect(rig.onTaskDoneCalls).toEqual(["t1"]);
  });

  it("without review field: outsider still closes (identical to today)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-review-absent-"));
    rig = buildRig(dir);
    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");

    const res = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "master-330",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(rig.store.getTask("t1")!.status).toBe("done");
  });
});

describe("decideJudgmentWrite + Fila presentation for review=wanted", () => {
  it("pure gate matches store behaviour", () => {
    expect(
      decideJudgmentWrite({
        proposedStatus: "done",
        requesterRoleOnTask: null,
        reviewWanted: true,
      }),
    ).toEqual({ action: "refuse", error: describeReviewWantedJudgmentRefusal("done") });
    expect(
      decideJudgmentWrite({
        proposedStatus: "done",
        requesterRoleOnTask: "reviewer",
        reviewWanted: true,
      }),
    ).toEqual({ action: "allow" });
  });

  it("Fila: no self auto-aprovado when review wanted; notice while no reviewer", () => {
    const self = deriveCompletionProposal(
      "running",
      ["implementer"],
      [{ cardId: "impl-1", role: "implementer", verdict: "aprovado", at: 10 }],
      true,
    );
    expect(self).toBeNull();
    expect(describeReviewWantedNotice("wanted", ["implementer"])).toMatch(/review/i);
    expect(describeReviewWantedNotice("wanted", ["implementer", "reviewer"])).toBeNull();
    expect(describeReviewWantedNotice(null, ["implementer"])).toBeNull();
  });
});
