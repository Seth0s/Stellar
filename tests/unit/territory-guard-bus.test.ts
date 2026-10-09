import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * The TERRITORY GUARD on the doors the orchestrator used to bypass. Measured:
 * linking a task by `update_task(cardId)` (open a card with a free brief) never
 * passed the guard that `spawn_agent(taskId)` enforced — the same overlap was
 * refused at one door and accepted at another, with no trail. The guard now
 * runs at both, and an orchestrator override is recorded on the task's trail.
 */

const BASE = "/repo";

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

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    prompt: "work",
    provider: "commandcode",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: BASE,
    spawn_profile: null,
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

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    { get: (_target, prop: string) => overrides[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("territory guard — update_task(cardId) and link_task_card", () => {
  let dir: string | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** t2 is ACTIVE (a live implementer) and holds the same path as t1. */
  function makeBus(tasks: TaskRow[]) {
    dir = mkdtempSync(join(tmpdir(), "stellar-territory-guard-"));
    const upserts: TaskRow[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => tasks.find((t) => t.id === id),
        listTasks: () => tasks,
        listLiveImplementersForTask: ((id: string) =>
          id === "t2"
            ? [{ task_id: "t2", card_id: "card-t2", role: "implementer", reservation_state: null }]
            : []) as never,
        isCardAlive: () => true,
        upsertTask: (t: TaskRow) => {
          upserts.push(t);
          return applied(t.status);
        },
        getBoardOrchestratorCardId: (() => "orch") as never,
        listCards: () => [
          { id: "orch", kind: "terminal", provider: "claude", cwd: BASE, label: "orch", displayName: "orch" },
          { id: "rev", kind: "terminal", provider: "claude", cwd: BASE, label: "rev", displayName: "rev" },
        ],
        listTaskCardsForCard: () => [],
        listAllConnectors: () => [],
        linkTaskCard: () => undefined,
        describeCardLabel: (id: string) => id,
        writeToCard: () => undefined,
        beginCardDelivery: () => true,
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        getCardWriteReadiness: () => ({
          spawnedAtMs: Date.now() - 1_000,
          hasReceivedData: true,
          lastActivityAtMs: Date.now() - 1_000,
          hasPendingHumanInput: false,
          inputLineLastAtMs: null,
        }),
        getCardLastActivityAt: () => Date.now(),
      }),
    );
    return { upserts };
  }

  const overlapping = () => [
    task({ id: "t1", territory_json: JSON.stringify(["src/main/index.ts"]) }),
    task({ id: "t2", status: "running", territory_json: JSON.stringify(["src/main/index.ts"]) }),
  ];

  it("update_task(cardId) is REFUSED when the territory collides (the old bypass)", async () => {
    const { upserts } = makeBus(overlapping());
    const res = (await bus!.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      requesterId: "orch",
      cardId: "rev",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("t2");
    expect(res.error).toContain("ACTIVE");
    expect(upserts).toHaveLength(0); // nothing written
  });

  it("update_task(cardId) with overrideTerritory passes AND records the override", async () => {
    const { upserts } = makeBus(overlapping());
    const res = (await bus!.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      requesterId: "orch",
      cardId: "rev",
      overrideTerritory: "os dois cards precisam do arquivo; coordenei o merge",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    const trail = upserts.find((t) => t.result_json?.includes("territoryOverride"));
    expect(trail).toBeDefined();
    expect(trail!.result_json).toContain("coordenei o merge");
  });

  it("update_task that does NOT attach a card is never guarded", async () => {
    const { upserts } = makeBus(overlapping());
    const res = (await bus!.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      requesterId: "orch",
      prompt: "apenas um ajuste de texto",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it("link_task_card(implementer, deliver) is REFUSED on the same collision", async () => {
    makeBus(overlapping());
    const res = (await bus!.handleRequest({
      cmd: "link_task_card",
      taskId: "t1",
      requesterId: "orch",
      cardId: "rev",
      mode: "deliver",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("t2");
  });

  it("link_task_card with overrideTerritory passes and records it", async () => {
    const { upserts } = makeBus(overlapping());
    const res = (await bus!.handleRequest({
      cmd: "link_task_card",
      taskId: "t1",
      requesterId: "orch",
      cardId: "rev",
      mode: "deliver",
      overrideTerritory: "coordenado com o card da t2",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(upserts.some((t) => t.result_json?.includes("territoryOverride"))).toBe(true);
  });
});
