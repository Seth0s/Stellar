import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideGatesAuthorship,
  describeGatesAuthorshipUndeclaredBoard,
} from "../../src/main/task-contract-decision";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * ITEM 2 (decisão do dono, 2026-09-21) — `gates` são shell que o APP roda
 * (`gate-runner.ts`). A porta MCP aceita `gates` de QUALQUER card; medido no
 * banco real (2026-09-21): 171 tasks com gates, 6 cards distintos autorando,
 * 38 delas no board 118 criadas por cards que NÃO são o orquestrador.
 *
 * A regra pedida, e a razão da sua FORMA:
 *   - board COM marca (`boards.orchestrator_card_id`) → só o card marcado
 *     declara gates; qualquer outro é RECUSADO nomeando o campo;
 *   - board SEM marca → comportamento de hoje (aceita) e REGISTRA. Medido:
 *     os boards 64 (Maestro) e 97924025 (Estudos) estão com a marca NULL —
 *     uma regra incondicional os brickaria.
 *
 * A leitura do papel é ESCOPADA à task (`getTaskCards(taskId)`), nunca
 * `listTaskCardsForCard(requesterId)` — o conjunto cego à task foi reprovado
 * pelo Revisor A na e8802e32 (um implementer conseguiu se liberar).
 */

const BOARD = "118";
const ORCH = "97924064";
const WORKER = "97923823";
const GATES = ["rtk proxy npx tsc --noEmit", "npx vitest run"];

function applied(status: string): StatusWriteDecision {
  return {
    status,
    statusChanged: true,
    divergedStatus: null,
    divergedActor: null,
    recordDeclaration: false,
    warnAgent: false,
    declaredStatus: null,
  };
}

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    { get: (_target, prop: string) => overrides[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t",
    prompt: "x",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: BOARD,
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
    ...overrides,
  };
}

describe("decideGatesAuthorship — com marca, sem marca e mudança de conjunto", () => {
  it("conjunto ausente/vazio dos DOIS lados: allow — não mudar não é autoria", () => {
    expect(
      decideGatesAuthorship({
        gates: null,
        current: null,
        boardId: BOARD,
        orchestratorCardId: ORCH,
        requesterId: WORKER,
      }).action,
    ).toBe("allow");
    expect(
      decideGatesAuthorship({
        gates: [],
        current: null,
        boardId: BOARD,
        orchestratorCardId: ORCH,
        requesterId: WORKER,
      }).action,
    ).toBe("allow");
  });

  it("re-escrever o MESMO conjunto não é autoria; permutar É (ordem é execução)", () => {
    const base = { boardId: BOARD, orchestratorCardId: ORCH, requesterId: WORKER };
    expect(decideGatesAuthorship({ ...base, gates: GATES, current: GATES }).action).toBe("allow");
    expect(decideGatesAuthorship({ ...base, gates: [...GATES].reverse(), current: GATES }).action).toBe("refuse");
  });

  it("APAGAR um conjunto existente também é autoria — fechar a porta dos fundos", () => {
    expect(
      decideGatesAuthorship({
        gates: null,
        current: GATES,
        boardId: BOARD,
        orchestratorCardId: ORCH,
        requesterId: WORKER,
      }).action,
    ).toBe("refuse");
  });

  it("board SEM marca: allow E REGISTRA (comportamento de hoje, não brickar)", () => {
    const decision = decideGatesAuthorship({
      gates: GATES,
      current: null,
      boardId: BOARD,
      orchestratorCardId: null,
      requesterId: WORKER,
    });
    expect(decision.action).toBe("allow-and-record");
    if (decision.action !== "allow-and-record") return;
    expect(decision.note).toContain(BOARD);
    expect(decision.note).toContain(WORKER);
    expect(decision.note).toContain("orquestrador");
  });

  it("board COM marca: o próprio orquestrador declara", () => {
    expect(
      decideGatesAuthorship({
        gates: GATES,
        current: null,
        boardId: BOARD,
        orchestratorCardId: ORCH,
        requesterId: ORCH,
      }).action,
    ).toBe("allow");
  });

  it("board COM marca: quem NÃO é o orquestrador é RECUSADO nomeando `gates`", () => {
    const decision = decideGatesAuthorship({
      gates: GATES,
      current: null,
      boardId: BOARD,
      orchestratorCardId: ORCH,
      requesterId: WORKER,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.error).toContain("`gates`");
    expect(decision.error).toContain(ORCH);
    expect(decision.error).toContain(WORKER);
    expect(decision.error).toContain("Nada foi gravado");
  });

  it("board COM marca e chamador ANÔNIMO: recusado — não se presume orquestrador", () => {
    const decision = decideGatesAuthorship({
      gates: GATES,
      current: null,
      boardId: BOARD,
      orchestratorCardId: ORCH,
      requesterId: null,
    });
    expect(decision.action).toBe("refuse");
  });

  it("o registro do board sem marca nomeia o que fazer", () => {
    const note = describeGatesAuthorshipUndeclaredBoard({ boardId: BOARD, requesterId: null });
    expect(note).toContain(BOARD);
    expect(note).toContain("anônimo");
  });
});

describe("create_task — autoria de gates passa pelo orquestrador do board", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let upserted: TaskRow[];
  let warns: string[];

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    warns = [];
  });

  function makeBus(mark: string | null) {
    dir = mkdtempSync(join(tmpdir(), "stellar-gates-authorship-"));
    upserted = [];
    warns = [];
    const spy = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    process.once("exit", () => {
      console.warn = spy;
    });
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        boardExists: () => true,
        getBoardCwd: () => undefined,
        getBoardOrchestratorCardId: () => mark,
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return applied(task.status);
        },
      }),
    );
    return bus;
  }

  it("board COM marca: worker declara gates → recusado nomeando `gates`; NADA gravado", async () => {
    const b = makeBus(ORCH);
    const res = (await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "x",
      gates: GATES,
      requesterId: WORKER,
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("`gates`");
    expect(upserted).toEqual([]);
  });

  it("board COM marca: o orquestrador declara gates → grava", async () => {
    const b = makeBus(ORCH);
    const res = (await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "x",
      gates: GATES,
      requesterId: ORCH,
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(JSON.parse(String(upserted[0].gates_json))).toEqual(GATES);
  });

  it("board SEM marca: worker declara gates → grava E registra (não brickar)", async () => {
    const b = makeBus(null);
    const res = (await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "x",
      gates: GATES,
      requesterId: WORKER,
    } as BusRequest)) as { ok: boolean; warning?: string };

    expect(res.ok).toBe(true);
    expect(JSON.parse(String(upserted[0].gates_json))).toEqual(GATES);
    expect(String(res.warning)).toContain("orquestrador");
    expect(warns.join("\n")).toContain(BOARD);
  });

  it("board COM marca: criar task COM territory/cwd mas SEM gates não é tocado pela regra", async () => {
    const b = makeBus(ORCH);
    const res = (await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "x",
      territory: ["src/main/message-bus.ts"],
      requesterId: WORKER,
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(upserted).toHaveLength(1);
  });
});

describe("update_task — a MESMA regra na segunda porta", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let upserted: TaskRow[];

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(task: TaskRow, mark: string | null) {
    dir = mkdtempSync(join(tmpdir(), "stellar-gates-authorship-upd-"));
    upserted = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => task,
        getTaskCards: () => [],
        getBoardCwd: () => undefined,
        getBoardOrchestratorCardId: () => mark,
        upsertTask: (t: TaskRow) => {
          upserted.push(t);
          return applied(t.status);
        },
      }),
    );
    return bus;
  }

  it("worker troca os gates de uma task em board COM marca → recusa; nada gravado", async () => {
    const b = makeBus(baseTask({ id: "t1", board_id: BOARD }), ORCH);
    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      gates: ["rm -rf /"],
      requesterId: WORKER,
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("`gates`");
    expect(upserted).toEqual([]);
  });

  it("worker LIMPAR os gates (null) em board COM marca também é autoria → recusa", async () => {
    const b = makeBus(baseTask({ id: "t1", board_id: BOARD, gates_json: JSON.stringify(GATES) }), ORCH);
    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      gates: null,
      requesterId: WORKER,
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(upserted).toEqual([]);
  });

  it("o orquestrador troca os gates → grava", async () => {
    const b = makeBus(baseTask({ id: "t1", board_id: BOARD }), ORCH);
    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      gates: GATES,
      requesterId: ORCH,
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(JSON.parse(String(upserted[0].gates_json))).toEqual(GATES);
  });
});
