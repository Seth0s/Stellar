import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";

/**
 * The reservation engine ran on `onTaskDone` only. A dependency that closed
 * while the card was mid-turn left the engine seeing a busy card, and nothing
 * re-evaluated the reservation once the turn ended — it sat ready on an idle
 * card. `workGrantedAt` is set at spawn, so "never received work" is not a
 * reachable state.
 *
 * Fixes under test: the end of turn is an engine trigger (and the 60 s scan
 * delivers too); `link_task_card mode:"deliver"` over a reservation promotes
 * it; a ready reservation that does not leave warns the orchestrator once.
 *
 * The tests drive the real path: `update_task` closing the dependency and the
 * card's `turn_complete`, with the registry turn facts.
 */

function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: `task ${id}`,
    provider: "commandcode",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
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
    ...over,
  } as unknown as TaskRow;
}

function applied(status: string): StatusWriteDecision {
  return { status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null };
}

describe("gaveta de reservas — o caminho real (defeito 2026-10-05)", () => {
  let ctx: { bus: ReturnType<typeof createMessageBus>; dir: string } | null = null;

  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  function rig(overrides: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "stellar-res-realpath-"));
    const writes: Array<{ target: string; text: string }> = [];
    const callbacks = new Proxy(
      {
        listCards: () => [
          { id: "cardA", kind: "terminal", provider: "commandcode", cwd: "", label: null, displayName: "A" },
        ],
        describeCardLabel: (id: string) => id,
        writeToCard: (id: string, text: string) => writes.push({ target: id, text }),
        writeToCardWithOrigin: (id: string, text: string) => writes.push({ target: id, text }),
        beginCardDelivery: () => true,
        endCardDelivery: () => undefined,
        isCardAlive: () => true,
        getCardWriteReadiness: () => ({
          spawnedAtMs: Date.now() - 5_000,
          hasReceivedData: true,
          lastActivityAtMs: Date.now() - 5_000,
          hasPendingHumanInput: false,
          inputLineLastAtMs: null,
        }),
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "→ ok\n Working" }),
        getBoardOrchestratorCardId: () => null,
        listAllConnectors: () => [],
        recordSpawn: () => ({ id: "s" }),
        findSpawnByChild: () => undefined,
        listSpawnsByParent: () => [],
        ...overrides,
      },
      { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) },
    ) as Parameters<typeof createMessageBus>[1];
    const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { bus, dir, writes };
  }

  it("dep fecha ENQUANTO o card está no meio de um turno; o fim de turno ('Worked for') entrega", async () => {
    const activated: Array<[string, string]> = [];
    const linked: Array<[string, string]> = [];
    const tasks = new Map<string, TaskRow>([
      ["dep", baseTask("dep", { status: "running" })],
      ["t2", baseTask("t2", { deps_json: JSON.stringify(["dep"]) })],
    ]);
    // The card already ended a turn (at 500) and received work after it (1000),
    // so it is mid-turn. `workGrantedAt` is not null: it is set at spawn.
    let turnEndedAt: number | null = 500;
    const workGrantedAt = 1_000;
    let bus: ReturnType<typeof createMessageBus> | null = null;
    const persistTask = createTaskWriteFunnel({
      upsertTask: (t) => {
        tasks.set(t.id, t);
        return applied(t.id === "dep" ? "done" : t.status);
      },
      applyColumnDrop: (dragged) => applied(dragged.status),
      afterWrite: () => {},
      onTaskDone: (id) => bus?.onTaskDone(id),
    }).persistTask;

    const made = rig({
      getTask: (id: string) => tasks.get(id),
      listTasks: () => [...tasks.values()],
      upsertTask: (t: TaskRow) => persistTask(t),
      listReservationsForCard: (cardId: string) =>
        cardId === "cardA" ? [{ task_id: "t2", role: "implementer", reserved_order: 0, linked_at: 1 }] : [],
      activateReservedTaskCard: (taskId: string, cardId: string) => {
        activated.push([taskId, cardId]);
        return 1;
      },
      linkTaskCard: (taskId: string, cardId: string) => linked.push([taskId, cardId]),
      listTaskCardsForCard: () => [],
      getCardTurnEndedAt: () => turnEndedAt,
      getCardLastWorkGrantedAt: () => workGrantedAt,
      markCardTurnComplete: () => {
        turnEndedAt = Date.now();
      },
    });
    bus = made.bus;
    ctx = made;

    // 1) The dependency closes while the card is mid-turn: the engine runs,
    //    reads the card as busy and does not deliver.
    const res = (await bus.handleRequest({ cmd: "update_task", taskId: "dep", status: "done" } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(activated).toEqual([]);

    // 2) "Worked for …" appears: the card declares the end of turn. The engine
    //    re-evaluates and the reservation leaves.
    await bus.handleRequest({ cmd: "turn_complete", cardId: "cardA" } as BusRequest);
    await new Promise((r) => setTimeout(r, 100));
    expect(activated).toEqual([["t2", "cardA"]]);
    expect(linked).toEqual([["t2", "cardA"]]);
  });

  it("link_task_card mode 'deliver' sobre uma reserva PROMOVE (não responde 'skipped')", async () => {
    const activated: Array<[string, string]> = [];
    const linked: Array<[string, string]> = [];
    const tasks = new Map<string, TaskRow>([["t2", baseTask("t2", { deps_json: null })]]);
    const made = rig({
      getTask: (id: string) => tasks.get(id),
      listTasks: () => [...tasks.values()],
      getAnyCard: () => ({ id: "cardA", provider: "commandcode" }),
      upsertTask: (t: TaskRow) => applied(t.status),
      listReservationsForCard: (cardId: string) =>
        cardId === "cardA" ? [{ task_id: "t2", role: "implementer", reserved_order: 0, linked_at: 1 }] : [],
      listTaskCardsForCard: (cardId: string) => (cardId === "cardA" ? [{ task_id: "t2", role: "implementer" }] : []),
      listLiveImplementersForTask: (taskId: string) =>
        taskId === "t2" ? [{ card_id: "cardA", reservation_state: "reserved" }] : [],
      activateReservedTaskCard: (taskId: string, cardId: string) => {
        activated.push([taskId, cardId]);
        return 1;
      },
      linkTaskCard: (taskId: string, cardId: string) => linked.push([taskId, cardId]),
      getBoardOrchestratorCardId: () => null,
    });
    ctx = made;

    const res = (await made.bus.handleRequest({
      cmd: "link_task_card",
      taskId: "t2",
      cardId: "cardA",
      mode: "deliver",
      requesterId: "human:ui",
    } as BusRequest)) as { ok: boolean; mode?: string; notice?: string; error?: string };

    expect(res.ok).toBe(true);
    expect(activated).toEqual([["t2", "cardA"]]);
    expect(linked).toEqual([["t2", "cardA"]]);
    expect(res.notice ?? "").not.toMatch(/^skipped/);
    expect(res.mode).toBe("deliver");
  });

  it("o scan de 60 s também ENTREGA a reserva pronta sem nenhum outro gatilho", async () => {
    const activated: Array<[string, string]> = [];
    let reservations: Array<Record<string, unknown>> = [
      { task_id: "t2", role: "implementer", reserved_order: 0, linked_at: 1 },
    ];
    const tasks = new Map<string, TaskRow>([["t2", baseTask("t2", { deps_json: null })]]);
    const made = rig({
      getTask: (id: string) => tasks.get(id),
      listTasks: () => [...tasks.values()],
      upsertTask: (t: TaskRow) => applied(t.status),
      listReservationsForCard: (cardId: string) => (cardId === "cardA" ? reservations : []),
      listTaskCardsForCard: () => [],
      activateReservedTaskCard: (taskId: string, cardId: string) => {
        activated.push([taskId, cardId]);
        reservations = []; // a entrega limpa a reserva (como o store faz)
        return 1;
      },
      linkTaskCard: () => 1,
      getCardTurnEndedAt: () => 2_000,
      getCardLastWorkGrantedAt: () => 1_000,
      getBoardOrchestratorCardId: () => null,
    });
    ctx = made;

    made.bus.scanStuckReservations();
    await new Promise((r) => setTimeout(r, 100));
    expect(activated).toEqual([["t2", "cardA"]]);
  });

  it("reserva pronta que NÃO sai nem no scan → watchdog avisa o orquestrador UMA vez, com o motivo", async () => {
    // Activation is a no-op (the row stays reserved), so the scan cannot resolve
    // it: this is the WARNING case. The delivery notice is suppressed
    // (orchestrator null on the first call) so the stuck notice is not parked
    // behind it on the same card.
    let orchCalls = 0;
    const reservations = [
      { task_id: "t2", role: "implementer", reserved_order: 0, linked_at: Date.now() - 10 * 60_000 },
    ];
    const tasks = new Map<string, TaskRow>([["t2", baseTask("t2", { deps_json: null })]]);
    const made = rig({
      getTask: (id: string) => tasks.get(id),
      listTasks: () => [...tasks.values()],
      upsertTask: (t: TaskRow) => applied(t.status),
      listCards: () => [
        { id: "cardA", kind: "terminal", provider: "commandcode", cwd: "", label: null, displayName: "A" },
        { id: "cardOrch", kind: "terminal", provider: "claude", cwd: "", label: null, displayName: "orch" },
      ],
      listReservationsForCard: (cardId: string) => (cardId === "cardA" ? reservations : []),
      listTaskCardsForCard: () => [],
      activateReservedTaskCard: () => 0,
      linkTaskCard: () => 1,
      getCardTurnEndedAt: () => 2_000,
      getCardLastWorkGrantedAt: () => 1_000,
      getBoardOrchestratorCardId: () => (++orchCalls > 1 ? "cardOrch" : null),
    });
    ctx = made;

    made.bus.scanStuckReservations();
    await new Promise((r) => setTimeout(r, 300));
    made.bus.scanStuckReservations();
    await new Promise((r) => setTimeout(r, 300));

    const stuck = made.writes.filter((w) => w.target === "cardOrch" && /did not start/.test(w.text));
    expect(stuck).toHaveLength(1);
    expect(stuck[0].text).toMatch(/card free/);
  });
});
