import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";

/**
 * DEFEITO MEDIDO 2026-10-04 — a entrega automática da gaveta não entregava a
 * reserva quando a dep fechava via `update_task` com o card parado, porque
 * `isCardBusy` media o relógio de BYTES (`lastActivityAt`) e um TUI parado
 * REPINTA. Mais os dois defeitos do adendo: `update_task cardId:null` não
 * soltava a reserva; e uma reserva contava como ACTIVE na guarda de território.
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

describe("entrega automática da gaveta (defeito 2026-10-04)", () => {
  let ctx: { bus: ReturnType<typeof createMessageBus>; dir: string } | null = null;

  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  function rig(overrides: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "stellar-res-deliver-"));
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
        getCardWriteReadiness: () => ({ spawnedAtMs: Date.now() - 5_000, hasReceivedData: true, lastActivityAtMs: Date.now() - 5_000, hasPendingHumanInput: false, inputLineLastAtMs: null }),
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

  it("done via update_task com o card de turno encerrado (mas repintando) ENTREGA a reserva", async () => {
    const activated: Array<[string, string]> = [];
    const linked: Array<[string, string]> = [];
    const tasks = new Map<string, TaskRow>([
      ["dep", baseTask("dep", { status: "running" })],
      ["t2", baseTask("t2", { deps_json: JSON.stringify(["dep"]) })],
    ]);
    let bus: ReturnType<typeof createMessageBus> | null = null;
    const persistTask = createTaskWriteFunnel({
      // O store REAL persistiria a linha; o rig atualiza o mapa para o motor
      // de reserva ler a dep já `done`.
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
      listReservationsForCard: (cardId: string) => (cardId === "cardA" ? [{ task_id: "t2", role: "implementer", reserved_order: 0 }] : []),
      activateReservedTaskCard: (taskId: string, cardId: string) => {
        activated.push([taskId, cardId]);
        return 1;
      },
      linkTaskCard: (taskId: string, cardId: string) => linked.push([taskId, cardId]),
      // O CARD está PARADO (turno encerrado), mas a TUI repinta: bytes DEPOIS
      // do fim do turno. O fato de TRABALHO (última entrega/input) é ANTERIOR.
      getCardTurnEndedAt: () => 1_000,
      getCardLastActivityAt: () => 9_000, // repaint
      getCardLastWorkGrantedAt: () => 400, // trabalho concedido antes do fim do turno
      listTaskCardsForCard: () => [],
    });
    bus = made.bus;
    ctx = made;

    const res = (await bus.handleRequest({ cmd: "update_task", taskId: "dep", status: "done" } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(activated).toEqual([["t2", "cardA"]]);
    expect(linked).toEqual([["t2", "cardA"]]);
  });

  it("trabalho concedido DEPOIS do fim do turno mantém o card ocupado (não entrega)", async () => {
    const activated: Array<[string, string]> = [];
    const tasks = new Map<string, TaskRow>([
      ["dep", baseTask("dep", { status: "running" })],
      ["t2", baseTask("t2", { deps_json: JSON.stringify(["dep"]) })],
    ]);
    let bus: ReturnType<typeof createMessageBus> | null = null;
    const persistTask = createTaskWriteFunnel({
      upsertTask: (t) => applied(t.id === "dep" ? "done" : t.status),
      applyColumnDrop: (dragged) => applied(dragged.status),
      afterWrite: () => {},
      onTaskDone: (id) => bus?.onTaskDone(id),
    }).persistTask;

    const made = rig({
      getTask: (id: string) => tasks.get(id),
      listTasks: () => [...tasks.values()],
      upsertTask: (t: TaskRow) => persistTask(t),
      listReservationsForCard: (cardId: string) => (cardId === "cardA" ? [{ task_id: "t2", role: "implementer", reserved_order: 0 }] : []),
      activateReservedTaskCard: (taskId: string, cardId: string) => {
        activated.push([taskId, cardId]);
        return 1;
      },
      getCardTurnEndedAt: () => 1_000,
      getCardLastWorkGrantedAt: () => 2_000, // trabalho novo depois do turno
      listTaskCardsForCard: () => [],
    });
    bus = made.bus;
    ctx = made;

    await bus.handleRequest({ cmd: "update_task", taskId: "dep", status: "done" } as BusRequest);
    await new Promise((r) => setTimeout(r, 200));
    expect(activated).toEqual([]);
  });

  it("`update_task cardId:null` SOLTA a reserva (libera o vínculo reservado)", async () => {
    const released: Array<{ taskId: string; cardId: string }> = [];
    const tasks = new Map<string, TaskRow>([["t2", baseTask("t2")]]);
    const made = rig({
      getTask: (id: string) => tasks.get(id),
      listTasks: () => [...tasks.values()],
      upsertTask: (t: TaskRow) => applied(t.status),
      // A reserva VIVA deste card para t2.
      listLiveImplementersForTask: (taskId: string) => (taskId === "t2" ? [{ card_id: "cardA", reservation_state: "reserved" }] : []),
      releaseTaskCardFromTask: (input: { taskId: string; cardId: string }) => {
        released.push({ taskId: input.taskId, cardId: input.cardId });
        return { ok: true, releasedAt: 1, nextPrincipalCardId: null, liveImplementersLeft: 0, taskStatus: "pending", statusHeld: false, declaredStatus: null };
      },
      getTaskCards: () => [],
    });
    ctx = made;

    const res = (await made.bus.handleRequest({ cmd: "update_task", taskId: "t2", cardId: null } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(released).toEqual([{ taskId: "t2", cardId: "cardA" }]);
  });
});
