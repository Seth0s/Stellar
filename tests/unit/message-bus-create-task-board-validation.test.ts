import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * RODADA 4 (DESIGN-BACKLOG.md §2.3, "fechar a classe" do board órfão) —
 * `create_task` agora recusa um `boardId` que não existe em vez de gravar
 * em silêncio (mesmo princípio do fix do `effort` do antigravity: falhar
 * alto é melhor que gravar lixo quieto). Mesmo padrão de
 * `message-bus-report-notify.test.ts`: Proxy no-op + overrides pontuais.
 */
function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: create_task valida boardId", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(existingBoardIds: string[], upserted: unknown[]) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-create-task-board-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        boardExists: (id: string) => existingBoardIds.includes(id),
        upsertTask: (task: unknown) => upserted.push(task),
        getCardBoardId: () => undefined,
      }),
    );
    return bus;
  }

  it("boardId que não existe: recusado com erro explícito, NADA é gravado", async () => {
    const upserted: unknown[] = [];
    const b = makeBus(["118"], upserted);

    const res = (await b.handleRequest({ cmd: "create_task", prompt: "x", boardId: "1" } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(upserted).toHaveLength(0); // o ponto principal: nunca grava a órfã em primeiro lugar
  });

  it("boardId que existe: aceito normalmente, grava com esse board_id", async () => {
    const upserted: Array<{ board_id: string | null }> = [];
    const b = makeBus(["118"], upserted);

    const res = (await b.handleRequest({ cmd: "create_task", prompt: "x", boardId: "118" } as BusRequest)) as { ok: boolean; taskId?: string };

    expect(res.ok).toBe(true);
    expect(upserted).toHaveLength(1);
    expect(upserted[0].board_id).toBe("118");
  });

  it("sem boardId nem cardId: bookkeeping puro, board_id null, NUNCA precisa existir — não é o caso que a validação pega", async () => {
    const upserted: Array<{ board_id: string | null }> = [];
    const b = makeBus([], upserted); // nenhum board existe

    const res = (await b.handleRequest({ cmd: "create_task", prompt: "x" } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(upserted).toHaveLength(1);
    expect(upserted[0].board_id).toBeNull();
  });

  it("cardId cujo board já não resolve (card fechado/board dele já sumiu) cai pra bookkeeping (null), não é recusado", async () => {
    const upserted: Array<{ board_id: string | null }> = [];
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-create-task-board-cardid-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        boardExists: () => false, // nenhum board "existe" neste teste — não deveria nem ser consultado
        upsertTask: (task: unknown) => upserted.push(task as { board_id: string | null }),
        getCardBoardId: () => undefined, // card não resolve a nenhum board (fechado/nunca existiu)
      }),
    );

    const res = (await bus.handleRequest({ cmd: "create_task", prompt: "x", cardId: "some-closed-card" } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(upserted).toHaveLength(1);
    expect(upserted[0].board_id).toBeNull();
  });
});
