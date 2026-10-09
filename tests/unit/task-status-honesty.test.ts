import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";
import { readBus } from "../helpers/bus-response";

/**
 * NASCE VERMELHO contra HEAD (task b41ac547).
 *
 * O que este arquivo mede: a leitura que o MCP (`get_task`/`list_tasks`) e o
 * quadro Fila entregam ao orquestrador. Hoje ela FUSIONA dois fatos num campo
 * só — `status` — e afirma `running` a partir de "o processo existe"
 * (`deriveTaskStatus(row.status, isCardAlive(row.card_id))`, message-bus.ts
 * `effectiveTaskStatus`). O `card_status` do MESMO app se recusa a afirmar
 * isso ("unknown — a saída não distingue trabalho de repintura"). Quem
 * DESPACHA lê `status`; foi assim que uma task `pending` no banco apareceu
 * `running` para o orquestrador desta sessão (a própria task deste arquivo).
 *
 * A direção preferida (e a que estes testes fixam): `status` é o que o BANCO
 * diz; "tem card vivo" é um campo PRÓPRIO, com nome próprio (`cardAlive` — o
 * mesmo nome que a projeção da Fila já usa, `src/main/index.ts`). O padrão já
 * foi estabelecido quatro vezes neste repo (effortValues 07b05f43,
 * capacity.session.store 2ea0269f, appOverride edf3b047, papéis do Topbar
 * 49de95ce): separar os dois fatos em vez de fundi-los.
 *
 * O rig fala pela PORTA REAL (`handleRequest({cmd:"get_task"})`), que é
 * exatamente o objeto que o `mcp-server` serializa para o agente — nenhum
 * mock da projeção.
 */

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t",
    prompt: "task",
    provider: "cline",
    status: "pending",
    card_id: null,
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
    ...overrides,
  };
}

describe("task status: o que o banco diz é o que o agente lê", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function rig(row: TaskRow, alive: readonly string[]) {
    const live = new Set(alive);
    dir = mkdtempSync(join(tmpdir(), "stellar-status-honesty-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === row.id ? row : undefined),
        listTasks: () => [row],
        listTasksByBoard: () => [row],
        listTasksSummary: () => [row],
        listTasksSummaryByBoard: () => [row],
        getCardBoardId: (id: string) => id === "caller-card" ? row.board_id ?? undefined : undefined,
        isCardAlive: (id: string) => live.has(id),
      }),
    );
    return bus;
  }

  it("`pending` no banco LÊ `pending` mesmo com card vivo — viver não é trabalhar", async () => {
    const row = baseTask({ id: "t-live", status: "pending", card_id: "card-live" });
    const res = (await rig(row, ["card-live"]).handleRequest({ cmd: "get_task", taskId: "t-live" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true })) as {
      ok: boolean;
      task: Record<string, unknown>;
    };
    expect(res.ok).toBe(true);
    // O FATO: nenhum `running` é afirmado a partir de liveness.
    expect(res.task.status).toBe("pending");
  });

  it("`cardAlive` viaja em CAMPO PRÓPRIO — o segundo fato, com nome próprio", async () => {
    const alive = baseTask({ id: "t-live", status: "pending", card_id: "card-live" });
    const dead = baseTask({ id: "t-dead", status: "pending", card_id: "card-dead" });
    const live = new Set(["card-live"]);
    dir = mkdtempSync(join(tmpdir(), "stellar-status-honesty-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (id === alive.id ? alive : id === dead.id ? dead : undefined),
        listTasks: () => [alive, dead],
        listTasksByBoard: () => [alive, dead],
        listTasksSummary: () => [alive, dead],
        listTasksSummaryByBoard: () => [alive, dead],
        getCardBoardId: (id: string) => id === "caller-card" ? "b1" : undefined,
        isCardAlive: (id: string) => live.has(id),
      }),
    );
    const a = readBus<{ task: Record<string, unknown> }>(await bus.handleRequest({ cmd: "get_task", taskId: "t-live" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true }));
    const d = readBus<{ task: Record<string, unknown> }>(await bus.handleRequest({ cmd: "get_task", taskId: "t-dead" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true }));
    expect(a.task.cardAlive).toBe(true);
    expect(d.task.cardAlive).toBe(false);
    // Os dois fatos são independentes: os dois continuam `pending` no banco.
    expect(a.task.status).toBe("pending");
    expect(d.task.status).toBe("pending");
  });

  it("status FORA do par de julgamento sobrevive à leitura — `cancelled` não vira `pending`", async () => {
    // Medido no banco real (2026-09-23): 4 linhas `cancelled` gravadas por
    // AGENTE via update_task; nenhuma delas está em {done, failed}, então
    // `deriveTaskStatus` as achata em `pending` — a decisão do agente some da
    // leitura, e o orquestrador vê trabalho cancelado como trabalho esperando.
    const row = baseTask({ id: "t-cancelled", status: "cancelled", card_id: null });
    const res = readBus<{
      task: Record<string, unknown>;
    }>(await rig(row, []).handleRequest({ cmd: "get_task", taskId: "t-cancelled" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true }));
    expect(res.task.status).toBe("cancelled");
  });

  it("o filtro de `status` responde pela verdade do banco (list_tasks status=pending acha a task com card vivo)", async () => {
    const row = baseTask({ id: "t-live", status: "pending", card_id: "card-live" });
    const res = (await rig(row, ["card-live"]).handleRequest({
      cmd: "list_tasks",
      requesterId: "caller-card",
      status: ["pending"],
      view: "summary",
    } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true })) as { ok: boolean; tasks: { id: string }[] };
    expect(res.ok).toBe(true);
    expect(res.tasks.map((t) => t.id)).toContain("t-live");
    // `hasCard` continua sendo o jeito HONESTO de perguntar por participação.
    const byLiveness = readBus<{ tasks: { id: string }[] }>(await bus!.handleRequest({
      cmd: "list_tasks",
      requesterId: "caller-card",
      hasCard: true,
      view: "summary",
    } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true }));
    expect(byLiveness.tasks.map((t) => t.id)).toEqual(["t-live"]);
  });

  it("REGRESSÃO — o hold humano contra participação viva continua VISÍVEL (`divergedStatus`)", async () => {
    // Verde ANTES e DEPOIS do conserto: separar os fatos não pode perder a
    // divergência que a derivação existe para mostrar (uma decisão humana de
    // `pending` com card vivo trabalhando). `deriveParticipationDivergence`
    // continua recebendo o fato de participação internamente.
    const row = baseTask({
      id: "t-hold",
      status: "pending",
      card_id: "card-live",
      transitions: [{ id: "transition-1", task_id: "t-hold", kind: "status", from_value: null, to_value: "pending", actor: "human", card_id: null, at: 2 }],
    });
    const res = readBus<{
      task: Record<string, unknown>;
    }>(await rig(row, ["card-live"]).handleRequest({ cmd: "get_task", taskId: "t-hold" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true }));
    expect(res.task.divergedStatus).toBe("pending");
    expect(res.task.divergedActor).toBe("human");
  });
});
