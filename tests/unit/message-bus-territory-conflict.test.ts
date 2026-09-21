import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskCardRow, TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";

/**
 * Sticky de consolidação (2026-09-20, itens 6+10) — mecanismo (b):
 * `spawn_agent` e auto-dispatch recusam quando o território da task
 * colide com o de outra task ATIVA (implementador vivo) no MESMO board.
 * Medido no board real desta sessão: três tasks ATIVAS simultâneas com
 * território sobreposto (`vhosts/Backend/app/**` declarado em duas,
 * `vhosts/Admin/src/**` numa terceira) — nada recusava antes disto.
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
    prompt: "task",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    territory_json: null,
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

describe("spawn_agent recusa por conflito de território (mecanismo b)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("recusa quando o território da task colide com o de outra task ATIVA do mesmo board", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-territory-spawn-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const candidate = baseTask({ id: "candidate", territory_json: JSON.stringify(["vhosts/Backend/app/**"]) });
    const activeSibling = baseTask({
      id: "active-sibling",
      card_id: "777",
      territory_json: JSON.stringify(["vhosts/Backend/app/**", "vhosts/Backend/tests/**"]),
    });

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "candidate" ? candidate : id === "active-sibling" ? activeSibling : undefined),
        listTasks: () => [candidate, activeSibling],
        isCardAlive: (id: string) => id === "777",
        getTaskCards: () => [],
        listTaskCardsForCard: () => [],
        onSpawnAgentRequest: (_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        },
      }),
    );

    const res = (await bus.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "candidate",
      reason: "test",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toContain("active-sibling");
    expect(res.error).toContain("ACTIVE");
    expect(spawnParams).toHaveLength(0);
  });

  it("permite quando as territories não se sobrepõem", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-territory-spawn-ok-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const candidate = baseTask({ id: "candidate", territory_json: JSON.stringify(["vhosts/Admin/src/**"]) });
    const activeSibling = baseTask({
      id: "active-sibling",
      card_id: "777",
      territory_json: JSON.stringify(["vhosts/Backend/app/**"]),
    });

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "candidate" ? candidate : id === "active-sibling" ? activeSibling : undefined),
        listTasks: () => [candidate, activeSibling],
        isCardAlive: (id: string) => id === "777" || id === "spawned-card",
        getTaskCards: () => [],
        listTaskCardsForCard: () => [],
        listCards: () => [{ id: "spawned-card", kind: "terminal", provider: "claude", cwd: "", label: null }],
        onSpawnAgentRequest: (requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
          bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "spawned-card" });
        },
      }),
    );

    const res = (await bus.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "candidate",
      reason: "test",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(true);
    expect(spawnParams).toHaveLength(1);
  });

  it("reviewer não é bloqueado por território — revisão lê, não escreve", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-territory-spawn-reviewer-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const candidate = baseTask({ id: "candidate", territory_json: JSON.stringify(["vhosts/Backend/app/**"]) });
    const activeSibling = baseTask({
      id: "active-sibling",
      card_id: "777",
      territory_json: JSON.stringify(["vhosts/Backend/app/**"]),
    });

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "candidate" ? candidate : id === "active-sibling" ? activeSibling : undefined),
        listTasks: () => [candidate, activeSibling],
        isCardAlive: (id: string) => id === "777" || id === "spawned-card",
        getTaskCards: () => [],
        listTaskCardsForCard: () => [],
        listCards: () => [{ id: "spawned-card", kind: "terminal", provider: "claude", cwd: "", label: null }],
        onSpawnAgentRequest: (requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
          bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "spawned-card" });
        },
      }),
    );

    const res = (await bus.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "candidate",
      role: "reviewer",
      reason: "test",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(true);
    expect(spawnParams).toHaveLength(1);
  });
});

describe("auto-dispatch recusa por conflito de território (mecanismo b)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("dep terminando NÃO despacha o dependente quando o território colide com uma task ATIVA irmã", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-territory-auto-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1" });
    const child = baseTask({
      id: "child",
      deps_json: JSON.stringify(["dep-done"]),
      territory_json: JSON.stringify(["vhosts/Backend/app/**"]),
    });
    const activeSibling = baseTask({
      id: "active-sibling",
      card_id: "777",
      territory_json: JSON.stringify(["vhosts/Backend/app/**", "vhosts/Backend/tests/**"]),
    });
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) =>
          id === "dep-done" ? { ...dep, status: "running" } : id === "child" ? child : id === "active-sibling" ? activeSibling : undefined,
        listTasks: () => [dep, child, activeSibling],
        isCardAlive: (id: string) => id === "777",
        getTaskCards: () => [],
        listTaskCardsForCard: () => [],
        isBoardAutonomous: () => true,
        getBoardCwd: () => "/tmp", // raiz declarada do rig: sem ela o auto-dispatch RECUSA (2026-09-21)
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
    expect(child.card_id).toBeNull();
  });

  it("dep terminando despacha normalmente quando não há colisão de território", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-territory-auto-ok-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1" });
    const child = baseTask({
      id: "child",
      deps_json: JSON.stringify(["dep-done"]),
      territory_json: JSON.stringify(["vhosts/Admin/src/**"]),
    });
    const activeSibling = baseTask({
      id: "active-sibling",
      card_id: "777",
      territory_json: JSON.stringify(["vhosts/Backend/app/**"]),
    });
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) =>
          id === "dep-done" ? { ...dep, status: "running" } : id === "child" ? child : id === "active-sibling" ? activeSibling : undefined,
        listTasks: () => [dep, child, activeSibling],
        isCardAlive: (id: string) => id === "777",
        getTaskCards: () => [],
        listTaskCardsForCard: () => [],
        isBoardAutonomous: () => true,
        getBoardCwd: () => "/tmp", // raiz declarada do rig: sem ela o auto-dispatch RECUSA (2026-09-21)
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
