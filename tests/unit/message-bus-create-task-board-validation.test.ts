import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, TASK_BOARD_UNDECLARED_REASON, type BusRequest } from "../../src/main/message-bus";
import { openStore, type TaskRow } from "../../src/main/store";

/**
 * RODADA 4 (DESIGN-BACKLOG.md §2.3, "fechar a classe" do board órfão) —
 * `create_task` recusa um `boardId` que não existe em vez de gravar em
 * silêncio (mesmo princípio do fix do `effort` do antigravity: falhar
 * alto é melhor que gravar lixo quieto).
 *
 * 2026-09-19 — a outra metade da mesma classe: nenhum board resolvido
 * (sem boardId, sem cardId e sem card chamador em board) agora é RECUSADO,
 * e o board do `requesterId` passou a ser inferido (contexto que existia e
 * não era lido). 23 tasks órfãs numa sessão, todas invisíveis na Fila e sem
 * `delete_task` pra desfazer. Mesmo padrão de
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
        upsertTask: (task: unknown) => { upserted.push(task); return { status: (task as {status:string}).status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null }; },
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

  it("sem boardId, sem cardId e sem requesterId: RECUSADO, nada gravado — não nasce mais órfã invisível", async () => {
    const upserted: Array<{ board_id: string | null }> = [];
    const b = makeBus([], upserted); // nenhum board existe

    const res = (await b.handleRequest({ cmd: "create_task", prompt: "x" } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe(TASK_BOARD_UNDECLARED_REASON);
    expect(upserted).toHaveLength(0);
  });

  it("cardId cujo board não resolve: o board do CARD CHAMADOR (requesterId) é inferido — contexto que existia e não era lido", async () => {
    const upserted: Array<{ board_id: string | null }> = [];
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-create-task-board-req-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        boardExists: (id: string) => id === "b-req",
        upsertTask: (task: unknown) => { upserted.push(task as { board_id: string | null }); return { status: "pending", statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null }; },
        getCardBoardId: (id: string) => (id === "caller" ? "b-req" : undefined),
      }),
    );

    const res = (await bus.handleRequest({
      cmd: "create_task",
      prompt: "x",
      cardId: "some-closed-card",
      requesterId: "caller",
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(upserted).toHaveLength(1);
    expect(upserted[0].board_id).toBe("b-req");
  });

  it("boardId explícito vence o requesterId inferido", async () => {
    const upserted: Array<{ board_id: string | null }> = [];
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-create-task-board-explicit-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        boardExists: (id: string) => id === "b-explicit" || id === "b-req",
        upsertTask: (task: unknown) => { upserted.push(task as { board_id: string | null }); return { status: "pending", statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null }; },
        getCardBoardId: () => "b-req",
      }),
    );

    const res = (await bus.handleRequest({
      cmd: "create_task",
      prompt: "x",
      boardId: "b-explicit",
      requesterId: "caller",
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(upserted[0].board_id).toBe("b-explicit");
  });
});

describe("message-bus: caminho de conserto da task órfã (update_task.boardId)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let store: ReturnType<typeof openStore> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function boot() {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-board-repair-"));
    const s = openStore(dir);
    store = s;
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => s.getTask(id),
        listTasks: () => s.listTasks(),
        upsertTask: (task: TaskRow) => s.upsertTask(task),
        boardExists: (id: string) => id === "b1",
        getCardBoardId: () => undefined,
      }),
    );
    return { bus, store: s };
  }

  function orphan(): TaskRow {
    return {
      id: "orphan-1",
      prompt: "task sem board",
      provider: "claude",
      status: "pending",
      card_id: null,
      board_id: null,
      cwd: null,
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
      actor: "agent",
    };
  }

  it("board_id NULL é preenchido num board que existe", async () => {
    const { bus: b, store: s } = boot();
    s.upsertTask(orphan());

    const res = (await b.handleRequest({ cmd: "update_task", taskId: "orphan-1", boardId: "b1" } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(s.getTask("orphan-1")!.board_id).toBe("b1");
  });

  it("board inexistente: recusado, a task continua como estava", async () => {
    const { bus: b, store: s } = boot();
    s.upsertTask(orphan());

    const res = (await b.handleRequest({ cmd: "update_task", taskId: "orphan-1", boardId: "nope" } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
    expect(s.getTask("orphan-1")!.board_id).toBeNull();
  });

  it("task que JÁ tem board não é re-apontada (board_id é escrito uma vez)", async () => {
    const { bus: b, store: s } = boot();
    s.upsertTask({ ...orphan(), board_id: "b1" });

    const res = (await b.handleRequest({ cmd: "update_task", taskId: "orphan-1", boardId: "b1" } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toContain("once");
    expect(s.getTask("orphan-1")!.board_id).toBe("b1");
  });
});
