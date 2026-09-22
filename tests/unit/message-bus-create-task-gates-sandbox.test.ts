import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * A PLATAFORMA SEM SANDBOX, medida na porta de verdade (task b928f5f3).
 *
 * `gate-runner.ts` recusa rodar `gates` sem `bwrap`, e `bwrap` é Linux: num
 * Mac a declaração era ACEITA em silêncio e a recusa só aparecia no
 * relatório, depois de a task ter corrido — "NENHUM gate declarado em task
 * neste board JAMAIS RODOU", nas palavras do dono.
 *
 * Este arquivo força a plataforma sem sandbox com `vi.mock` no SÓCIO
 * (`sandbox.ts`), onde a pergunta nasce, e exercita as DUAS portas
 * (`create_task` e `update_task`) pelo handler real do bus. Nada aqui é
 * mock de comportamento do bus: o Proxy no-op é o mesmo harness de
 * `message-bus-create-task-board-validation.test.ts`.
 */
vi.mock("../../src/main/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/sandbox")>();
  return { ...actual, isSandboxAvailable: () => false };
});

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

type UpsertedTask = { id: string; gates_json?: string | null; board_id?: string | null };

describe("message-bus: `gates` numa plataforma sem sandbox", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeBus(upserted: UpsertedTask[], existingTask?: Record<string, unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-gates-sandbox-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        boardExists: () => true,
        getBoardCwd: () => "/tmp",
        getBoardOrchestratorCardId: () => null,
        getTask: () => existingTask,
        upsertTask: (task: unknown) => {
          upserted.push(task as UpsertedTask);
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
      }),
    );
    return bus;
  }

  it("create_task COM gates: recusado, e NADA é gravado", async () => {
    const upserted: UpsertedTask[] = [];
    const b = makeBus(upserted);

    const res = (await b.handleRequest({
      cmd: "create_task",
      prompt: "x",
      boardId: "118",
      gates: ["npm test"],
    } as BusRequest)) as { ok: boolean; error?: string; field?: string };

    expect(res.ok).toBe(false);
    expect(res.field).toBe("gates");
    expect(res.error).toContain("bubblewrap");
    expect(upserted).toHaveLength(0);
  });

  it("create_task SEM gates: aceito normalmente na mesma plataforma", async () => {
    const upserted: UpsertedTask[] = [];
    const b = makeBus(upserted);

    const res = (await b.handleRequest({ cmd: "create_task", prompt: "x", boardId: "118" } as BusRequest)) as {
      ok: boolean;
      error?: string;
    };

    expect(res.ok).toBe(true);
    expect(upserted).toHaveLength(1);
  });

  it("update_task COM gates: recusado pela MESMA decisão, e nada é gravado", async () => {
    const upserted: UpsertedTask[] = [];
    const b = makeBus(upserted, { id: "t1", status: "pending", board_id: "118", gates_json: null });

    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      gates: ["npm test"],
    } as BusRequest)) as { ok: boolean; error?: string; field?: string };

    expect(res.ok).toBe(false);
    expect(res.field).toBe("gates");
    expect(upserted).toHaveLength(0);
  });

  // Limpar é `gates: null`, não `gates: []`: o parse do contrato já recusa a
  // lista vazia como FORMA ("gates must be an array of non-empty strings (or
  // omitted/null)") — medido ao vivo escrevendo este teste. A ausência é o
  // caminho de conserto desta recusa.
  it("update_task LIMPANDO os gates (null): aceito — remover a promessa é o caminho de conserto", async () => {
    const upserted: UpsertedTask[] = [];
    const b = makeBus(upserted, { id: "t1", status: "pending", board_id: "118", gates_json: JSON.stringify(["npm test"]) });

    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      gates: null,
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(true);
    expect(upserted).toHaveLength(1);
  });
});
