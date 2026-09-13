import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

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

function existingTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "e8220ab7-5357-4701-8c83-3abff0e03486",
    prompt: "derive the brief from this prompt",
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

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === "listAllConnectors") return () => [];
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

describe("message-bus: spawn_agent taskId deriva o brief da task", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function sockPath(): string {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-task-brief-"));
    return join(dir, "agent-canvas.sock");
  }

  async function dispatch(req: BusRequest, overrides: Record<string, (...args: never[]) => unknown> = {}) {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    const spawned: Array<{ requestId: string; params: Record<string, unknown> }> = [];
    const upserted: TaskRow[] = [];
    const writes: string[] = [];
    const readySince = Date.now() - 1_000;
    let lastActivity = readySince;
    bus = createMessageBus(
      sockPath(),
      callbacksWithOverrides({
        onSpawnAgentRequest: ((requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawned.push({ requestId, params });
          bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "spawned-card" });
        }) as never,
        upsertTask: ((task: TaskRow) => {
          upserted.push(task);
          return applied(task.status);
        }) as never,
        writeToCard: ((_id: string, text: string) => {
          writes.push(text);
          lastActivity = Math.max(Date.now(), lastActivity + 1);
        }) as never,
        writeToCardWithOrigin: ((_id: string, text: string) => {
          writes.push(text);
          lastActivity = Math.max(Date.now(), lastActivity + 1);
        }) as never,
        beginCardDelivery: (() => true) as never,
        isCardAlive: (() => true) as never,
        getCardLastActivityAt: (() => lastActivity) as never,
        getCardWriteReadiness: (() => ({
          spawnedAtMs: readySince,
          hasReceivedData: true,
          lastActivityAtMs: readySince,
          hasPendingHumanInput: false,
          inputLineLastAtMs: null,
        })) as never,
        listCards: (() => [
          { id: "spawned-card", kind: "terminal", provider: spawned[0]?.params.provider ?? "bash", cwd: "", label: null },
        ]) as never,
        onReadCardRequest: ((requestId: string) => {
          bus?.resolveReadCard(requestId, { ok: true, text: "derive the brief from this prompt\nWorking" });
        }) as never,
        ...overrides,
      }),
    );
    const res = (await bus.handleRequest(req)) as { ok: boolean; cardId?: string; error?: string };
    return { res, spawned, upserted, writes };
  }

  it("a. taskId de task existente → brief entregue é o prompt dela", async () => {
    const task = existingTask();
    const { res, spawned } = await dispatch(
      { cmd: "spawn_agent", provider: "claude", taskId: task.id, requesterId: "orch" } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(res).toEqual({ ok: true, cardId: "spawned-card" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].params.brief).toBe("derive the brief from this prompt");
    expect(spawned[0].params.taskId).toBe(task.id);
  });

  it("b. sem taskId, brief livre → igual a hoje", async () => {
    const { res, spawned, upserted } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      brief: "explore the rail",
      requesterId: "orch",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(spawned[0].params.brief).toBe("explore the rail");
    expect(spawned[0].params.taskId).toBeUndefined();
    expect(upserted).toEqual([]);
  });

  it("c. sem taskId e sem brief → card abre normalmente", async () => {
    const { res, spawned, upserted } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      requesterId: "orch",
    } as BusRequest);
    expect(res.ok).toBe(true);
    expect(spawned[0].params.brief).toBeUndefined();
    expect(spawned[0].params.taskId).toBeUndefined();
    expect(upserted).toEqual([]);
  });

  it("d. taskId inexistente → recusa, não spawna", async () => {
    const { res, spawned } = await dispatch({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "does-not-exist",
      requesterId: "orch",
    } as BusRequest);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no such task "does-not-exist"');
    expect(spawned).toEqual([]);
  });

  it("e. taskId + brief juntos → recusa, não spawna", async () => {
    const task = existingTask();
    const { res, spawned } = await dispatch(
      {
        cmd: "spawn_agent",
        provider: "claude",
        taskId: task.id,
        brief: "and also this addendum",
        requesterId: "orch",
      } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("pass taskId or brief, not both");
    expect(spawned).toEqual([]);
  });

  it("f. brief derivado passa pela mesma bifurcação argv/digitar", async () => {
    const task = existingTask();
    const claude = await dispatch(
      { cmd: "spawn_agent", provider: "claude", taskId: task.id, requesterId: "orch" } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(claude.spawned[0].params.brief).toBe(task.prompt);
    expect(claude.writes).toEqual([]);

    const cursor = await dispatch(
      { cmd: "spawn_agent", provider: "cursor", taskId: task.id, requesterId: "orch" } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(cursor.spawned[0].params.brief).toBe(task.prompt);
    expect(cursor.writes).toEqual([]);

    const antigravity = await dispatch(
      { cmd: "spawn_agent", provider: "antigravity", taskId: task.id, requesterId: "orch" } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(antigravity.spawned[0].params.brief).toBe(task.prompt);
    expect(antigravity.writes).toEqual([]);

    const bash = await dispatch(
      { cmd: "spawn_agent", provider: "bash", taskId: task.id, requesterId: "orch" } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(bash.spawned[0].params.brief).toBeUndefined();
    await vi.waitFor(() => {
      expect(bash.writes[0]).toBe(task.prompt);
    });
  });

  it("spawn com taskId amarra o card_id sem propor status", async () => {
    const task = existingTask();
    const { upserted } = await dispatch(
      { cmd: "spawn_agent", provider: "claude", taskId: task.id, requesterId: "orch" } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0].card_id).toBe("spawned-card");
    expect(upserted[0].status).toBe("pending");
    expect(upserted[0].statusProposed).toBe(false);
    expect(upserted[0].actor).toBe("app");
  });

  it("task com prompt vazio: card abre, brief ausente, card ainda é amarrado", async () => {
    const task = existingTask({ prompt: null });
    const { res, spawned, upserted } = await dispatch(
      { cmd: "spawn_agent", provider: "claude", taskId: task.id, requesterId: "orch" } as BusRequest,
      { getTask: ((id: string) => (id === task.id ? task : undefined)) as never },
    );
    expect(res.ok).toBe(true);
    expect(spawned[0].params.brief).toBeUndefined();
    expect(upserted[0].card_id).toBe("spawned-card");
  });
});
