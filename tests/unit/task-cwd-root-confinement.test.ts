import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideTaskCwdWithinRoot, declaredRootForTask, isPathInsideRoot } from "../../src/main/task-dispatch-decision";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { interruptionReasonFromResultJson } from "../../src/main/failure-kind-decision";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import type { TaskRow } from "../../src/main/store";

/**
 * ITEM 1 (decisão do dono, 2026-09-21) — o `cwd` de uma task é executável:
 * decide onde o GATE roda (`gate-runner.ts`) e onde um card auto-despachado
 * abre (`task-dispatch-decision.ts`). Até aqui ele só passava por `trim`.
 *
 * A regra: um `cwd` declarado tem de cair DENTRO da declared root do board
 * (`boards.cwd` — a sessão real escolhida no PathPicker). Fora dela é
 * refused NOMEANDO o campo, no idioma das outras recusas, e nada é gravado.
 *
 * O corte é por CAMINHO, não por identidade: vale para qualquer card, e é
 * por isso que ele é o primeiro (a identidade é justamente o que costuma
 * vazar — ver e8802e32).
 */

const BOARD = "118";
const ROOT = "/home/lucas/Workplace/Projects";

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

describe("isPathInsideRoot — fronteira de diretório, não prefixo de string", () => {
  it("dentro e na própria raiz", () => {
    expect(isPathInsideRoot("/a/b/c", "/a/b")).toBe(true);
    expect(isPathInsideRoot("/a/b", "/a/b")).toBe(true);
  });

  it("irmão que COMPARTILHA o prefixo NÃO é dentro (`/a/bc` vs `/a/b`)", () => {
    expect(isPathInsideRoot("/a/bc", "/a/b")).toBe(false);
    expect(isPathInsideRoot("/home/lucas/Workplace/Projects2", "/home/lucas/Workplace/Projects")).toBe(false);
  });

  it("fora, e `..` resolvido antes de comparar", () => {
    expect(isPathInsideRoot("/etc", "/a/b")).toBe(false);
    expect(isPathInsideRoot("/a/b/../c", "/a/b")).toBe(false);
    expect(isPathInsideRoot("/a/./b/c/", "/a/b")).toBe(true);
  });
});

describe("decideTaskCwdWithinRoot", () => {
  it("dentro da raiz → ok com o cwd trimado", () => {
    expect(decideTaskCwdWithinRoot({ tool: "create_task", cwd: `  ${ROOT}/Stellar  `, root: ROOT })).toEqual({
      action: "ok",
      cwd: `${ROOT}/Stellar`,
    });
  });

  it("ausente/vazio → ok null (fallback declarado da raiz do board)", () => {
    expect(decideTaskCwdWithinRoot({ tool: "create_task", cwd: undefined, root: ROOT })).toEqual({
      action: "ok",
      cwd: null,
    });
    expect(decideTaskCwdWithinRoot({ tool: "create_task", cwd: "   ", root: ROOT })).toEqual({
      action: "ok",
      cwd: null,
    });
  });

  it("board SEM declared root → ok: ausência de raiz não vira recusa inventada", () => {
    expect(decideTaskCwdWithinRoot({ tool: "create_task", cwd: "/tmp/anywhere", root: "" })).toEqual({
      action: "ok",
      cwd: "/tmp/anywhere",
    });
    expect(decideTaskCwdWithinRoot({ tool: "create_task", cwd: "/tmp/anywhere", root: undefined })).toEqual({
      action: "ok",
      cwd: "/tmp/anywhere",
    });
  });

  it("fora da raiz → recusa NOMEANDO `cwd`, com a raiz e o recebido", () => {
    const decision = decideTaskCwdWithinRoot({ tool: "create_task", cwd: "/home/lucas/wt/idy-x", root: ROOT });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.field).toBe("cwd");
    expect(decision.error).toContain("`cwd`");
    expect(decision.error).toContain(ROOT);
    expect(decision.error).toContain("/home/lucas/wt/idy-x");
    expect(decision.error).toContain("Nothing was written");
  });
});

describe("declaredRootForTask — sem declared root vira RECUSA, não permissão", () => {
  /**
   * MEDIDO no banco real em 2026-09-21: **33 tasks sem board, 22 delas COM
   * gates**. Elas resolvem `declaredRoot` indefinido — e indefinido, desde a
   * decisão do dono de hoje, significa que o gate NÃO executa
   * (`gate-runner.ts`, `describeNoDeclaredRoot`).
   *
   * Isto CONTRARIA a simetria que o Revisor A havia avalizado ("ausência de
   * raiz = ausência de limite") e é escolha declarada, com o raio medido:
   * nenhuma dessas 33 é despachável, as 3 não terminais estão dormentes (sem
   * card e sem vínculo) e task sem board não é mais criável. Este teste prende
   * a decisão que o cabeçalho do `gate-runner.ts` afirma.
   */
  it("task SEM board não tem raiz — e é isso que a deixa FORA da execução", () => {
    expect(declaredRootForTask(null, "/lucas/Workplace/Projects")).toBeUndefined();
    expect(declaredRootForTask(undefined, "/lucas/Workplace/Projects")).toBeUndefined();
    expect(declaredRootForTask("", "/lucas/Workplace/Projects")).toBeUndefined();
  });

  it("board COM declared root → a raiz; board legado sem cwd → nada (não se inventa)", () => {
    expect(declaredRootForTask("118", "/home/lucas/Workplace/Projects")).toBe("/home/lucas/Workplace/Projects");
    expect(declaredRootForTask("64", "")).toBeUndefined();
    expect(declaredRootForTask("64", "   ")).toBeUndefined();
    expect(declaredRootForTask("64", null)).toBeUndefined();
  });
});

describe("auto-dispatch — a MESMA regra do gate, uma função acima (2026-09-21)", () => {
  /**
   * O IRMÃO QUE FALTAVA. O gate passou a RECUSAR sem declared root; o
   * auto-dispatch, na mesma situação, ainda DESPACHAVA — abrindo card no
   * `cwdDecision.cwd` sem raiz nenhuma. Duas noções opostas para a mesma
   * pergunta ("onde esta task pode rodar?"), com um comentário afirmando que
   * havia uma só. Achado do Revisor A na reauditoria da 5412f61e.
   *
   * Custo zero pelo mesmo argumento que fechou o gate: nenhuma task sem raiz
   * é despachável hoje (o auto-dispatch exige `board_id`). É uniformidade, não
   * incidência.
   */
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let upserted: TaskRow[];
  let spawnParams: Array<Record<string, unknown>>;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeDispatchBus(root: string | undefined) {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-noroot-"));
    upserted = [];
    spawnParams = [];
    const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", provider: "claude" });
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        boardExists: () => true,
        getBoardCwd: () => root,
        isBoardAutonomous: () => true,
        listTasks: () => [dep],
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return applied(task.status);
        },
        onSpawnAgentRequest: ((_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        }) as never,
      }),
    );
    return bus;
  }

  async function createDependent(b: ReturnType<typeof createMessageBus>, cwd: string) {
    return (await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "filha",
      provider: "claude",
      deps: ["dep-done"],
      cwd,
    } as BusRequest)) as { ok: boolean; taskId: string; dispatched: boolean };
  }

  it("board SEM declared root: NÃO despacha o dependente e REGISTRA o motivo", async () => {
    const b = makeDispatchBus(undefined);
    const res = await createDependent(b, "/tmp/qualquer");

    expect(res.ok).toBe(true);
    expect(res.dispatched).toBe(false);
    expect(spawnParams).toHaveLength(0);
    const refused = upserted.find((t) => t.id === res.taskId && t.result_json);
    expect(refused).toBeDefined();
    expect(interruptionReasonFromResultJson(refused!.result_json)).toContain("declared root");
  });

  it("board COM declared root e cwd DENTRO dela: despacha normalmente", async () => {
    const b = makeDispatchBus(ROOT);
    const res = await createDependent(b, `${ROOT}/Stellar`);

    expect(res.ok).toBe(true);
    expect(res.dispatched).toBe(true);
    expect(spawnParams).toHaveLength(1);
  });

  it("cwd fora da raiz numa linha LEGADA: o dispatch também recusa (a escrita já não deixa passar)", async () => {
    // A guarda de dispatch fora-da-raiz vale para linha ESCRITA ANTES da regra
    // de escrita existir: uma task nova com cwd fora da raiz nem chega a ser
    // gravada (teste acima), então o único caminho para exercitar isto é uma
    // linha legada já no store.
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-legacy-"));
    upserted = [];
    spawnParams = [];
    const rows = new Map<string, TaskRow>();
    const dep = baseTask({ id: "dep-done", status: "done", provider: "claude" });
    const legacy = baseTask({
      id: "legacy-out",
      status: "pending",
      provider: "claude",
      cwd: "/etc",
      deps_json: JSON.stringify(["dep-done"]),
    });
    rows.set(dep.id, { ...dep, status: "running" });
    rows.set(legacy.id, legacy);
    const persistTask = createTaskWriteFunnel({
      upsertTask: (task: TaskRow) => {
        upserted.push(task);
        rows.set(task.id, task);
        return applied(task.status);
      },
      applyColumnDrop: (task: TaskRow) => applied(task.status),
      afterWrite: () => {},
      onTaskDone: (id: string) => bus?.onTaskDone(id),
    }).persistTask;

    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => rows.get(id),
        listTasks: () => [dep, rows.get("legacy-out")!],
        getBoardCwd: () => ROOT,
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        upsertTask: (task: TaskRow) => persistTask(task),
        onSpawnAgentRequest: ((_requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawnParams.push(params);
        }) as never,
      }),
    );

    await bus.handleRequest({ cmd: "update_task", taskId: "dep-done", status: "done" } as BusRequest);

    expect(spawnParams).toHaveLength(0);
    const refused = upserted.find((t) => t.id === "legacy-out" && t.result_json);
    expect(refused).toBeDefined();
    expect(interruptionReasonFromResultJson(refused!.result_json)).toContain("OUTSIDE the board's declared root");
  });
});

describe("create_task — cwd confinado à declared root do board", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let upserted: TaskRow[];

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(root: string | undefined) {
    dir = mkdtempSync(join(tmpdir(), "stellar-cwd-root-"));
    upserted = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        boardExists: () => true,
        getBoardCwd: () => root,
        upsertTask: (task: TaskRow) => {
          upserted.push(task);
          return applied(task.status);
        },
      }),
    );
    return bus;
  }

  it("cwd FORA da raiz → ok:false nomeando `cwd`, e NADA é gravado", async () => {
    const b = makeBus(ROOT);
    const res = (await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "x",
      cwd: "/home/lucas/wt/idy-reserva",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("`cwd`");
    expect(String(res.error)).toContain(ROOT);
    expect(String(res.error)).toContain("Nothing was written");
    expect(upserted).toEqual([]);
  });

  it("cwd DENTRO da raiz → grava; cwd igual à raiz → grava", async () => {
    const b = makeBus(ROOT);
    await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "x",
      cwd: `${ROOT}/Stellar`,
    } as BusRequest);
    await b.handleRequest({ cmd: "create_task", boardId: BOARD, prompt: "y", cwd: ROOT } as BusRequest);

    expect(upserted.map((t) => t.cwd)).toEqual([`${ROOT}/Stellar`, ROOT]);
  });

  it("sem cwd → null (raiz do board no dispatch, declarado)", async () => {
    const b = makeBus(ROOT);
    await b.handleRequest({ cmd: "create_task", boardId: BOARD, prompt: "x" } as BusRequest);
    expect(upserted[0].cwd).toBeNull();
  });

  it("board sem declared root → grava (não inventa recusa onde não há raiz)", async () => {
    const b = makeBus(undefined);
    const res = (await b.handleRequest({
      cmd: "create_task",
      boardId: BOARD,
      prompt: "x",
      cwd: "/tmp/anywhere",
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(upserted[0].cwd).toBe("/tmp/anywhere");
  });
});

describe("update_task — cwd confinado pelo board da task", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let upserted: TaskRow[];

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(task: TaskRow, root: string | undefined) {
    dir = mkdtempSync(join(tmpdir(), "stellar-cwd-root-upd-"));
    upserted = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: () => task,
        getTaskCards: () => [],
        getBoardCwd: () => root,
        upsertTask: (t: TaskRow) => {
          upserted.push(t);
          return applied(t.status);
        },
      }),
    );
    return bus;
  }

  it("cwd fora da raiz do board da task → recusa nomeando `cwd`; nada gravado", async () => {
    const b = makeBus(baseTask({ id: "t1", cwd: `${ROOT}/Stellar` }), ROOT);
    const res = (await b.handleRequest({ cmd: "update_task", taskId: "t1", cwd: "/etc" } as BusRequest)) as {
      ok: boolean;
      error?: string;
    };

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("`cwd`");
    expect(upserted).toEqual([]);
  });

  it("cwd dentro da raiz → grava, e `null` limpa (volta ao fallback)", async () => {
    const b = makeBus(baseTask({ id: "t1", cwd: null }), ROOT);
    await b.handleRequest({ cmd: "update_task", taskId: "t1", cwd: `${ROOT}/IdyPlatform` } as BusRequest);
    await b.handleRequest({ cmd: "update_task", taskId: "t1", cwd: null } as BusRequest);

    expect(upserted.map((t) => t.cwd)).toEqual([`${ROOT}/IdyPlatform`, null]);
  });
});
