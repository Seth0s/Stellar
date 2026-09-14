import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { ReportRow, TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import { DEP_POINTER_MARKER } from "../../src/main/dep-pointer-decision";

/**
 * `buildTaskDispatchParams` (message-bus.ts) — a dependent's brief now
 * carries the parent POINTER derived from `deps_json` + stored facts
 * (dep-pointer-decision.ts). Exercised through the real dispatch path:
 * the write funnel observes `done`, `onTaskDone` → `dispatchIfUnblocked`
 * → `buildTaskDispatchParams` → `onSpawnAgentRequest`. Same harness as
 * message-bus-task-dispatch-cwd.test.ts.
 *
 * Empty deps never reach auto-dispatch (`dispatchIfUnblocked` returns
 * early), so the "brief unchanged" regression is pinned on the OTHER
 * task-tied spawn path that shares the helper: `spawn_agent({taskId})`.
 */

function applied(status: string): StatusWriteDecision {
  return { status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null };
}

function funnelled(decide: (task: TaskRow) => StatusWriteDecision, getBus: () => ReturnType<typeof createMessageBus> | null) {
  return createTaskWriteFunnel({
    upsertTask: decide,
    applyColumnDrop: (dragged) => decide(dragged),
    afterWrite: () => {},
    onTaskDone: (id) => getBus()?.onTaskDone(id),
  }).persistTask;
}

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "getCardBoardId") return () => undefined;
        if (prop === "isBoardAutonomous") return () => false;
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t",
    prompt: "child work",
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
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function report(cardId: string, seq: number, body: Record<string, unknown>, verdict: string | null = null): ReportRow {
  return { card_id: cardId, seq, report_json: JSON.stringify(body), verdict, updated_at: seq };
}

describe("message-bus: buildTaskDispatchParams aponta para os pais", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Marks `trigger` done through the funnel and returns whatever was
   * spawned. `tasks` is the post-write world: the funnel calls
   * `onTaskDone` AFTER the store wrote `done` (task-write-funnel.ts), so
   * both `listTasks` and `getTask` (+ its transient `cards`) already see
   * the parent as done when the pointer is built — same as production. */
  async function markDone(trigger: string, tasks: TaskRow[], reports: ReportRow[] = []) {
    dir = mkdtempSync(join(tmpdir(), "stellar-dep-pointer-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const persistTask = funnelled((task) => applied(task.status), () => bus);
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: ((id: string) => tasks.find((t) => t.id === id)) as never,
        listTasks: (() => tasks) as never,
        isBoardAutonomous: (() => true) as never,
        countRunningAgentsOnBoard: (() => 0) as never,
        getBoardConcurrencyCap: (() => 4) as never,
        getReport: ((cardId: string) => {
          const mine = reports.filter((r) => r.card_id === cardId).sort((a, b) => b.seq - a.seq);
          return mine[0];
        }) as never,
        upsertTask: ((task: TaskRow) => persistTask(task)) as never,
        onSpawnAgentRequest: ((_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        }) as never,
      }),
    );
    await bus.handleRequest({ cmd: "update_task", taskId: trigger, status: "done" } as BusRequest);
    return spawnParams;
  }

  it("1 dep com relatório ok: brief = prompt + ponteiro com id do pai e card do relatório", async () => {
    const parent = baseTask({ id: "e83d2c10-92c1-4794-9800-a3fc63452400", status: "done", prompt: "parent", cards: [{ task_id: "e83d2c10-92c1-4794-9800-a3fc63452400", card_id: "471", role: "implementer" }] } as Partial<TaskRow>);
    const child = baseTask({ id: "child-1", deps_json: JSON.stringify([parent.id]), prompt: "child work" });
    const spawned = await markDone(parent.id, [parent, child], [report("471", 216, { ok: true, summary: "did it" })]);

    expect(spawned).toHaveLength(1);
    const brief = spawned[0].brief as string;
    expect(brief.startsWith("child work\n\n---\n" + DEP_POINTER_MARKER)).toBe(true);
    expect(brief).toContain(`- ${parent.id} — status done; read_report on card 471: ok`);
    // Pointer, not content — the report body never lands in the PTY.
    expect(brief).not.toContain("did it");
    expect(spawned[0].taskId).toBe("child-1");
    expect(spawned[0].label).toBe("child work");
  });

  it("N deps: uma linha por pai; o último a fechar dispara com todos os pais listados", async () => {
    const a = baseTask({ id: "parent-a", status: "done", cards: [{ task_id: "parent-a", card_id: "10", role: "implementer" }] } as Partial<TaskRow>);
    const b = baseTask({ id: "parent-b", status: "done", cards: [{ task_id: "parent-b", card_id: "11", role: "implementer" }] } as Partial<TaskRow>);
    const child = baseTask({ id: "child-n", deps_json: JSON.stringify(["parent-a", "parent-b"]) });
    const spawned = await markDone("parent-b", [a, b, child], [report("10", 1, { ok: true }), report("11", 2, { ok: true, verdict: "aprovado" }, "aprovado")]);

    expect(spawned).toHaveLength(1);
    const brief = spawned[0].brief as string;
    expect(brief).toContain("depends on 2 parent tasks.");
    expect(brief).toContain("- parent-a — status done; read_report on card 10: ok");
    expect(brief).toContain("- parent-b — status done; read_report on card 11: ok, verdict aprovado");
  });

  it("dep done sem relatório (botão humano / saiu sem report): o ponteiro avisa em vez de apontar pro vazio", async () => {
    const silent = baseTask({ id: "parent-silent", status: "done", cards: [{ task_id: "parent-silent", card_id: "20", role: "implementer" }] } as Partial<TaskRow>);
    const child = baseTask({ id: "child-s", deps_json: JSON.stringify(["parent-silent"]) });
    const spawned = await markDone("parent-silent", [silent, child], []);

    expect(spawned).toHaveLength(1);
    const brief = spawned[0].brief as string;
    expect(brief).toContain("- parent-silent — status done, NO report on file");
    expect(brief).toContain("verify its work yourself");
  });

  it("dep done com relatório ok:false (marcado done à mão depois): FAILED aparece no ponteiro", async () => {
    const failed = baseTask({ id: "parent-f", status: "done", cards: [{ task_id: "parent-f", card_id: "30", role: "implementer" }] } as Partial<TaskRow>);
    const child = baseTask({ id: "child-f", deps_json: JSON.stringify(["parent-f"]) });
    const spawned = await markDone("parent-f", [failed, child], [report("30", 5, { ok: false, error: "broke" })]);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].brief as string).toContain("card 30: ok:false (FAILED");
  });

  it("dep com vários cards (retry): o card mais recente vem primeiro", async () => {
    const parent = baseTask({
      id: "parent-r",
      status: "done",
      cards: [
        { task_id: "parent-r", card_id: "40", role: "implementer" },
        { task_id: "parent-r", card_id: "41", role: "implementer" },
      ],
    } as Partial<TaskRow>);
    const child = baseTask({ id: "child-r", deps_json: JSON.stringify(["parent-r"]) });
    const spawned = await markDone("parent-r", [parent, child], [report("40", 1, { ok: false }), report("41", 2, { ok: true })]);

    const brief = spawned[0].brief as string;
    expect(brief).toContain("read_report on card 41: ok; card 40: ok:false");
  });

  it("filho com deps e sem prompt recebe só o ponteiro — não abre mudo e sem pai", async () => {
    const parent = baseTask({ id: "parent-p", status: "done" });
    const child = baseTask({ id: "child-p", deps_json: JSON.stringify(["parent-p"]), prompt: null });
    const spawned = await markDone("parent-p", [parent, child]);

    expect(spawned).toHaveLength(1);
    expect((spawned[0].brief as string).startsWith(DEP_POINTER_MARKER)).toBe(true);
  });
});

describe("message-bus: spawn_agent({taskId}) compartilha o ponteiro", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function spawnFor(task: TaskRow, others: TaskRow[] = [], reports: ReportRow[] = [], req: Partial<BusRequest> = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-dep-pointer-spawn-"));
    const spawned: Array<Record<string, unknown>> = [];
    const all = [task, ...others];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        onSpawnAgentRequest: ((requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawned.push(params);
          bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "new-card" });
        }) as never,
        getTask: ((id: string) => all.find((t) => t.id === id)) as never,
        getReport: ((cardId: string) => reports.find((r) => r.card_id === cardId)) as never,
        upsertTask: ((t: TaskRow) => applied(t.status)) as never,
        listCards: (() => [{ id: "new-card", kind: "terminal", provider: "claude", cwd: "", label: null }]) as never,
      }),
    );
    const res = (await bus.handleRequest({ cmd: "spawn_agent", provider: "claude", taskId: task.id, reason: "test", requesterId: "orch", ...req } as BusRequest)) as { ok: boolean };
    return { res, spawned };
  }

  it("deps vazio: brief é o prompt, byte a byte (regressão)", async () => {
    const task = baseTask({ id: "solo", prompt: "implement the thing", status: "running", deps_json: null });
    const { res, spawned } = await spawnFor(task);
    expect(res.ok).toBe(true);
    expect(spawned[0].brief).toBe("implement the thing");

    const empty = baseTask({ id: "solo2", prompt: "implement the thing", status: "running", deps_json: "[]" });
    const second = await spawnFor(empty);
    expect(second.spawned[0].brief).toBe("implement the thing");
  });

  it("com deps: implementer manual recebe o mesmo ponteiro do auto-dispatch", async () => {
    const parent = baseTask({ id: "parent-m", status: "done", cards: [{ task_id: "parent-m", card_id: "50", role: "implementer" }] } as Partial<TaskRow>);
    const task = baseTask({ id: "child-m", prompt: "manual child", status: "pending", deps_json: JSON.stringify(["parent-m"]) });
    const { spawned } = await spawnFor(task, [parent], [report("50", 3, { ok: true })]);
    const brief = spawned[0].brief as string;
    expect(brief.startsWith("manual child\n\n---\n" + DEP_POINTER_MARKER)).toBe(true);
    expect(brief).toContain("- parent-m — status done; read_report on card 50: ok");
  });

  it("reviewer não recebe ponteiro: o brief é a ordem de revisão, intacta", async () => {
    const parent = baseTask({ id: "parent-v", status: "done" });
    const task = baseTask({ id: "child-v", prompt: "work", status: "running", deps_json: JSON.stringify(["parent-v"]) });
    const { spawned } = await spawnFor(task, [parent], [], { role: "reviewer", brief: "review it" } as Partial<BusRequest>);
    expect(spawned[0].brief).toBe("review it");
  });
});
