import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

/**
 * Task 377a6029 (fatia B+C) — entrega automática de reservas, guarda de
 * duplicação do auto-dispatch e close_card com reservas.
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

function rig(overrides: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "stellar-reservations-"));
  const writes: Array<{ target: string; text: string }> = [];
  const callbacks = new Proxy(
    {
      listCards: () => [{ id: "cardA", kind: "terminal", provider: "commandcode", cwd: "", label: null, displayName: "A" }],
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
      getCardLastActivityAt: () => 500,
      getCardTurnEndedAt: () => 1_000,
      onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "→ ok\n Working" }),
      listTaskCardsForCard: () => [],
      listTasks: () => [],
      getTaskCards: () => [],
      ...overrides,
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) },
  ) as unknown as Parameters<typeof createMessageBus>[1];
  const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { bus, writes, dir };
}

describe("task 377a6029 B+C", () => {
  let ctx: ReturnType<typeof rig> | null = null;
  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  it("entrega automática: dep fecha → card LIVRE recebe a reserva (ativa + link + aviso ao orquestrador)", async () => {
    const activated: Array<[string, string]> = [];
    const linked: Array<[string, string]> = [];
    ctx = rig({
      getTask: (id: string) =>
        id === "t1"
          ? baseTask("t1", { deps_json: JSON.stringify(["dep"]), status: "pending" })
          : id === "dep"
            ? baseTask("dep", { status: "done" })
            : undefined,
      listReservationsForCard: (cardId: string) =>
        cardId === "cardA" ? [{ task_id: "t1", role: "implementer", reserved_order: 0 }] : [],
      activateReservedTaskCard: (taskId: string, cardId: string) => {
        activated.push([taskId, cardId]);
        return 1;
      },
      linkTaskCard: (taskId: string, cardId: string) => linked.push([taskId, cardId]),
      upsertTask: (t: TaskRow) => ({ status: t.status, statusChanged: false, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null }),
      getBoardOrchestratorCardId: () => "orch",
      listAllConnectors: () => [],
      recordSpawn: () => ({ id: "s" }),
      findSpawnByChild: () => undefined,
      listSpawnsByParent: () => [],
    });

    ctx.bus.onTaskDone("dep");
    await new Promise((r) => setTimeout(r, 500));

    expect(activated).toEqual([["t1", "cardA"]]);
    expect(linked).toEqual([["t1", "cardA"]]);
    // Brief ao card + aviso ao orquestrador (o "task X entregue ao card Y").
    await new Promise((r) => setTimeout(r, 500));
    expect(ctx.writes.some((w) => w.target === "orch")).toBe(true);
  });

  it("card OCUPADO (turno não terminou) → NÃO entrega, espera o próximo fim de turno", async () => {
    const activated: string[] = [];
    ctx = rig({
      getCardLastActivityAt: () => 2_000, // atividade DEPOIS do fim de turno (1_000)
      getTask: (id: string) =>
        id === "t1" ? baseTask("t1", { deps_json: JSON.stringify(["dep"]) }) : id === "dep" ? baseTask("dep", { status: "done" }) : undefined,
      listReservationsForCard: (cardId: string) => (cardId === "cardA" ? [{ task_id: "t1", role: "implementer", reserved_order: 0 }] : []),
      activateReservedTaskCard: (taskId: string) => {
        activated.push(taskId);
        return 1;
      },
    });

    ctx.bus.onTaskDone("dep");
    await new Promise((r) => setTimeout(r, 300));
    expect(activated).toEqual([]);
  });

  it("auto-dispatch NÃO duplica: task com implementer vivo nunca ganha card novo", async () => {
    const spawned: unknown[] = [];
    ctx = rig({
      isBoardAutonomous: () => true,
      getBoardCwd: () => "/tmp",
      getBoardOrchestratorCardId: () => null,
      listTasks: () => [baseTask("child", { deps_json: JSON.stringify(["dep"]), status: "pending" }), baseTask("dep", { status: "done" })],
      getTask: (id: string) =>
        id === "child" ? baseTask("child", { deps_json: JSON.stringify(["dep"]) }) : id === "dep" ? baseTask("dep", { status: "done" }) : undefined,
      listLiveImplementersForTask: (taskId: string) => (taskId === "child" ? [{ card_id: "cardZ", reservation_state: null }] : []),
      onSpawnAgentRequest: (...a: unknown[]) => spawned.push(a),
      getTaskCards: () => [],
      listTaskCardsForCard: () => [],
    });

    ctx.bus.onTaskDone("dep");
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned).toEqual([]);
  });

  it("close_card com reservas: RECUSA nomeando as tasks (nada some em silêncio)", async () => {
    ctx = rig({
      listReservationsForCard: (cardId: string) => (cardId === "cardA" ? [{ task_id: "t1" }, { task_id: "t2" }] : []),
    });
    const res = (await ctx.bus.handleRequest({ cmd: "close_card", target: "cardA", requesterId: "orch" } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("t1");
    expect(res.error).toContain("t2");
    expect(res.error).toContain("releaseReservations");
  });

  it("close_card com releaseReservations: solta a fila e segue", async () => {
    const released: string[] = [];
    let resolveClose: ((v: boolean) => void) | null = null;
    ctx = rig({
      listReservationsForCard: (cardId: string) => (cardId === "cardA" ? [{ task_id: "t1" }] : []),
      releaseTaskCardFromTask: (input: { taskId: string }) => {
        released.push(input.taskId);
        return { ok: true, releasedAt: 1, nextPrincipalCardId: null, liveImplementersLeft: 0, taskStatus: "pending", statusHeld: false, declaredStatus: null };
      },
      onCloseCardRequest: (requestId: string) => {
        resolveClose = (allowed: boolean) => ctx?.bus.resolveCloseCard(requestId, allowed);
      },
    });
    const pending = ctx.bus.handleRequest({ cmd: "close_card", target: "cardA", requesterId: "orch", releaseReservations: true } as BusRequest);
    await new Promise((r) => setTimeout(r, 50));
    expect(released).toEqual(["t1"]);
    resolveClose!(true);
    const res = (await pending) as { ok: boolean };
    expect(res.ok).toBe(true);
  });
});
