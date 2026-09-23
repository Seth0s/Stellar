import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

function humanLocked(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t-locked",
    prompt: "faz X",
    provider: "cursor",
    status: "pending",
    card_id: null,
    board_id: "64",
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
    diverged_status: "done",
    diverged_actor: "agent",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("message-bus: request_task_status (terceiro caminho)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("estaciona e devolve na hora — não muda status, não limpa divergência, board autônomo não aplica", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-bus-"));
    const asks: unknown[] = [];
    const task = humanLocked();
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => task,
        getCardBoardId: () => "64",
        isBoardAutonomous: () => true,
        setStatusAsk: (taskId: string, ask: unknown) => {
          asks.push({ taskId, ask });
          return { ok: true };
        },
      }),
    );

    const started = Date.now();
    const res = await bus.handleRequest({
      cmd: "request_task_status",
      taskId: "t-locked",
      status: "done",
      reason: "protótipo aceito",
      requesterId: "416",
    } as BusRequest);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(200);
    expect(res).toMatchObject({
      ok: true,
      pending: true,
      already: false,
      status: "pending",
      requestedStatus: "done",
      divergedStatus: "done",
    });
    expect(String(res.message)).toContain("recorded");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      taskId: "t-locked",
      ask: { status: "done", reason: "protótipo aceito", requesterId: "416" },
    });
  });

  it("já alinhado: devolve already, sem gravar pedido", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-bus-"));
    const asks: unknown[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => humanLocked({ status: "done", diverged_status: null, diverged_actor: null }),
        setStatusAsk: (...args: unknown[]) => {
          asks.push(args);
          return { ok: true };
        },
      }),
    );

    const res = await bus.handleRequest({
      cmd: "request_task_status",
      taskId: "t-locked",
      status: "done",
    } as BusRequest);
    expect(res).toMatchObject({ ok: true, pending: false, already: true, status: "done" });
    expect(asks).toHaveLength(0);
  });

  it("update_task direto de outsider sob hold humano continua aceito com aviso — pedido é caminho do implementer", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-bus-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => humanLocked({ diverged_status: null, diverged_actor: null }),
        getTaskCards: () => [],
        upsertTask: () => ({
          status: "pending",
          statusChanged: false,
          divergedStatus: "done",
          divergedActor: "agent",
          recordDeclaration: true,
          warnAgent: true,
          declaredStatus: "done",
        }),
      }),
    );

    const res = await bus.handleRequest({ cmd: "update_task", taskId: "t-locked", status: "done", requesterId: "orch" } as BusRequest);
    expect(res.ok).toBe(true);
    expect(String(res.warning)).toContain("prevails");
    expect(String(res.warning)).toContain("request_task_status");
  });

  it("update_task que aplica o status pedido encerra o pedido e diz isso", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-bus-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () =>
          humanLocked({
            requested_status: "running",
            requested_reason: "feito",
            requested_by: "416",
            requested_at: 2,
            diverged_status: null,
            diverged_actor: null,
          }),
        upsertTask: () => ({
          status: "running",
          statusChanged: true,
          divergedStatus: null,
          divergedActor: null,
          recordDeclaration: false,
          warnAgent: false,
          declaredStatus: null,
        }),
      }),
    );

    const res = await bus.handleRequest({ cmd: "update_task", taskId: "t-locked", status: "running" } as BusRequest);
    expect(res).toMatchObject({ ok: true, status: "running" });
    expect(String(res.message)).toContain("closed");
    expect(String(res.message)).toContain("running");
  });
});
