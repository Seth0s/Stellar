import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * Decisão 8 — review adversarial (2026-09-11): o store RECUSA e o
 * chamador tem que OBSERVAR `statusChanged` antes de disparar spawn/
 * retry. Também: update sem status não limpa divergência; aviso sem
 * requesterId não cai no card do implementador.
 */

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

function held(status: string, declared: string): StatusWriteDecision {
  return {
    status,
    statusChanged: false,
    divergedStatus: declared,
    divergedActor: "app",
    recordDeclaration: true,
    warnAgent: false,
    declaredStatus: declared,
  };
}

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: decisão 8 — side effects observam statusChanged", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("achado 1: onTaskDone NÃO dispara autonomousSpawn quando upsert pra running é hold", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-hold-dispatch-"));
    const spawnRequests: unknown[] = [];
    const dep: TaskRow = {
      id: "dep-done",
      prompt: "dep",
      provider: "claude",
      status: "running",
      card_id: null,
      board_id: "b1",
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
    };
    const pending: TaskRow = {
      ...dep,
      id: "held-pending",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
    };

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "dep-done" ? dep : undefined),
        listTasks: () => [dep, pending],
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        upsertTask: (task: TaskRow) => {
          if (task.id === "dep-done") return applied("done");
          // Human locked the dependent — store holds pending, refuses running.
          if (task.id === "held-pending") return held("pending", "running");
          return applied(task.status);
        },
        onSpawnAgentRequest: (requestId: string, ...rest: unknown[]) => {
          spawnRequests.push([requestId, ...rest]);
        },
      }),
    );

    await bus.handleRequest({ cmd: "update_task", taskId: "dep-done", status: "done" } as BusRequest);

    expect(spawnRequests).toHaveLength(0);
  });

  it("achado 2: markTaskFailed NÃO chama retry/spawn quando upsert de interrupção é hold", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-hold-retry-"));
    const spawnRequests: unknown[] = [];
    const running: TaskRow = {
      id: "t-locked",
      prompt: "x",
      provider: "claude",
      status: "running",
      card_id: "card-impl",
      board_id: "b1",
      result_json: null,
      deps_json: null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: 3,
      fallback_providers_json: null,
      order: null,
      suggested_order: null,
      implicit_order: null,
      diverged_status: null,
      diverged_actor: null,
      created_at: 1,
      updated_at: 1,
    };

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getReport: () => undefined,
        listTasks: () => [running],
        listTaskCardsForCard: () => [],
        listAllConnectors: () => [],
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        getCardBoardId: () => "b1",
        // Interrompida write held (human last_actor) — must not proceed to retryOrFail→spawn.
        // Falha tipada: saída sem report grava pending, não failed.
        upsertTask: (task: TaskRow) => (task.status !== "running" ? held("running", task.status) : applied(task.status)),
        onSpawnAgentRequest: (requestId: string, ...rest: unknown[]) => {
          spawnRequests.push([requestId, ...rest]);
        },
      }),
    );

    bus.resolveCardExit("card-impl", 1);
    // Give the sync path a tick — markTaskFailed is sync; spawn would be queued sync before .then.
    await Promise.resolve();

    expect(spawnRequests).toHaveLength(0);
  });

  it("achado 3: update_task sem status marca statusProposed:false no upsert", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-hold-nostatus-"));
    const upserted: TaskRow[] = [];
    const existing: TaskRow = {
      id: "t1",
      prompt: "x",
      provider: "claude",
      status: "running",
      card_id: "impl",
      board_id: "b1",
      result_json: null,
      deps_json: null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: null,
      fallback_providers_json: null,
      order: null,
      suggested_order: null,
      implicit_order: null,
      diverged_status: "failed",
      diverged_actor: "app",
      created_at: 1,
      updated_at: 1,
    };

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => existing,
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return {
            status: "running",
            statusChanged: false,
            divergedStatus: "failed",
            divergedActor: "app",
            recordDeclaration: false,
            warnAgent: false,
            declaredStatus: null,
          };
        },
      }),
    );

    await bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      result: { progress: 0.5 },
    } as BusRequest);

    expect(upserted).toHaveLength(1);
    expect(upserted[0].statusProposed).toBe(false);
  });

  it("achado 4: warnAgent sem requesterId NÃO digita no card_id do implementador", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-hold-warn-"));
    const writes: string[] = [];
    const existing: TaskRow = {
      id: "t1",
      prompt: "x",
      provider: "claude",
      status: "running",
      card_id: "impl-innocent",
      board_id: "b1",
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
    };

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => existing,
        listCards: () => [{ id: "impl-innocent", kind: "terminal", provider: "claude" }],
        isCardAlive: () => true,
        writeToCard: (id: string) => {
          writes.push(id);
        },
        writeToCardWithOrigin: (id: string) => {
          writes.push(id);
        },
        beginCardDelivery: () => ({ deliveryId: "d1", generation: 1 }),
        endCardDelivery: () => {},
        getCardWriteReadiness: () => ({
          hasReceivedData: true,
          lastActivityAtMs: Date.now(),
          spawnedAtMs: Date.now() - 10_000,
          hasPendingHumanInput: false,
          inputLineStartedAtMs: null,
        }),
        upsertTask: () => ({
          status: "running",
          statusChanged: false,
          divergedStatus: "done",
          divergedActor: "agent",
          recordDeclaration: true,
          warnAgent: true,
          declaredStatus: "done",
        }),
      }),
    );

    const res = (await bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "done",
      // no requesterId — external orchestrator / anonymous
    } as BusRequest)) as { ok: boolean; warning?: string };

    expect(res.ok).toBe(true);
    expect(res.warning).toBeTruthy(); // envelope still warns the caller
    // typeAndSubmit is async; a wrongly-targeted notify would write soon.
    await new Promise((r) => setTimeout(r, 80));
    expect(writes).toEqual([]);
  });
});
