import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import { PROVIDER_UNDECLARED_REASON } from "../../src/main/task-dispatch-decision";
import { interruptionReasonFromResultJson } from "../../src/main/failure-kind-decision";

/**
 * Auto-dispatch: no `?? "claude"`, cwd inherits from deps, refusal stamps
 * result_json WITHOUT writing status (CAMADA 3).
 */

function funnelled(decide: (task: TaskRow) => StatusWriteDecision, getBus: () => ReturnType<typeof createMessageBus> | null) {
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

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
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

describe("message-bus: auto-dispatch passa cwd + label da task", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("onTaskDone despacha com cwd da task e label do prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-cwd-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", cwd: "/tmp/other" });
    const pending = baseTask({
      id: "ceaabaac-xxxx",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
      cwd: "/home/lucas/Workplace/Projects/Stellar",
      prompt: "i18n fase 2",
    });
    const depBefore = { ...dep, status: "running" };
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "dep-done" ? depBefore : id === "ceaabaac-xxxx" ? pending : undefined),
        listTasks: () => [dep, pending],
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
    expect(spawnParams[0].cwd).toBe("/home/lucas/Workplace/Projects/Stellar");
    expect(spawnParams[0].label).toBe("i18n fase 2");
    expect(spawnParams[0].provider).toBe("claude");
    expect((spawnParams[0].brief as string).startsWith("i18n fase 2\n\n---\n[stellar:deps]")).toBe(true);
    expect(spawnParams[0].taskId).toBe("ceaabaac-xxxx");
  });

  it("onTaskDone herda cwd do pai quando a filha não declara", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-inherit-cwd-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const rows = new Map<string, TaskRow>();
    const dep = baseTask({
      id: "dep-done",
      status: "done",
      prompt: "fase 1",
      cwd: "/home/lucas/Workplace/Projects/Stellar",
      provider: "cursor",
    });
    const pending = baseTask({
      id: "child-no-cwd",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
      cwd: null,
      provider: "cursor",
      prompt: "fase 2",
    });
    rows.set(dep.id, { ...dep, status: "running" });
    rows.set(pending.id, pending);
    const persistTask = funnelled((task) => {
      rows.set(task.id, task);
      return applied(task.status);
    }, () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => rows.get(id),
        listTasks: () => [dep, pending],
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
    expect(spawnParams[0].cwd).toBe("/home/lucas/Workplace/Projects/Stellar");
    expect(spawnParams[0].provider).toBe("cursor");
  });

  it("onTaskDone com task sem cwd e pai sem cwd passa undefined (fallback do board no renderer)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-nocwd-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1" });
    const pending = baseTask({
      id: "no-cwd-task",
      status: "pending",
      deps_json: JSON.stringify(["dep-done"]),
      cwd: null,
      prompt: null,
    });
    const depBefore = { ...dep, status: "running" };
    const persistTask = funnelled((task) => applied(task.status), () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === "dep-done" ? depBefore : id === "no-cwd-task" ? pending : undefined),
        listTasks: () => [dep, pending],
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
    expect(spawnParams[0].cwd).toBeUndefined();
    expect(spawnParams[0].label).toBe("task no-cwd-t");
    expect((spawnParams[0].brief as string).startsWith("[stellar:deps]")).toBe(true);
    expect(spawnParams[0].taskId).toBe("no-cwd-task");
  });

  it("sem provider: NÃO despacha, fica pending, grava motivo sem propor status", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-refuse-provider-"));
    const spawnParams: Array<Record<string, unknown>> = [];
    const upserts: TaskRow[] = [];
    const rows = new Map<string, TaskRow>();
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", cwd: "/tmp/repo" });
    const pending = baseTask({
      id: "no-provider",
      status: "pending",
      provider: null,
      deps_json: JSON.stringify(["dep-done"]),
      cwd: null,
      prompt: "filho sem provider",
    });
    rows.set(dep.id, { ...dep, status: "running" });
    rows.set(pending.id, pending);
    const persistTask = funnelled((task) => {
      upserts.push(task);
      rows.set(task.id, task);
      return applied(task.status);
    }, () => bus);

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => rows.get(id),
        listTasks: () => [dep, rows.get("no-provider")!],
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
    const refusal = upserts.find((t) => t.id === "no-provider" && t.result_json);
    expect(refusal).toBeDefined();
    expect(refusal!.statusProposed).toBe(false);
    expect(interruptionReasonFromResultJson(refusal!.result_json)).toBe(PROVIDER_UNDECLARED_REASON);
    expect(rows.get("no-provider")!.status).toBe("pending");
  });

  it("create_task grava cwd explícito; omitido vira null", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-create-cwd-"));
    const upserted: TaskRow[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        boardExists: () => true,
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return applied(task.status);
        },
      }),
    );

    await bus.handleRequest({
      cmd: "create_task",
      boardId: "b1",
      prompt: "x",
      cwd: "/tmp/repo",
    } as BusRequest);
    await bus.handleRequest({ cmd: "create_task", boardId: "b1", prompt: "y" } as BusRequest);

    expect(upserted[0].cwd).toBe("/tmp/repo");
    expect(upserted[1].cwd).toBeNull();
  });
});
