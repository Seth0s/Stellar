import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { BoardTaskDefaults } from "../../src/main/board-preset-decision";

/**
 * BOARD PRESETS — FASE 2: o default do board aplicado no `create_task`
 * (task 83f4cfa3). Medição que abriu a fase: `review`, `reportSchema` e
 * `allowCommit` só existiam por TASK — nenhuma coluna de board os guardava.
 *
 * Este teste exercita o BUS REAL (`createMessageBus`), como
 * `message-bus-create-task-board-validation.test.ts` já faz: o que interessa é
 * o que VAI PARA A LINHA da task e o que a RESPOSTA diz ao agente — não a
 * função interna.
 *
 * O que ele trava:
 *   a) omissão recebe o default do board E a resposta nomeia os campos, em
 *      inglês, deixando claro que aquilo veio do BOARD (um default silencioso
 *      faria o agente achar que declarou um contrato que não declarou);
 *   b) valor explícito ganha SEMPRE, e não aparece como default do board;
 *   c) board sem defaults = comportamento de hoje, byte a byte (nada de chave
 *      nova na resposta);
 *   d) nada aqui toca task existente nem card em execução: o efeito é só o que
 *      nasce depois (é o que a UI promete ao humano).
 */

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: create_task herda os defaults do board", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(board: BoardTaskDefaults | null, upserted: Array<Record<string, unknown>>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-presets-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        boardExists: () => true,
        getBoardTaskDefaults: () => board,
        upsertTask: (task: unknown) => {
          upserted.push(task as Record<string, unknown>);
          return {
            status: (task as { status: string }).status,
            statusChanged: true,
            divergedStatus: null,
            divergedActor: null,
            recordDeclaration: false,
            warnAgent: false,
            declaredStatus: null,
          };
        },
        getCardBoardId: () => undefined,
      }),
    );
    return bus;
  }

  const BOARD: BoardTaskDefaults = {
    review: "wanted",
    reportSchema: ["filesChanged", "evidence"],
    allowCommit: false,
  };

  it("a) campos OMITIDOS vêm do board, e a resposta DIZ que vieram do board", async () => {
    const upserted: Array<Record<string, unknown>> = [];
    const b = makeBus(BOARD, upserted);

    const res = (await b.handleRequest({ cmd: "create_task", prompt: "x", boardId: "118" } as BusRequest)) as {
      ok: boolean;
      boardDefaults?: { applied: string[]; values: Record<string, unknown>; note: string };
    };

    expect(res.ok).toBe(true);
    // Gravou: a linha carrega o default, não um vazio.
    expect(upserted[0]!.review).toBe("wanted");
    expect(upserted[0]!.report_schema_json).toBe('["filesChanged","evidence"]');
    expect(upserted[0]!.allow_commit).toBe(0);
    // E o agente FICA SABENDO — em inglês, dizendo de onde veio.
    expect(res.boardDefaults?.applied).toEqual(["review", "reportSchema", "allowCommit"]);
    expect(res.boardDefaults?.values).toEqual({
      review: "wanted",
      reportSchema: ["filesChanged", "evidence"],
      allowCommit: false,
    });
    expect(res.boardDefaults?.note).toMatch(/board "118"/);
    expect(res.boardDefaults?.note).toMatch(/Existing tasks/i);
  });

  it("b) valor EXPLÍCITO ganha, e não é anunciado como default do board", async () => {
    const upserted: Array<Record<string, unknown>> = [];
    const b = makeBus(BOARD, upserted);

    const res = (await b.handleRequest({
      cmd: "create_task",
      prompt: "x",
      boardId: "118",
      reportSchema: ["ok"],
      allowCommit: true,
    } as BusRequest)) as { ok: boolean; boardDefaults?: { applied: string[] } };

    expect(upserted[0]!.report_schema_json).toBe('["ok"]');
    expect(upserted[0]!.allow_commit).toBe(1);
    expect(res.boardDefaults?.applied).toEqual(["review"]);
  });

  it("c) board SEM defaults: a resposta não ganha chave nenhuma (a regressão)", async () => {
    const upserted: Array<Record<string, unknown>> = [];
    const b = makeBus(null, upserted);

    const res = (await b.handleRequest({ cmd: "create_task", prompt: "x", boardId: "118" } as BusRequest)) as {
      ok: boolean;
      boardDefaults?: unknown;
    };

    expect(res.ok).toBe(true);
    expect(res.boardDefaults).toBeUndefined();
    expect(upserted[0]!.review).toBeNull();
    expect(upserted[0]!.report_schema_json).toBeNull();
    expect(upserted[0]!.allow_commit).toBeNull();
  });

  it("d) valor inválido continua sendo RECUSADO (o default não afrouxa a validação)", async () => {
    const upserted: Array<Record<string, unknown>> = [];
    const b = makeBus(BOARD, upserted);

    const res = (await b.handleRequest({
      cmd: "create_task",
      prompt: "x",
      boardId: "118",
      reportSchema: [1],
    } as BusRequest)) as { ok: boolean; error?: string; field?: string };

    expect(res.ok).toBe(false);
    expect(res.field).toBe("reportSchema");
    expect(upserted).toHaveLength(0);
  });
});
