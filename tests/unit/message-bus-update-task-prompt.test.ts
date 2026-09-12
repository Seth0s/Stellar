import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";
import { TASK_PROMPT_ADDITION_MARKER } from "../../src/task-prompt-decision";

function heldStatus(status: string): StatusWriteDecision {
  return {
    status,
    statusChanged: false,
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

function existingTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    prompt: "why this task exists",
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

describe("message-bus: update_task writes prompt without touching a live card", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("default is append: original stays, addition is marked, statusProposed stays false", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-upd-prompt-"));
    const upserted: TaskRow[] = [];
    const writes: string[] = [];
    const spawns: unknown[] = [];

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => existingTask(),
        listCards: () => [{ id: "impl-card", kind: "terminal", provider: "claude", cwd: "/tmp", label: null }],
        writeToCard: (id: string, text: string) => {
          writes.push(`${id}:${text}`);
        },
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return heldStatus(task.status);
        },
        onSpawnAgentRequest: (...args: unknown[]) => {
          spawns.push(args);
        },
      }),
    );

    const res = await bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      prompt: "also check the modal",
      requesterId: "orchestrator",
    } as BusRequest);

    expect(res.ok).toBe(true);
    expect(res.prompt).toContain("why this task exists");
    expect(String(res.prompt)).toContain(TASK_PROMPT_ADDITION_MARKER);
    expect(String(res.prompt)).toContain("also check the modal");
    expect(upserted).toHaveLength(1);
    expect(upserted[0].statusProposed).toBe(false);
    expect(upserted[0].status).toBe("running");
    expect(upserted[0].prompt).toBe(res.prompt);
    expect(writes).toEqual([]);
    expect(spawns).toEqual([]);
  });

  it("replace requires explicit promptMode — omitted mode never overwrites", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-upd-prompt-"));
    const upserted: TaskRow[] = [];

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => existingTask(),
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return heldStatus(task.status);
        },
      }),
    );

    const replaced = await bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      prompt: "rewritten",
      promptMode: "replace",
    } as BusRequest);
    expect(replaced).toEqual({ ok: true, prompt: "rewritten" });
    expect(upserted[0].prompt).toBe("rewritten");

    const badMode = await bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      prompt: "x",
      promptMode: "overwrite",
    } as BusRequest);
    expect(badMode.ok).toBe(false);
    expect(String(badMode.error)).toContain("promptMode");
  });

  it("omitting prompt leaves the stored briefing untouched", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-upd-prompt-"));
    const upserted: TaskRow[] = [];

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => existingTask(),
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return heldStatus(task.status);
        },
      }),
    );

    const res = await bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      suggestedOrder: 3,
    } as BusRequest);

    expect(res).toEqual({ ok: true });
    expect(upserted[0].prompt).toBe("why this task exists");
    expect(upserted[0].suggested_order).toBe(3);
  });

  it("empty prompt is refused — does not upsert or write a card", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-upd-prompt-"));
    const upserted: TaskRow[] = [];
    const writes: string[] = [];

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => existingTask(),
        writeToCard: (id: string, text: string) => {
          writes.push(`${id}:${text}`);
        },
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return heldStatus(task.status);
        },
      }),
    );

    const res = await bus.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      prompt: "   ",
    } as BusRequest);

    expect(res).toEqual({ ok: false, error: "empty prompt" });
    expect(upserted).toEqual([]);
    expect(writes).toEqual([]);
  });
});
