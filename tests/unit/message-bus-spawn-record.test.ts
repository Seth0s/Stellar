import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type SpawnRow } from "../../src/main/store";
import { describeMissingSpawnReason } from "../../src/main/spawn-record-decision";

/**
 * Spawn registry via the real store — refuse without reason; record with
 * derived fields; lineage + depth survive reopen (the point of the task).
 */
describe("message-bus: spawn registry", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  let store: ReturnType<typeof openStore> | null = null;
  const recorded: SpawnRow[] = [];

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    recorded.length = 0;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function startBus() {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-bus-"));
    store = openStore(dir);
    const cardBoards = new Map<string, string>([["orch", "b1"]]);
    const overrides: Record<string, (...args: never[]) => unknown> = {
      recordSpawn: (input: Parameters<ReturnType<typeof openStore>["recordSpawn"]>[0]) => {
        const row = store!.recordSpawn(input);
        recorded.push(row);
        return row;
      },
      findSpawnByChild: (id: string) => store!.findSpawnByChild(id),
      listSpawnsByParent: (id: string) => store!.listSpawnsByParent(id),
      getCardBoardId: (id: string) => cardBoards.get(id),
      isBoardAutonomous: () => true,
      getBoardConcurrencyCap: () => 8,
      countRunningAgentsOnBoard: () => 0,
      listAllConnectors: () => [],
      listCards: () => [],
      listCardsForBoard: () => [],
      getTask: () => undefined,
      nextReportSeqSeed: () => 0,
      onSpawnAgentRequest: (requestId: string) => {
        const cardId = `born-${recorded.length + 1}`;
        cardBoards.set(cardId, "b1");
        queueMicrotask(() => bus!.resolveSpawnAgent(requestId, { ok: true, cardId }));
      },
      onSpawnCardRequest: (requestId: string) => {
        const cardId = `card-${recorded.length + 1}`;
        cardBoards.set(cardId, "b1");
        queueMicrotask(() => bus!.resolveSpawnCard(requestId, { ok: true, cardId }));
      },
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop in overrides) return overrides[prop];
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );
    return bus;
  }

  it("refuses agent spawn_agent without reason, naming the field", async () => {
    const b = startBus();
    const res = (await b.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe(describeMissingSpawnReason());
    expect(recorded).toHaveLength(0);
  });

  it("records full derived fields when agent passes reason", async () => {
    const b = startBus();
    const res = (await b.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      cwd: "/tmp/work",
      requesterId: "orch",
      reason: "measure the registry path",
    } as BusRequest)) as { ok: boolean; cardId?: string };
    expect(res.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      board_id: "b1",
      from_card_id: "orch",
      to_card_id: res.cardId,
      reason: "measure the registry path",
      provider: "claude",
      card_kind: "terminal",
      cwd: "/tmp/work",
      origin: "agent",
    });
  });

  it("survives store reopen; depth correct on a 3-level chain", async () => {
    const b = startBus();
    // Seed human root in the registry (UI path).
    store!.recordSpawn({
      boardId: "b1",
      fromCardId: null,
      toCardId: "orch",
      reason: null,
      origin: "human",
      provider: "bash",
      cardKind: "terminal",
    });

    const r1 = (await b.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      requesterId: "orch",
      reason: "level 1",
    } as BusRequest)) as { ok: boolean; cardId: string };
    expect(r1.ok).toBe(true);

    const r2 = (await b.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      requesterId: r1.cardId,
      reason: "level 2",
    } as BusRequest)) as { ok: boolean; cardId: string };
    expect(r2.ok).toBe(true);

    const r3 = (await b.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      requesterId: r2.cardId,
      reason: "level 3",
    } as BusRequest)) as { ok: boolean; cardId: string };
    expect(r3.ok).toBe(true);

    b.close();
    bus = null;
    store!.close();
    store = null;

    // Restart — registry must answer lineage without the in-memory Map.
    const again = openStore(dir);
    store = again;
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "recordSpawn") return (input: Parameters<ReturnType<typeof openStore>["recordSpawn"]>[0]) => again.recordSpawn(input);
            if (prop === "findSpawnByChild") return (id: string) => again.findSpawnByChild(id);
            if (prop === "listSpawnsByParent") return (id: string) => again.listSpawnsByParent(id);
            if (prop === "getCardBoardId") return () => "b1";
            if (prop === "listAllConnectors") return () => [];
            if (prop === "listCards") return () => [];
            if (prop === "nextReportSeqSeed") return () => 0;
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );

    const lineage = (await bus.handleRequest({
      cmd: "spawn_lineage",
      cardId: r3.cardId,
    } as BusRequest)) as {
      ok: boolean;
      depth: number;
      parent: { fromCardId: string; toCardId: string; reason: string; depth: number } | null;
      children: unknown[];
    };
    expect(lineage.ok).toBe(true);
    expect(lineage.depth).toBe(3);
    expect(lineage.parent?.fromCardId).toBe(r2.cardId);
    expect(lineage.parent?.toCardId).toBe(r3.cardId);
    expect(lineage.parent?.reason).toBe("level 3");
    expect(lineage.children).toEqual([]);

    const mid = (await bus.handleRequest({
      cmd: "spawn_lineage",
      cardId: r1.cardId,
    } as BusRequest)) as {
      ok: boolean;
      depth: number;
      children: Array<{ toCardId: string }>;
    };
    expect(mid.depth).toBe(1);
    expect(mid.children.map((c) => c.toCardId)).toEqual([r2.cardId]);
  });
});
