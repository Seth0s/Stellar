import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import { deriveCompletionProposal } from "../../src/renderer/src/task-board-model";

/**
 * CAMADA 4 gate — real store + real bus + real funnel (same wiring as
 * index.ts). Implementer may only request; outsider/reviewer may write
 * judgment; the Fila proposal bar stays presentation-only.
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

function buildRig(dir: string, opts: { autonomous: boolean } = { autonomous: false }) {
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
      isBoardAutonomous: () => opts.autonomous,
      isCardAlive: () => true,
      countRunningAgentsOnBoard: () => 0,
      getBoardConcurrencyCap: () => 4,
      listCards: () => [],
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
  bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { store, bus, funnel, onTaskDoneCalls };
}

describe("CAMADA 4: integrante não julga (store real)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("implementer update_task{done} is refused; request_task_status parks; task stays not done", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-judgment-impl-"));
    rig = buildRig(dir);
    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");

    const write = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "impl-1",
    } as BusRequest);
    expect(write.ok).toBe(false);
    expect(String(write.error)).toContain("request_task_status");
    expect(rig.store.getTask("t1")!.status).toBe("pending");
    expect(rig.store.getTask("t1")!.requested_status ?? null).toBeNull();
    expect(rig.onTaskDoneCalls).toEqual([]);

    const ask = await rig.bus.handleRequest({
      cmd: "request_task_status",
      taskId: "t1",
      status: "done",
      reason: "pronto",
      requesterId: "impl-1",
    } as BusRequest);
    expect(ask).toMatchObject({ ok: true, pending: true, requestedStatus: "done", status: "pending" });
    const row = rig.store.getTask("t1")!;
    expect(row.status).toBe("pending");
    expect(row.requested_status).toBe("done");
    expect(row.requested_by).toBe("impl-1");
    expect(rig.onTaskDoneCalls).toEqual([]);
  });

  it("orchestrator (not linked) marks done and it applies + onTaskDone", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-judgment-orch-"));
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
    expect(rig.onTaskDoneCalls).toEqual(["t1"]);
  });

  it("anonymous requesterId (outsider) may write done — same as MASTER without a stamp", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-judgment-anon-"));
    rig = buildRig(dir);
    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");

    const res = await rig.bus.handleRequest({ cmd: "update_task", taskId: "t1", status: "done" } as BusRequest);
    expect(res.ok).toBe(true);
    expect(rig.store.getTask("t1")!.status).toBe("done");
  });

  it("reviewer with aprovado may write done (role judges)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-judgment-rev-"));
    rig = buildRig(dir);
    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "impl-1", actor: "agent" }));
    rig.store.linkTaskCard("t1", "impl-1", "implementer");
    // Detach principal before linking reviewer (bus rule); store link is fine
    // for the gate — we only need the role row.
    rig.store.linkTaskCard("t1", "rev-1", "reviewer");
    rig.store.recordParticipationRound("rev-1", "aprovado", Date.now(), "t1");

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

  it("autonomous board: outsider orchestrator closes; implementer still refused", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-judgment-auto-"));
    rig = buildRig(dir, { autonomous: true });
    rig.store.upsertTask(baseTask({ id: "t1", status: "pending", card_id: "worker", actor: "agent" }));
    rig.store.linkTaskCard("t1", "worker", "implementer");

    const refused = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "worker",
    } as BusRequest);
    expect(refused.ok).toBe(false);
    expect(rig.store.getTask("t1")!.status).toBe("pending");

    const closed = await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      requesterId: "orch-master",
    } as BusRequest);
    expect(closed.ok).toBe(true);
    expect(rig.store.getTask("t1")!.status).toBe("done");
  });

  it("Fila bar without reviewer: same self proposal as before (presentation only)", () => {
    const proposal = deriveCompletionProposal("running", ["implementer"], [
      { cardId: "impl-1", role: "implementer", verdict: "aprovado", at: 10 },
    ]);
    expect(proposal).toEqual({ verdict: "aprovado", origin: "self", cardId: "impl-1", at: 10 });
  });
});
