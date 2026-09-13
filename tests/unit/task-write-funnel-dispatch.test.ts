import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel, reachedDone } from "../../src/main/task-write-funnel";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";

/**
 * Task e83d2c10 (2026-09-13) — `onTaskDone` was called from ONE place only
 * (`update_task{status:"done"}` in the bus). Approve button, drag to
 * "concluído" and Allow on a status ask all wrote `done` through
 * `persistTask`/`persistColumnDrop` in index.ts and nothing observed it:
 * 312d4c0a (deps=[97f34bf8], parent done by button) sat `pending` with 0
 * task_cards. The fix moves the detection into the write funnel, fed by
 * the store's real `StatusWriteDecision`, and exposes `onTaskDone` on the
 * bus. This suite wires the REAL store + REAL bus + REAL funnel exactly as
 * index.ts does (`upsertTask: persistTask`, `onTaskDone: bus.onTaskDone`)
 * and drives the three human writes with the same rows the IPC handlers
 * build — the handlers themselves are one-line delegations inside
 * `createWindow` and cannot be imported without Electron.
 */

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id: "t",
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

type Rig = ReturnType<typeof buildRig>;

/** Same wiring as index.ts: funnel over the store, bus's `upsertTask` IS
 * `persistTask`, funnel's `onTaskDone` IS the bus's. `autonomous` flips
 * the board gate; `spawns` collects every dispatch the engine issued. */
function buildRig(dir: string, opts: { autonomous: boolean }) {
  const store = openStore(dir);
  const spawns: Array<Record<string, unknown>> = [];
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
      boardExists: () => true,
      getCardBoardId: () => undefined,
      isBoardAutonomous: () => opts.autonomous,
      countRunningAgentsOnBoard: () => 0,
      getBoardConcurrencyCap: () => 4,
      listCards: () => [],
      onSpawnAgentRequest: (_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
        spawns.push(params);
      },
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
  bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { store, bus, funnel, spawns, onTaskDoneCalls };
}

/** dep `d1` (pending) + dependent `child` (pending, deps=[d1]) — the
 * shape of 312d4c0a/97f34bf8 before the parent was marked done. */
function seedParentChild(rig: Rig) {
  rig.store.upsertTask(baseTask({ id: "d1", prompt: "investigar", status: "running", card_id: "card-d1", actor: "agent" }));
  rig.store.upsertTask(baseTask({ id: "child", prompt: "corrigir", deps_json: JSON.stringify(["d1"]), actor: "agent" }));
}

describe("task-write-funnel: every `done` writer dispatches dependents", () => {
  let dir: string;
  let rig: Rig | null;

  afterEach(() => {
    rig?.bus.close();
    rig?.store.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("approve button (`store:tasks:approve-completion` row) dispatches the dependent", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-approve-"));
    rig = buildRig(dir, { autonomous: true });
    seedParentChild(rig);
    const existing = rig.store.getTask("d1")!;

    // Exactly what the IPC handler writes.
    const decision = rig.funnel.persistTask({ ...existing, status: "done", updated_at: Date.now(), actor: "human" });

    expect(reachedDone(decision)).toBe(true);
    expect(rig.onTaskDoneCalls).toEqual(["d1"]);
    expect(rig.spawns).toHaveLength(1);
    expect(rig.spawns[0].taskId).toBe("child");
    // Prompt first, then the parent pointer (dep-pointer-decision.ts): d1
    // reached done by button, no card ever reported — the child is told.
    const brief = rig.spawns[0].brief as string;
    expect(brief.startsWith("corrigir\n\n---\n[stellar:deps]")).toBe(true);
    expect(brief).toContain("- d1 — status done, NO report on file");
    expect(rig.store.getTask("child")!.status).toBe("running");
  });

  it("drag to 'concluído' (`store:tasks:move` → persistColumnDrop) dispatches the dependent", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-drag-"));
    rig = buildRig(dir, { autonomous: true });
    seedParentChild(rig);
    rig.store.upsertTask(baseTask({ id: "neighbor", prompt: "outra", status: "done", actor: "human" }));
    const existing = rig.store.getTask("d1")!;
    const dragged: TaskRow = { ...existing, status: "done", order: 1, updated_at: Date.now(), actor: "human" };

    // `applyColumnDrop` used to discard the decision; the funnel now reads it.
    const decision = rig.funnel.persistColumnDrop(dragged, [{ id: "neighbor", implicitOrder: 0 }]);

    expect(decision.statusChanged).toBe(true);
    expect(decision.status).toBe("done");
    expect(rig.store.getTask("neighbor")!.implicit_order).toBe(0);
    expect(rig.spawns).toHaveLength(1);
    expect(rig.spawns[0].taskId).toBe("child");
    expect(rig.store.getTask("child")!.status).toBe("running");
  });

  it("Allow on a status ask (`store:tasks:respond-status-ask`) dispatches the dependent", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-allow-"));
    rig = buildRig(dir, { autonomous: true });
    seedParentChild(rig);
    rig.store.setStatusAsk("d1", { status: "done", reason: "acabei", requesterId: "card-d1", at: Date.now() });
    const existing = rig.store.getTask("d1")!;
    expect(existing.requested_status).toBe("done");

    // Exactly what the handler writes on `allowed === true`.
    rig.funnel.persistTask({ ...existing, status: existing.requested_status!, updated_at: Date.now(), actor: "human" });

    expect(rig.spawns).toHaveLength(1);
    expect(rig.spawns[0].taskId).toBe("child");
    expect(rig.store.getTask("child")!.status).toBe("running");
    expect(rig.store.getTask("d1")!.requested_status).toBeNull();
  });

  it("agent `update_task{done}` still dispatches — through the funnel, exactly once", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-update-"));
    rig = buildRig(dir, { autonomous: true });
    seedParentChild(rig);

    const res = (await rig.bus.handleRequest({ cmd: "update_task", taskId: "d1", status: "done" } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(rig.onTaskDoneCalls).toEqual(["d1"]);
    expect(rig.spawns).toHaveLength(1);
    expect(rig.spawns[0].taskId).toBe("child");
  });

  it("non-autonomous board: `done` is observed but nothing is dispatched (unchanged bookkeeping)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-hitl-"));
    rig = buildRig(dir, { autonomous: false });
    seedParentChild(rig);
    const existing = rig.store.getTask("d1")!;

    rig.funnel.persistTask({ ...existing, status: "done", updated_at: Date.now(), actor: "human" });

    expect(rig.onTaskDoneCalls).toEqual(["d1"]);
    expect(rig.spawns).toHaveLength(0);
    expect(rig.store.getTask("child")!.status).toBe("pending");
  });

  it("a HELD write (human locked status, agent proposes done) does not dispatch", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-held-"));
    rig = buildRig(dir, { autonomous: true });
    seedParentChild(rig);
    // Human moves d1 back to pending — decision 8: human status is locked.
    rig.funnel.persistTask({ ...rig.store.getTask("d1")!, status: "pending", updated_at: Date.now(), actor: "human" });

    const res = (await rig.bus.handleRequest({ cmd: "update_task", taskId: "d1", status: "done" } as BusRequest)) as {
      ok: boolean;
      warning?: string;
    };

    expect(res.ok).toBe(true);
    expect(res.warning).toBeTruthy();
    expect(rig.store.getTask("d1")!.status).toBe("pending");
    expect(rig.onTaskDoneCalls).toEqual([]);
    expect(rig.spawns).toHaveLength(0);
  });
});

describe("create_task with deps already done dispatches at birth", () => {
  let dir: string;
  let rig: Rig | null;

  afterEach(() => {
    rig?.bus.close();
    rig?.store.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("dep done before the child exists → child dispatched on create_task", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-birth-"));
    rig = buildRig(dir, { autonomous: true });
    rig.store.upsertTask(baseTask({ id: "parent", prompt: "investigar", status: "done", actor: "human" }));

    const res = (await rig.bus.handleRequest({
      cmd: "create_task",
      boardId: "b1",
      prompt: "corrigir com base no relatório",
      provider: "codex",
      deps: ["parent"],
    } as BusRequest)) as { ok: boolean; taskId: string; dispatched: boolean };

    expect(res.ok).toBe(true);
    expect(res.dispatched).toBe(true);
    expect(rig.spawns).toHaveLength(1);
    expect(rig.spawns[0].taskId).toBe(res.taskId);
    expect(rig.spawns[0].provider).toBe("codex");
    expect((rig.spawns[0].brief as string).startsWith("corrigir com base no relatório\n\n---\n[stellar:deps]")).toBe(true);
    expect(rig.store.getTask(res.taskId)!.status).toBe("running");
  });

  it("dep NOT done yet → stays pending at birth, dispatched later when the dep is approved", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-birth-later-"));
    rig = buildRig(dir, { autonomous: true });
    rig.store.upsertTask(baseTask({ id: "parent", prompt: "investigar", status: "running", actor: "agent" }));

    const res = (await rig.bus.handleRequest({ cmd: "create_task", boardId: "b1", prompt: "corrigir", deps: ["parent"] } as BusRequest)) as {
      ok: boolean;
      taskId: string;
      dispatched: boolean;
    };
    expect(res.dispatched).toBe(false);
    expect(rig.spawns).toHaveLength(0);
    expect(rig.store.getTask(res.taskId)!.status).toBe("pending");

    rig.funnel.persistTask({ ...rig.store.getTask("parent")!, status: "done", updated_at: Date.now(), actor: "human" });

    expect(rig.spawns).toHaveLength(1);
    expect(rig.spawns[0].taskId).toBe(res.taskId);
  });

  it("no deps → never auto-dispatched (a plain 'a fazer' task, as before)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-birth-nodeps-"));
    rig = buildRig(dir, { autonomous: true });

    const res = (await rig.bus.handleRequest({ cmd: "create_task", boardId: "b1", prompt: "solta" } as BusRequest)) as {
      ok: boolean;
      dispatched: boolean;
    };

    expect(res.dispatched).toBe(false);
    expect(rig.spawns).toHaveLength(0);
  });

  it("deps done but board not autonomous → pending, not dispatched", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-birth-hitl-"));
    rig = buildRig(dir, { autonomous: false });
    rig.store.upsertTask(baseTask({ id: "parent", status: "done", actor: "human" }));

    const res = (await rig.bus.handleRequest({ cmd: "create_task", boardId: "b1", prompt: "x", deps: ["parent"] } as BusRequest)) as {
      taskId: string;
      dispatched: boolean;
    };

    expect(res.dispatched).toBe(false);
    expect(rig.store.getTask(res.taskId)!.status).toBe("pending");
    expect(rig.spawns).toHaveLength(0);
  });
});

describe("no double dispatch, no recursion", () => {
  let dir: string;
  let rig: Rig | null;

  afterEach(() => {
    rig?.bus.close();
    rig?.store.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("approve button + agent update_task{done} back-to-back → one dispatch", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-double-"));
    rig = buildRig(dir, { autonomous: true });
    seedParentChild(rig);

    rig.funnel.persistTask({ ...rig.store.getTask("d1")!, status: "done", updated_at: Date.now(), actor: "human" });
    await rig.bus.handleRequest({ cmd: "update_task", taskId: "d1", status: "done" } as BusRequest);
    // And a second human gesture on an already-done row.
    rig.funnel.persistTask({ ...rig.store.getTask("d1")!, status: "done", updated_at: Date.now(), actor: "human" });

    // Only the FIRST write changed status; the others carry statusChanged:false.
    expect(rig.onTaskDoneCalls).toEqual(["d1"]);
    expect(rig.spawns).toHaveLength(1);
    expect(rig.store.getTask("child")!.status).toBe("running");
  });

  it("two deps finishing in sequence → dependent dispatched once, after the last one", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-twodeps-"));
    rig = buildRig(dir, { autonomous: true });
    rig.store.upsertTask(baseTask({ id: "a", status: "running", actor: "agent" }));
    rig.store.upsertTask(baseTask({ id: "b", status: "running", actor: "agent" }));
    rig.store.upsertTask(baseTask({ id: "child", deps_json: JSON.stringify(["a", "b"]), actor: "agent" }));

    rig.funnel.persistTask({ ...rig.store.getTask("a")!, status: "done", updated_at: Date.now(), actor: "human" });
    expect(rig.spawns).toHaveLength(0);
    expect(rig.store.getTask("child")!.status).toBe("pending");

    rig.funnel.persistTask({ ...rig.store.getTask("b")!, status: "done", updated_at: Date.now(), actor: "human" });
    expect(rig.spawns).toHaveLength(1);

    // A stray re-notification for either dep finds the child already running.
    rig.bus.onTaskDone("a");
    rig.bus.onTaskDone("b");
    expect(rig.spawns).toHaveLength(1);
  });

  it("dispatch writes `running` back through the funnel without re-entering onTaskDone", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-funnel-reentry-"));
    rig = buildRig(dir, { autonomous: true });
    // A chain: d1 → child → grandchild. Finishing d1 must dispatch child
    // only; grandchild waits for child to actually reach done.
    seedParentChild(rig);
    rig.store.upsertTask(baseTask({ id: "grandchild", deps_json: JSON.stringify(["child"]), actor: "agent" }));

    rig.funnel.persistTask({ ...rig.store.getTask("d1")!, status: "done", updated_at: Date.now(), actor: "human" });

    expect(rig.onTaskDoneCalls).toEqual(["d1"]);
    expect(rig.spawns.map((s) => s.taskId)).toEqual(["child"]);
    expect(rig.store.getTask("grandchild")!.status).toBe("pending");
  });

  it("reachedDone: only a CHANGED status equal to done counts", () => {
    const base: StatusWriteDecision = {
      status: "done",
      statusChanged: false,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    };
    expect(reachedDone(base)).toBe(false);
    expect(reachedDone({ ...base, statusChanged: true })).toBe(true);
    expect(reachedDone({ ...base, statusChanged: true, status: "running" })).toBe(false);
    expect(reachedDone({ ...base, statusChanged: true, status: "failed" })).toBe(false);
  });
});
