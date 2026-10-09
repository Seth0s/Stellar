import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * CARD HEALTH OVER THE BUS — list_cards/card_status gain `context`/`quota`, a
 * DELIVERY warns with `contextWarning` instead of delivering blind, and the
 * watchdog enqueues to the orchestrator ONCE per level.
 *
 * The reading comes from the screen COPY the app already keeps
 * (`getCardRecentOutput`, the same tail `read_card` returns) — never a live
 * database. Here the double returns a recorded claude card screen (`758k/1m`).
 */

const claudeScreen = readFileSync(
  new URL("./fixtures/tui-submit-started/claude-working.txt", import.meta.url),
  "utf8",
);
const coldScreen = "❯ Ask your question...\n";

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    { get: (_target, prop: string) => overrides[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function terminalCard(id: string, provider = "claude") {
  return { id, kind: "terminal", provider, cwd: "", label: id, displayName: id };
}

describe("card-health no bus", () => {
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
  });

  it("card_status devolve context do provider, e quota null quando ele não expõe", async () => {
    bus = createMessageBus(
      "/tmp/nonexistent-card-health-status.sock",
      callbacksWithOverrides({
        listCards: () => [terminalCard("c1")],
        isCardAlive: () => true,
        getCardLastActivityAt: () => Date.now(),
        getCardTurnEndedAt: () => null,
        getCardWriteReadiness: () => ({
          spawnedAtMs: Date.now() - 1_000,
          hasReceivedData: true,
          lastActivityAtMs: Date.now() - 1_000,
          hasPendingHumanInput: false,
        }),
        getCardRecentOutput: () => claudeScreen,
        listAllConnectors: () => [],
      }),
    );
    const res = (await bus.handleRequest({ cmd: "card_status", target: "c1" } as BusRequest)) as unknown as {
      context: { usedTokens: number; source: string; at: number } | null;
      quota: unknown;
    };
    expect(res.context?.usedTokens).toBe(758_000);
    expect(res.context?.source).toContain("status-bar");
    expect(typeof res.context?.at).toBe("number");
    expect(res.quota).toBeNull();
  });

  it("list_cards anexa context/quota por card; não-terminal responde null nos dois", async () => {
    bus = createMessageBus(
      "/tmp/nonexistent-card-health-list.sock",
      callbacksWithOverrides({
        listCards: () => [
          terminalCard("c1"),
          { id: "note-1", kind: "sticky", provider: "", cwd: "", label: "note-1", displayName: "note-1" },
        ],
        isCardAlive: () => true,
        getCardRecentOutput: (id: string) => (id === "c1" ? claudeScreen : null),
        listAllConnectors: () => [],
      }),
    );
    const res = (await bus.handleRequest({ cmd: "list" } as BusRequest)) as unknown as {
      cards: Array<{ id: string; context: { usedTokens: number } | null; quota: unknown }>;
    };
    expect(res.cards[0].context?.usedTokens).toBe(758_000);
    expect(res.cards[0].quota).toBeNull();
    expect(res.cards[1].context).toBeNull();
    expect(res.cards[1].quota).toBeNull();
  });

  it("o watchdog avisa o orquestrador UMA vez por limiar, e re-arma quando esfria", async () => {
    let screen = claudeScreen;
    const dir = mkdtempSync(join(tmpdir(), "stellar-card-health-bus-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: () => [terminalCard("c1"), terminalCard("orch")],
        isCardAlive: () => true,
        getCardBoardId: () => "b1",
        getBoardOrchestratorCardId: () => "orch",
        getCardRecentOutput: () => screen,
        listAllConnectors: () => [],
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
    // The number of SENDS to the orchestrator is read from the bus's own
    // delivery index — typing is async (queue/confirmation) and irrelevant here.
    const noticesToOrch = async (): Promise<number> => {
      const res = (await bus!.handleRequest({ cmd: "list_deliveries", target: "orch" } as BusRequest)) as unknown as {
        deliveries: unknown[];
      };
      return res.deliveries.length;
    };

    // Two consecutive passes: the same level does not warn twice.
    bus.scanCardHealth();
    bus.scanCardHealth();
    expect(await noticesToOrch()).toBe(1);

    // The card cools (the reading leaves the level): the key is retired…
    screen = coldScreen;
    bus.scanCardHealth();
    expect(await noticesToOrch()).toBe(1);

    // …and filling up again RE-ARMS the alert.
    screen = claudeScreen;
    bus.scanCardHealth();
    expect(await noticesToOrch()).toBe(2);

    bus.close();
    bus = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a ENTREGA com contexto acima do limiar traz contextWarning — não recusa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stellar-card-health-deliver-"));
    const task: TaskRow = {
      id: "t-h",
      prompt: "work",
      provider: "claude",
      status: "running",
      card_id: "impl",
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
    };
    const applied = (status: string): StatusWriteDecision => ({
      status,
      statusChanged: true,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    });
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === task.id ? task : undefined),
        listCards: () => [terminalCard("impl"), terminalCard("rev")],
        upsertTask: (t: TaskRow) => applied(t.status),
        linkTaskCard: () => undefined,
        getBoardOrchestratorCardId: (() => "orch") as never,
        listAllConnectors: () => [],
        getCardRecentOutput: (id: string) => (id === "rev" ? claudeScreen : coldScreen),
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        isCardAlive: () => true,
        listTaskCardsForCard: () => [],
        describeCardLabel: (id: string) => id,
        writeToCard: () => undefined,
        beginCardDelivery: () => true,
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
    const res = (await bus.handleRequest({
      cmd: "link_task_card",
      requesterId: "orch",
      taskId: "t-h",
      cardId: "rev",
    } as BusRequest)) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("deliver");
    expect(res.contextWarning).toMatchObject({ usedTokens: 758_000, windowTokens: 1_000_000, percent: 76 });

    await delay(400);
    bus.close();
    bus = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("card FRESCO: a mesma entrega NÃO traz contextWarning (nada de ruído)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stellar-card-health-fresh-"));
    const task: TaskRow = {
      id: "t-f",
      prompt: "work",
      provider: "claude",
      status: "running",
      card_id: "impl",
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
    };
    const applied = (status: string): StatusWriteDecision => ({
      status,
      statusChanged: true,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    });
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === task.id ? task : undefined),
        listCards: () => [terminalCard("impl"), terminalCard("rev")],
        upsertTask: (t: TaskRow) => applied(t.status),
        linkTaskCard: () => undefined,
        getBoardOrchestratorCardId: (() => "orch") as never,
        listAllConnectors: () => [],
        getCardRecentOutput: () => coldScreen,
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        isCardAlive: () => true,
        listTaskCardsForCard: () => [],
        describeCardLabel: (id: string) => id,
        writeToCard: () => undefined,
        beginCardDelivery: () => true,
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
    const res = (await bus.handleRequest({
      cmd: "link_task_card",
      requesterId: "orch",
      taskId: "t-f",
      cardId: "rev",
    } as BusRequest)) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect("contextWarning" in res).toBe(false);

    await delay(200);
    bus.close();
    bus = null;
    rmSync(dir, { recursive: true, force: true });
  });
});
