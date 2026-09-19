import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskCardRow, TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";

/**
 * "Cards fantasma" (2026-09-19): a dep closing auto-dispatched a task that
 * was already being worked.
 *
 * (a) cwd declarado na task nunca vira raiz do board em silêncio — o
 *     dispatch lê o cwd da linha AUTORITATIVA, não do snapshot do chamador.
 * (b) task com card vivo linkado (task_cards, época viva) não é
 *     auto-despachada de novo.
 */

function funnelled(
  decide: (task: TaskRow) => StatusWriteDecision,
  getBus: () => ReturnType<typeof createMessageBus> | null,
) {
  return createTaskWriteFunnel({
    upsertTask: decide,
    applyColumnDrop: (dragged) => decide(dragged),
    afterWrite: () => {},
    onTaskDone: (id) => getBus()?.onTaskDone(id),
  }).persistTask;
}

function applied(status: string): StatusWriteDecision {
  return {
    status,
    statusChanged: true,
    divergedStatus: null,
    divergedActor: null,
    recordDeclaration: false,
    warnAgent: false,
    declaredStatus: null,
  };
}

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t",
    prompt: "i18n fase 2",
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

describe("auto-dispatch não pare card fantasma", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("(a) usa o cwd declarado da linha autoritativa, mesmo com o snapshot sem cwd", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-phantom-cwd-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    // Snapshot de `listTasks` sem cwd (escrito ANTES do update_task que
    // declarou o cwd); a linha do getTask já o tem. Ninguém na cadeia de
    // deps declara cwd — pré-correção isso virava `undefined` e o renderer
    // aplicava `cwd || activeBoardCwd` (raiz do board) em silêncio.
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", cwd: null });
    const snapshot = baseTask({
      id: "child",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
      cwd: null,
      prompt: "fase 2",
    });
    const stored: TaskRow = { ...snapshot, cwd: "/tmp/stellar-wt/w1" };
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) =>
          id === "dep-done" ? { ...dep, status: "running" } : id === "child" ? stored : undefined,
        listTasks: () => [dep, snapshot],
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        upsertTask: (task: TaskRow) => persistTask(task),
        onSpawnAgentRequest: (_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        },
      }),
    );

    await bus.handleRequest({ cmd: "update_task", taskId: "dep-done", status: "done" } as BusRequest);

    expect(spawnParams).toHaveLength(1);
    expect(spawnParams[0].cwd).toBe("/tmp/stellar-wt/w1");
  });

  it("(b) NÃO despacha quando a task já tem card vivo linkado por task_cards", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-phantom-live-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", cwd: "/tmp/parent" });
    const pending = baseTask({
      id: "child",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
      prompt: "fase 2",
    });
    const link: TaskCardRow = { task_id: "child", card_id: "777", role: "implementer", linked_at: 200 };
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "dep-done" ? { ...dep, status: "running" } : id === "child" ? pending : undefined),
        listTasks: () => [dep, pending],
        getTaskCards: (id: string) => (id === "child" ? [link] : []),
        listTaskCardsForCard: (id: string) => (id === "777" ? [link] : []),
        isCardAlive: (id: string) => id === "777",
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        upsertTask: (task: TaskRow) => persistTask(task),
        onSpawnAgentRequest: (_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        },
      }),
    );

    await bus.handleRequest({ cmd: "update_task", taskId: "dep-done", status: "done" } as BusRequest);

    expect(spawnParams).toHaveLength(0);
    expect(pending.card_id).toBeNull();
  });

  it("(b) card linkado mas já morto não bloqueia o despacho", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-phantom-dead-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", cwd: null });
    const pending = baseTask({
      id: "child",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
      prompt: "fase 2",
    });
    const link: TaskCardRow = { task_id: "child", card_id: "777", role: "implementer", linked_at: 200 };
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "dep-done" ? { ...dep, status: "running" } : id === "child" ? pending : undefined),
        listTasks: () => [dep, pending],
        getTaskCards: (id: string) => (id === "child" ? [link] : []),
        listTaskCardsForCard: (id: string) => (id === "777" ? [link] : []),
        isCardAlive: () => false,
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        upsertTask: (task: TaskRow) => persistTask(task),
        onSpawnAgentRequest: (_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        },
      }),
    );

    await bus.handleRequest({ cmd: "update_task", taskId: "dep-done", status: "done" } as BusRequest);

    expect(spawnParams).toHaveLength(1);
    expect(spawnParams[0].taskId).toBe("child");
  });

  it("(b) link de card reciclado (época vencida) não bloqueia o despacho", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-phantom-recycle-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", cwd: null });
    const pending = baseTask({
      id: "child",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
      prompt: "fase 2",
    });
    // `linked_at` (100) < `cards.created_at` (200): o id do card foi
    // reciclado e o vínculo é histórico — a leitura por card (a MESMA que
    // a regra consulta) devolve vazio.
    const staleLink: TaskCardRow = { task_id: "child", card_id: "888", role: "implementer", linked_at: 100 };
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "dep-done" ? { ...dep, status: "running" } : id === "child" ? pending : undefined),
        listTasks: () => [dep, pending],
        getTaskCards: (id: string) => (id === "child" ? [staleLink] : []),
        listTaskCardsForCard: () => [],
        isCardAlive: () => true,
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        upsertTask: (task: TaskRow) => persistTask(task),
        onSpawnAgentRequest: (_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        },
      }),
    );

    await bus.handleRequest({ cmd: "update_task", taskId: "dep-done", status: "done" } as BusRequest);

    expect(spawnParams).toHaveLength(1);
    expect(spawnParams[0].taskId).toBe("child");
  });
});
