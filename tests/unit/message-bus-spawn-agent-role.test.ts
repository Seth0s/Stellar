import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * `spawn_agent({ taskId, role })` — task_cards.role finally has a writer
 * (2026-09-13: 91/91 rows were the silent `implementer` default because
 * no tool could say otherwise). Same harness as
 * message-bus-spawn-agent-task-brief.test.ts. What this file fixes:
 *  - omitted / "implementer" → exactly the pre-existing link (`card_id`
 *    via upsertTask, brief = task prompt), `linkTaskCard` never called;
 *  - "reviewer" → `linkTaskCard(..., "reviewer")` ONLY, `card_id`
 *    untouched (a reviewer's {ok:false} report is a verdict, not the task
 *    failing), brief = the free `brief`, never the task prompt;
 *  - unknown role / role without taskId → REFUSED before any spawn.
 */
function applied(status: string): StatusWriteDecision {
  return { status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null };
}

function existingTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "2f1b7a1e-0f38-4f3e-9c2d-7a5b1e6d9c01",
    prompt: "implement the thing",
    provider: "claude",
    status: "running",
    card_id: "impl-card",
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
        if (prop === "getTask") return () => undefined;
        if (prop === "upsertTask") return (task: TaskRow) => applied(task.status);
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: spawn_agent role", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function dispatch(req: BusRequest, task: TaskRow | null = existingTask()) {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-role-"));
    const spawned: Array<Record<string, unknown>> = [];
    const upserted: TaskRow[] = [];
    const linked: Array<{ taskId: string; cardId: string; role: string }> = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        onSpawnAgentRequest: ((requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawned.push(params);
          bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "new-card" });
        }) as never,
        getTask: ((id: string) => (task && id === task.id ? task : undefined)) as never,
        upsertTask: ((t: TaskRow) => {
          upserted.push(t);
          return applied(t.status);
        }) as never,
        linkTaskCard: ((taskId: string, cardId: string, role: string) => {
          linked.push({ taskId, cardId, role });
        }) as never,
        listCards: (() => [{ id: "new-card", kind: "terminal", provider: "claude", cwd: "", label: null }]) as never,
      }),
    );
    const res = (await bus.handleRequest(req)) as { ok: boolean; cardId?: string; error?: string };
    return { res, spawned, upserted, linked };
  }

  it("role omitido: card_id + task_cards implementer via linkImplementerToTask", async () => {
    const task = existingTask();
    const { res, spawned, upserted, linked } = await dispatch({ cmd: "spawn_agent", provider: "claude", taskId: task.id, reason: "test", requesterId: "orch" } as BusRequest);
    expect(res).toEqual({ ok: true, cardId: "new-card" });
    expect(spawned[0].brief).toBe("implement the thing");
    expect(upserted).toHaveLength(1);
    expect(upserted[0].card_id).toBe("new-card");
    expect(linked).toEqual([{ taskId: task.id, cardId: "new-card", role: "implementer" }]);
  });

  it("role 'implementer' explícito é idêntico ao omitido", async () => {
    const task = existingTask();
    const { res, spawned, upserted, linked } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: task.id,
      role: "implementer",
      reason: "test", requesterId: "orch",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(spawned[0].brief).toBe("implement the thing");
    expect(upserted[0].card_id).toBe("new-card");
    expect(linked).toEqual([{ taskId: task.id, cardId: "new-card", role: "implementer" }]);
  });

  it("role 'reviewer' + brief: linkTaskCard reviewer, card_id intocado, brief é a ordem de revisão", async () => {
    const task = existingTask();
    const { res, spawned, upserted, linked } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: task.id,
      role: "reviewer",
      brief: "review the diff of this task; report a verdict",
      reason: "test", requesterId: "orch",
    } as BusRequest);
    expect(res).toEqual({ ok: true, cardId: "new-card" });
    expect(spawned[0].brief).toBe("review the diff of this task; report a verdict");
    // The spawned card still knows which task it serves (AGENT_CANVAS_TASK_ID).
    expect(spawned[0].taskId).toBe(task.id);
    expect(linked).toEqual([{ taskId: task.id, cardId: "new-card", role: "reviewer" }]);
    // The implementer stays the principal card — no upsertTask at all.
    expect(upserted).toEqual([]);
  });

  it("role 'reviewer' sem brief: card abre mudo e vinculado; o prompt da task NÃO vira brief", async () => {
    const task = existingTask();
    const { res, spawned, linked, upserted } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: task.id,
      role: "reviewer",
      reason: "test", requesterId: "orch",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(spawned[0].brief).toBeUndefined();
    expect(linked).toEqual([{ taskId: task.id, cardId: "new-card", role: "reviewer" }]);
    expect(upserted).toEqual([]);
  });

  it("role inválido: RECUSADO antes de spawnar — nada gravado, nenhum default inventado", async () => {
    const task = existingTask();
    const { res, spawned, upserted, linked } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: task.id,
      role: "banana",
      reason: "test", requesterId: "orch",
    } as BusRequest);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('got "banana"');
    expect(res.error).toContain('"implementer", "reviewer"');
    expect(spawned).toEqual([]);
    expect(upserted).toEqual([]);
    expect(linked).toEqual([]);
  });

  it("role sem taskId: RECUSADO — papel é de um card NUMA task", async () => {
    const { res, spawned } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      role: "reviewer",
      brief: "review something",
      reason: "test", requesterId: "orch",
    } as BusRequest);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("only applies together with taskId");
    expect(spawned).toEqual([]);
  });

  it("reviewer com taskId inexistente: recusa, não spawna", async () => {
    const { res, spawned, linked } = await dispatch(
      { cmd: "spawn_agent", provider: "claude", taskId: "nope", role: "reviewer", brief: "r", reason: "test", requesterId: "orch" } as BusRequest,
      null,
    );
    expect(res).toEqual({ ok: false, error: 'no such task "nope"' });
    expect(spawned).toEqual([]);
    expect(linked).toEqual([]);
  });
});
