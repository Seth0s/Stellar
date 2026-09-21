import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import { INSTANT_EXIT_LIFETIME_MS } from "../../src/main/exit-lifetime-decision";
import { failureKindFromResultJson } from "../../src/main/failure-kind-decision";
import { describeRetryableFailureRefusal } from "../../src/main/report-retry-decision";

/**
 * Gate: retry-sem-freio — real store. Instant death must not multiply
 * cards; legitimate in-line report retry still consumes attempts.
 */

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id: "child",
    prompt: "do the work",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: "/tmp/repo",
    result_json: null,
    deps_json: JSON.stringify(["parent"]),
    retry_count: 0,
    attempted_providers_json: JSON.stringify(["claude"]),
    max_retries: 2,
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

function buildRig(dir: string) {
  const store = openStore(dir);
  const spawnRequests: Array<{ requestId: string; cardId: string }> = [];
  const alive = new Set<string>();
  let bus: ReturnType<typeof createMessageBus> | null = null;
  const funnel = createTaskWriteFunnel({
    upsertTask: (task) => store.upsertTask(task),
    applyColumnDrop: (dragged, siblings) => store.applyColumnDrop(dragged, siblings),
    afterWrite: () => {},
    onTaskDone: (taskId) => bus?.onTaskDone(taskId),
  });
  const callbacks = new Proxy(
    {
      listTasks: () => store.listTasks(),
      getTask: (id: string) => store.getTask(id),
      upsertTask: (task: TaskRow) => funnel.persistTask(task),
      getTaskCards: (taskId: string) => store.getTaskCards(taskId),
      listTaskCardsForCard: (cardId: string) => store.listTaskCardsForCard(cardId),
      linkTaskCard: (taskId: string, cardId: string, role: string) => store.linkTaskCard(taskId, cardId, role),
      boardExists: () => true,
      getCardBoardId: () => "b1",
      isBoardAutonomous: () => true,
      getBoardCwd: () => "/tmp", // raiz declarada do rig: sem ela o auto-dispatch RECUSA (2026-09-21)
      isCardAlive: (id: string) => alive.has(id),
      countRunningAgentsOnBoard: () => alive.size,
      getBoardConcurrencyCap: () => 4,
      listCards: () => [...alive].map((id) => ({ id, kind: "terminal" })),
      listAllConnectors: () => [],
      getReport: () => undefined,
      onSpawnAgentRequest: (requestId: string, _requesterId: string, _params: unknown) => {
        const cardId = `worker-${spawnRequests.length + 1}`;
        spawnRequests.push({ requestId, cardId });
        alive.add(cardId);
        queueMicrotask(() => bus?.resolveSpawnAgent(requestId, { ok: true, cardId }));
      },
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
  bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { store, bus, spawnRequests, alive };
}

describe("message-bus: exit lifetime floor (store real)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    vi.useRealTimers();
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function seedAndDispatch(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "stellar-exit-life-"));
    rig = buildRig(dir);
    const now = Date.now();
    rig.store.upsertTask(
      baseTask({
        id: "parent",
        status: "pending",
        deps_json: null,
        prompt: "parent",
        created_at: now,
        updated_at: now,
        actor: "agent",
      }),
    );
    rig.store.upsertTask(baseTask({ id: "child", status: "pending", actor: "agent" }));
    await rig.bus.handleRequest({
      cmd: "update_task",
      taskId: "parent",
      status: "done",
      requesterId: "orchestrator",
    } as BusRequest);
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.spawnRequests).toHaveLength(1);
    const cardId = rig.spawnRequests[0]!.cardId;
    expect(rig.store.getTask("child")!.card_id).toBe(cardId);
    return cardId;
  }

  it("instant death → failed with launch diagnosis; no second spawn (not 3 cards in 40s)", async () => {
    const cardId = await seedAndDispatch();
    rig!.alive.delete(cardId);
    rig!.bus.resolveCardExit(cardId, 129);

    const row = rig!.store.getTask("child")!;
    expect(row.status).toBe("failed");
    expect(failureKindFromResultJson(row.result_json)).toBe("julgada");
    expect(row.result_json).toContain("launch diagnosis");
    expect(row.result_json).toContain("without ever calling report");

    // Re-fire the deps engine the way a second parent completion would —
    // failed judgment must not multiply cards (the old maxRetries burn).
    for (let i = 0; i < 3; i++) {
      rig!.bus.onTaskDone("parent");
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(rig!.spawnRequests).toHaveLength(1);
  });

  it("card that lived past the floor → interrompida pending, still no spawn (2023a74)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T15:49:51-03:00"));
    const cardId = await seedAndDispatch();
    vi.setSystemTime(new Date(Date.now() + INSTANT_EXIT_LIFETIME_MS + 1_000));
    rig!.alive.delete(cardId);
    rig!.bus.resolveCardExit(cardId, 129);

    const row = rig!.store.getTask("child")!;
    expect(row.status).toBe("pending");
    expect(failureKindFromResultJson(row.result_json)).toBe("interrompida");
    expect(row.result_json).not.toContain("launch diagnosis");
    expect(rig!.spawnRequests).toHaveLength(1);
  });

  it("legitimate declared failure still consumes in-line retry (regression)", async () => {
    // Real-store rows coerce `running`→`pending` (CAMADA 3); the report
    // acceptance path still keys the budget off the stored column (sibling
    // territory). Pin the regression the same way message-bus-report-inline-retry
    // does: an in-memory row that still carries status "running".
    dir = mkdtempSync(join(tmpdir(), "stellar-exit-inline-"));
    const live = baseTask({
      id: "solo",
      status: "running",
      card_id: "worker-1",
      deps_json: null,
      retry_count: 0,
      max_retries: 2,
    });
    const spawnRequests: unknown[] = [];
    const bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {
          listTasks: () => [live],
          getTask: () => live,
          upsertTask: (row: TaskRow) => {
            Object.assign(live, row);
            return {
              status: row.status,
              statusChanged: true,
              divergedStatus: null,
              divergedActor: null,
              recordDeclaration: false,
              warnAgent: false,
              declaredStatus: null,
            };
          },
          isCardAlive: (id: string) => id === "worker-1",
          listTaskCardsForCard: () => [],
          listAllConnectors: () => [],
          getReport: () => undefined,
          onSpawnAgentRequest: (...args: unknown[]) => spawnRequests.push(args),
        } as Record<string, unknown>,
        { get: (t, p: string) => t[p] ?? (() => undefined) },
      ) as Parameters<typeof createMessageBus>[1],
    );
    rig = { store: null as never, bus, spawnRequests: [], alive: new Set(["worker-1"]) };

    const res = (await bus.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: false, error: "tests failed" },
    } as BusRequest)) as { ok: boolean; retryCount?: number; retriesRemaining?: number; error?: string };

    expect(res.ok).toBe(false);
    expect(res.retryCount).toBe(1);
    expect(res.retriesRemaining).toBe(1);
    expect(res.error).toBe(describeRetryableFailureRefusal(1));
    expect(live.retry_count).toBe(1);
    expect(spawnRequests).toHaveLength(0);
  });
});
