import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import {
  BOARD_CONTEXT_MARKER,
  readBoardContext,
  writeBoardContext,
  type BoardContext,
} from "../../src/main/board-context";
import type { TaskRow } from "../../src/main/store";

/**
 * O BLOCO DE CONTEXTO DO BOARD NO SPAWN (task 04826bdc).
 *
 * Exercitado pelo BUS REAL (`createMessageBus`), como
 * `message-bus-dep-pointer.test.ts` já faz para o ponteiro de dependência: o
 * brief que SAI para o spawn é o que interessa, não a função interna.
 *
 * O diretório do contexto é o MESMO do socket (é assim em produção: `index.ts`
 * monta `sockPath = join(app.getPath("userData"), SOCK_BASENAME)`) — então o
 * teste injeta contexto escrevendo o arquivo no diretório temporário do socket,
 * sem mock nenhum e sem tocar o `userData` do dono.
 *
 * O que este arquivo trava:
 *   a) regra do board chega no brief de um spawn COM task (auto-dispatch/manual);
 *   b) chega também no spawn com brief LIVRE (sem task) — pelo board de quem pede;
 *   c) board sem contexto não muda o brief NEM UM BYTE (a regressão que o
 *      `message-bus-dep-pointer` já pinava continua intacta);
 *   d) O LOOP: uma armadilha registrada em `report.boardTraps` é persistida e
 *      reaparece no brief do PRÓXIMO spawn — é isto que substitui o orquestrador
 *      lembrando de repetir a advertência;
 *   e) o mesmo brief não ganha o bloco DUAS vezes (idempotência).
 */

const BOARD = "board-context-test";

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    prompt: "implement the thing",
    provider: "claude",
    status: "running",
    card_id: "c1",
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    order: null,
    suggested_order: null,
    created_at: 1,
    updated_at: 1,
    board_id: BOARD,
    purpose: null,
    review: null,
    report_schema_json: null,
    territory_json: null,
    gates_json: null,
    allow_commit: null,
    cwd: "",
    cards: [],
  } as unknown as TaskRow;
}

describe("message-bus: o contexto do board chega ao brief de todo spawn", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(rows: TaskRow[], spawned: Array<Record<string, unknown>>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-board-context-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {
          onSpawnAgentRequest: (requestId: string, _requesterId: string, params: Record<string, unknown>) => {
            spawned.push(params);
            bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "new-card" });
          },
          getTask: (id: string) => rows.find((r) => r.id === id),
          getCardBoardId: () => BOARD,
          isCardAlive: () => true,
          // O report exige VÍNCULO VIVO com a task que ele declara
          // (`report-task-link-decision.ts`): sem isto o relatório é recusado e
          // — corretamente — nada é escrito.
          listTaskCardsForCard: () => [{ task_id: "t1", card_id: "97924099", role: "implementer" }],
          listCards: () => [{ id: "new-card", kind: "terminal", provider: "claude", cwd: "", label: null }],
          getBoardCwd: () => "/tmp",
          // Mesmos stubs do harness de `message-bus-dep-pointer.test.ts`: sem
          // eles o handler do report cai em `listAllConnectors()` undefined.
          listAllConnectors: () => [],
          recordSpawn: () => ({ id: "spawn-stub" }),
          findSpawnByChild: () => undefined,
          listSpawnsByParent: () => [],
          isBoardAutonomous: () => false,
        },
        {
          get: (target: Record<string, unknown>, prop: string) =>
            prop in target ? target[prop] : () => undefined,
        },
      ) as never,
    );
    return dir;
  }

  function seed(dirPath: string, ctx: BoardContext) {
    writeBoardContext(dirPath, BOARD, ctx);
  }

  it("a) regra do board chega no brief de um spawn COM task", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const d = makeBus([task()], spawned);
    seed(d, {
      rules: [{ text: "A worktree é a raiz do repo: rode os gates de dentro dela.", at: 1 }],
      traps: [],
    });

    const res = (await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t1",
      reason: "test",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    const brief = spawned[0]!.brief as string;
    expect(brief).toContain("implement the thing");
    expect(brief).toContain(BOARD_CONTEXT_MARKER);
    expect(brief).toContain("A worktree é a raiz do repo");
  });

  it("b) chega também no spawn com brief LIVRE — pelo board de quem pede", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const d = makeBus([], spawned);
    seed(d, { rules: [{ text: "não usar America/Sao_Paulo em teste de fuso", at: 1 }], traps: [] });

    await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      brief: "explore the repo",
      reason: "test",
      requesterId: "orch",
    } as BusRequest);

    const brief = spawned[0]!.brief as string;
    expect(brief).toContain("explore the repo");
    expect(brief).toContain("não usar America/Sao_Paulo em teste de fuso");
  });

  it("c) board SEM ARQUIVO nasce com o PROTOCOLO padrão (o seed é dado, e chega no brief)", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    makeBus([task()], spawned);

    await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t1",
      reason: "test",
      requesterId: "orch",
    } as BusRequest);

    const brief = spawned[0]!.brief as string;
    expect(brief).toContain("implement the thing");
    expect(brief).toContain(BOARD_CONTEXT_MARKER);
    // Uma regra do protocolo, vinda do DADO (não de literal em código).
    expect(brief).toContain("allowCommit");
  });

  it("c2) board com arquivo EDITADO e vazio não recebe bloco nenhum (a edição manda)", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const d = makeBus([task()], spawned);
    // O humano esvaziou o arquivo de propósito: o seed NÃO volta por cima.
    seed(d, { rules: [], traps: [] });

    await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t1",
      reason: "test",
      requesterId: "orch",
    } as BusRequest);

    expect(spawned[0]!.brief).toBe("implement the thing");
  });

  it("d) O LOOP: armadilha registrada no report reaparece no brief do PRÓXIMO spawn", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const d = makeBus([task()], spawned);

    const reported = (await bus!.handleRequest({
      cmd: "report",
      requesterId: "97924099",
      report: {
        ok: true,
        taskId: "t1",
        boardTraps: [
          "America/Sao_Paulo é fallback do ChurchTimezoneResolver: teste de fuso escrito com ele passa com a resolução quebrada.",
        ],
      },
    } as BusRequest)) as { ok: boolean };
    expect(reported.ok, JSON.stringify(reported)).toBe(true);

    // Persistiu de verdade, e com procedência.
    const persisted = readBoardContext(d, BOARD);
    expect(persisted.traps).toHaveLength(1);
    expect(persisted.traps[0]!.addedBy).toBe("97924099");
    expect(persisted.traps[0]!.taskId).toBe("t1");

    // E o spawn seguinte carrega a armadilha.
    await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t1",
      reason: "test",
      requesterId: "orch",
    } as BusRequest);
    expect(spawned[0]!.brief as string).toContain("ChurchTimezoneResolver");
  });

  it("e) um report com armadilha REPETIDA não duplica nem no arquivo nem no brief", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const d = makeBus([task()], spawned);
    const trap = "A worktree é a raiz: rode os gates de dentro dela.";
    for (const who of ["97924099", "97924100"]) {
      await bus!.handleRequest({
        cmd: "report",
        requesterId: who,
        report: { ok: true, taskId: "t1", boardTraps: [trap] },
      } as BusRequest);
    }
    expect(readBoardContext(d, BOARD).traps).toHaveLength(1);

    await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t1",
      reason: "test",
      requesterId: "orch",
    } as BusRequest);
    const brief = spawned[0]!.brief as string;
    expect(brief.split(BOARD_CONTEXT_MARKER)).toHaveLength(2);
    expect(brief.split(trap)).toHaveLength(2);
  });
});
