import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { writeBoardContext } from "../../src/main/board-context";

/**
 * Neighbour defect: `spawn_agent {taskId}` over a RESERVED task delivered the
 * brief through argv but left `reservation_state = 'reserved'` — the drawer
 * engine would deliver the SAME task a second time at the end of the turn.
 * Real path: a real store, with the reservation MOVED between cards
 * (`moveReservedTaskCards`) before the spawn.
 */

function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: `task ${id}`,
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "default",
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
    created_at: 1_000,
    updated_at: 1_000,
    ...over,
  } as TaskRow;
}

describe("spawn_agent com taskId sobre reserva — promove a reserva a ACTIVE (item 6)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { store: ReturnType<typeof openStore>; spawned: string[] } {
    dir = mkdtempSync(join(tmpdir(), "stellar-superseded-reserve-"));
    writeBoardContext(dir, "default", { rules: [], traps: [] });
    const store = openStore(dir);
    const spawned: string[] = [];
    const readySince = Date.now() - 5_000;
    const callbacks = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          switch (prop) {
            case "getTask":
              return (id: string) => store.getTask(id);
            case "upsertTask":
              return (row: TaskRow) => store.upsertTask(row);
            case "getTaskCards":
              return (id: string) => store.getTaskCards(id);
            case "listTaskCardsForCard":
              return (id: string) => store.listTaskCardsForCard(id);
            case "listLiveImplementersForTask":
              return (id: string) => store.listLiveImplementersForTask(id);
            case "listReservationsForCard":
              return (id: string) => store.listReservationsForCard(id);
            case "activateReservedTaskCard":
              return (taskId: string, cardId: string) => store.activateReservedTaskCard(taskId, cardId);
            case "linkTaskCard":
              return (taskId: string, cardId: string, role: string) => {
                store.linkTaskCard(taskId, cardId, role);
              };
            case "listTasks":
              return () => store.listTasks();
            case "getBoardOrchestratorCardId":
              return (boardId: string) => (boardId === "default" ? "orch" : null);
            case "getCardBoardId":
              return () => "default";
            case "isBoardAutonomous":
              return () => false;
            case "isCardAlive":
              return () => true;
            case "listCards":
              return () => [{ id: "cardY", kind: "terminal", provider: "claude", cwd: dir, label: null }];
            case "onSpawnAgentRequest":
              return (requestId: string) => {
                spawned.push(requestId);
                bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "cardY" });
              };
            case "listAllConnectors":
              return () => [];
            case "recordSpawn":
              return () => ({ id: "spawn-stub" });
            case "findSpawnByChild":
              return () => undefined;
            case "listSpawnsByParent":
              return () => [];
            case "writeToCard":
            case "writeToCardWithOrigin":
              return () => undefined;
            case "beginCardDelivery":
              return () => true;
            case "endCardDelivery":
              return () => undefined;
            case "getCardWriteReadiness":
              return () => ({
                spawnedAtMs: readySince,
                hasReceivedData: true,
                lastActivityAtMs: readySince,
                hasPendingHumanInput: false,
                inputLineLastAtMs: null,
              });
            case "getCardLastActivityAt":
              return () => readySince;
            default:
              return () => undefined;
          }
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(join(dir, "a.sock"), callbacks);
    return { store, spawned };
  }

  it("reserva movida para o card do spawn → spawn_agent {taskId} a torna ACTIVE; nada é entregue de novo", async () => {
    const { store: s, spawned } = setup();
    s.upsertTask(baseTask("t1"));
    s.reserveTaskCard("t1", "cardX");
    // The card closed and moved its queue to the new card.
    expect(s.moveReservedTaskCards("cardX", "cardY")).toBe(1);
    expect(s.listReservationsForCard("cardY").map((r) => r.task_id)).toEqual(["t1"]);

    const res = (await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t1",
      reason: "retomar a B8 no card novo",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; cardId?: string };
    expect(res.ok).toBe(true);
    expect(res.cardId).toBe("cardY");
    expect(spawned).toHaveLength(1);

    // The reservation became ACTIVE: it leaves the drawer queue and the link is live.
    expect(s.listReservationsForCard("cardY")).toEqual([]);
    const live = s.listLiveImplementersForTask("t1");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ card_id: "cardY", reservation_state: null });

    // The end-of-turn trigger reads the SAME queue (now empty) — nothing is
    // delivered again and no new card is born.
    bus!.onTaskDone("t1");
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned).toHaveLength(1);
    expect(s.listReservationsForCard("cardY")).toEqual([]);
  });
});
