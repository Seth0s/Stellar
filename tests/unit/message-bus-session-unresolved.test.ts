import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

/**
 * Task ea71065e — (2) o id JÁ conhecido carimba `task_cards.session_id` junto do
 * LINK (não só quando o watcher descobre depois), e (3) o NÃO-SILÊNCIO do
 * contexto perdido vai ao ORQUESTRADOR do board com o id do card E da task.
 */

type LinkCall = { taskId: string; cardId: string; role: string; sessionId?: string | null };

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    prompt: "task",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    territory_json: null,
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
  } as unknown as TaskRow;
}

describe("task ea71065e — sessão no link e aviso de contexto perdido", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function callbacks(overrides: Record<string, unknown>): Parameters<typeof createMessageBus>[1] {
    return new Proxy(
      {},
      {
        get: (_t, prop: string) => (prop in overrides ? (overrides as Record<string, unknown>)[prop] : () => undefined),
      },
    ) as Parameters<typeof createMessageBus>[1];
  }

  it("(2) card que JÁ conhece o seu resume_id carimba session_id no link da task", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-link-session-"));
    const task = baseTask({ id: "t1" });
    const links: LinkCall[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacks({
        getTask: (id: string) => (id === "t1" ? task : undefined),
        listTasks: () => [task],
        listCards: () => [
          { id: "card-9", kind: "terminal", provider: "claude", cwd: "/repo", label: null, displayName: "c9", resume_id: "sess-9" },
        ],
        isCardAlive: () => true,
        getTaskCards: () => [],
        listTaskCardsForCard: () => [],
        isBoardAutonomous: () => false,
        getCardBoardId: () => "b1",
        describeCardLabel: (id: string) => id,
        linkTaskCard: (taskId: string, cardId: string, role: string, profile?: { sessionId?: string | null }) => {
          links.push({ taskId, cardId, role, sessionId: profile?.sessionId });
          return undefined;
        },
        onSpawnAgentRequest: (requestId: string) => {
          bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "card-9" });
        },
      }),
    );

    const res = (await bus.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t1",
      reason: "test",
      requesterId: "orch",
    } as BusRequest)) as unknown as { ok: boolean; error?: string };

    expect(res.ok).toBe(true);
    expect(links).toHaveLength(1);
    expect(links[0]!.sessionId).toBe("sess-9");
  });

  it("(3) o aviso de sessão não atribuída vai ao ORQUESTRADOR do board, com card e task", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-session-unresolved-"));
    const writes: { target: string; text: string }[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacks({
        listTaskCardsForCard: () => [{ task_id: "t1", card_id: "card-9", role: "implementer", released_at: null }],
        getTask: (id: string) => (id === "t1" ? baseTask({ id: "t1", board_id: "b1" }) : undefined),
        getBoardOrchestratorCardId: () => "orch",
        isCardAlive: (id: string) => id === "orch",
        listCards: () => [{ id: "orch", kind: "terminal", provider: "claude", cwd: "", label: "Master", displayName: "Master" }],
        describeCardLabel: (id: string) => id,
        writeToCard: (id: string, text: string) => {
          writes.push({ target: id, text });
        },
        writeToCardWithOrigin: (id: string, text: string) => {
          writes.push({ target: id, text });
        },
        beginCardDelivery: () => true,
        endCardDelivery: () => undefined,
        getCardLastActivityAt: () => Date.now(),
        getCardWriteReadiness: () => ({
          spawnedAtMs: Date.now() - 5_000,
          hasReceivedData: true,
          lastActivityAtMs: Date.now() - 5_000,
          hasPendingHumanInput: false,
          inputLineLastAtMs: null,
        }),
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "→ notice\n Working" }),
      }),
    );

    bus.notifySessionUnresolved("card-9", "ambiguous");

    // A entrega é assíncrona na FIFO: espera a escrita chegar ao orquestrador.
    const deadline = Date.now() + 4_000;
    while (!writes.some((w) => w.target === "orch") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const notice = writes.find((w) => w.target === "orch");
    expect(notice).toBeDefined();
    expect(notice!.text).toContain("card-9");
    expect(notice!.text).toContain("t1");
    expect(notice!.text).toMatch(/ambiguous|context/i);
  });
});
