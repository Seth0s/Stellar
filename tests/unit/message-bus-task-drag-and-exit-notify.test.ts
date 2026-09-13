import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 (arrastar) + "SINAL 2" (saída sem
 * relatório) — os dois pontos de main process que este trabalho acrescenta
 * a message-bus.ts: `notifyHumanMovedTask` (peça 3, decisão 5 — o card
 * vinculado a uma task arrastada pelo HUMANO ainda recebe o aviso
 * digitado; CLI de terceiro não tem RPC) e o que `resolveCardExit` faz
 * quando um card sai sem nunca ter chamado `report`: marca a task, fecha
 * participação, e NÃO digita / NÃO dispara popup. O orquestrador vê
 * `card_status: exited` e o status novo via `get_task`.
 */
type ConnectorRow = { kind: string | null; from_card_id: string; to_card_id: string; updated_at: number };
type FakeTaskRow = { id: string; card_id: string | null; status: string };

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: notifyHumanMovedTask (peça 3, decisão 5 — o card vinculado é avisado)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-drag-notify-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        ...overrides,
      }),
    );
    return bus;
  }

  it("card vivo e terminal: entrega a mensagem exata (texto + Enter), mesmo formato de send_to_card", async () => {
    const written: Array<[string, string]> = [];
    const b = makeBus({
      isCardAlive: (id: string) => id === "impl-1",
      listCards: () => [{ id: "impl-1", kind: "terminal" }],
      writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
    });

    await b.notifyHumanMovedTask("impl-1", '[de: você] moveu esta task para "em andamento".');

    expect(written).toHaveLength(2);
    expect(written[0]).toEqual(["impl-1", '[de: você] moveu esta task para "em andamento".']);
    expect(written[1]).toEqual(["impl-1", "\r"]);
  });

  it("card morto: nada é escrito, nada estoura", async () => {
    const written: unknown[][] = [];
    const b = makeBus({
      isCardAlive: () => false,
      listCards: () => [{ id: "impl-2", kind: "terminal" }],
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    let threw = false;
    try {
      await b.notifyHumanMovedTask("impl-2", "irrelevante");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("card vivo mas NÃO é terminal (ex.: card de chat ao vivo do usuário): nada é escrito", async () => {
    const written: unknown[][] = [];
    const b = makeBus({
      isCardAlive: () => true,
      listCards: () => [{ id: "impl-3", kind: "chat" }],
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    await b.notifyHumanMovedTask("impl-3", "irrelevante");

    expect(written).toHaveLength(0);
  });
});

describe("message-bus: SINAL 2 — resolveCardExit marca a task e NÃO avisa o spawner por PTY/popup", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-exit-notify-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        getReport: () => undefined,
        listTasks: () => [] as FakeTaskRow[],
        upsertTask: () => ({ status: "failed", statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null }),
        getCardBoardId: () => undefined,
        ...overrides,
      }),
    );
    return bus;
  }

  // ACHADO DE REVIEW ADVERSARIAL (RODADA 2, achado 3, MÉDIO) — a versão
  // anterior avisava o spawner pra QUALQUER card sem report, mesmo um
  // "card de apoio" que nunca teve task vinculada e nunca passou por
  // `spawn_agent` (ex.: um `files`/`browser` aberto via `spawn_card` só
  // pra olhar algo). Ruído aqui faz o sinal ser ignorado — o oposto do
  // que ele existe pra fazer. Este teste é a confirmação de que esse
  // falso positivo específico foi cortado.
  it("[qualificação, achado 3] card de apoio SEM task vinculada e SEM linhagem de spawn_agent: NÃO escreve no PTY", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-e1", to_card_id: "child-e1", updated_at: Date.now() }];
    const written: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "spawner-e1",
      describeCardLabel: (id: string) => id,
      listCards: () => [{ id: "spawner-e1", kind: "terminal" }],
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    b.resolveCardExit("child-e1", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written).toHaveLength(0);
  });

  it("[qualificação] COM task vinculada (mesmo 'done'): NÃO digita no PTY do spawner — o canal era o popup+Enter, e saiu", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-e5", to_card_id: "child-e5", updated_at: Date.now() }];
    const written: Array<[string, string]> = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "spawner-e5",
      describeCardLabel: (id: string) => (id === "child-e5" ? "Implementer" : id),
      listCards: () => [{ id: "spawner-e5", kind: "terminal" }],
      listTasks: () => [{ id: "task-5", card_id: "child-e5", status: "done" }] as FakeTaskRow[],
      writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
    });

    b.resolveCardExit("child-e5", 1);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(written).toHaveLength(0);
  });

  it("[qualificação] SEM task vinculada, mas com LINHAGEM de spawn_agent: tampouco digita", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "orchestrator-1", to_card_id: "agent-x", updated_at: Date.now() }];
    const written: unknown[][] = [];
    let b: ReturnType<typeof createMessageBus> | null = null;
    b = makeBus({
      onSpawnAgentRequest: (requestId: string) => b?.resolveSpawnAgent(requestId, { ok: true, cardId: "agent-x" }),
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "orchestrator-1",
      describeCardLabel: (id: string) => id,
      listCards: () => [{ id: "orchestrator-1", kind: "terminal" }],
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    await b.handleRequest({ cmd: "spawn_agent", requesterId: "", provider: "claude" } as BusRequest);

    b.resolveCardExit("agent-x", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written).toHaveLength(0);
  });

  it("[qualificação] linhagem de spawn_agent MAS provider bash: NÃO escreve — bash não tem MCP/report", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "orchestrator-2", to_card_id: "bash-x", updated_at: Date.now() }];
    const written: unknown[][] = [];
    let b: ReturnType<typeof createMessageBus> | null = null;
    b = makeBus({
      onSpawnAgentRequest: (requestId: string) => b?.resolveSpawnAgent(requestId, { ok: true, cardId: "bash-x" }),
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "orchestrator-2",
      describeCardLabel: (id: string) => id,
      getAnyCard: (id: string) => (id === "bash-x" ? { boardId: "b1", kind: "terminal", provider: "bash" } : undefined),
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    await b.handleRequest({ cmd: "spawn_agent", requesterId: "", provider: "bash" } as BusRequest);

    b.resolveCardExit("bash-x", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written).toHaveLength(0);
  });

  it("card JÁ reportou (getReport devolve algo): nenhum aviso de saída-sem-relatório, mesma condição que já protege o failed derivado", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-e2", to_card_id: "child-e2", updated_at: Date.now() }];
    const written: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => true,
      describeCardLabel: (id: string) => id,
      listCards: () => [{ id: "spawner-e2", kind: "terminal" }],
      getReport: () => ({ card_id: "child-e2", seq: 1, report_json: "{}", updated_at: Date.now() }),
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    b.resolveCardExit("child-e2", 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written).toHaveLength(0);
  });

  it("sem conector de spawn (card aberto por um humano): ninguém é avisado, sem erro", async () => {
    const written: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => [] as ConnectorRow[],
      describeCardLabel: (id: string) => id,
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    expect(() => b.resolveCardExit("human-opened", 1)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(0);
  });

  it("spawner morto: não avisa e não lança", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "dead-spawner", to_card_id: "child-e3", updated_at: Date.now() }];
    const written: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => false,
      describeCardLabel: (id: string) => id,
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    expect(() => b.resolveCardExit("child-e3", 1)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(0);
  });

  it("task running vinculada a este card volta pra 'pending' (interrompida) no mesmo evento do exit — sem depender de aviso digitado", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-e4", to_card_id: "child-e4", updated_at: Date.now() }];
    const upserted: FakeTaskRow[] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => true,
      describeCardLabel: (id: string) => id,
      listCards: () => [],
      listTasks: () => [{ id: "task-1", card_id: "child-e4", status: "running" }] as FakeTaskRow[],
      upsertTask: (task: unknown) => { upserted.push(task as FakeTaskRow); return { status: (task as FakeTaskRow).status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null }; },
    });

    b.resolveCardExit("child-e4", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(upserted).toHaveLength(1);
    expect(upserted[0].status).toBe("pending");
    const result = JSON.parse(String((upserted[0] as { result_json?: string }).result_json ?? "{}")) as { failureKind?: string };
    expect(result.failureKind).toBe("interrompida");
  });
});

/**
 * DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" — os DOIS
 * choke points que chamam `callbacks.recordParticipationRound` (a escrita de
 * verdade mora em `store.ts`, coberta contra banco real em
 * `task-verdicts.test.ts`; aqui é só a GARANTIA de que os dois lugares
 * certos chamam, com os argumentos certos, e nenhum outro). Mesmo padrão de
 * Proxy no-op + spy pontual que os blocos acima já usam.
 */
describe("message-bus: histórico de veredito por participação — os dois choke points chamam recordParticipationRound", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-verdict-history-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        ...overrides,
      }),
    );
    return bus;
  }

  it("cmd 'report' COM verdict: chama recordParticipationRound(cardId, verdict, at) exatamente 1 vez", async () => {
    const calls: unknown[][] = [];
    const b = makeBus({ listAllConnectors: () => [] as ConnectorRow[], recordParticipationRound: (...args: unknown[]) => calls.push(args) });

    await b.handleRequest({ cmd: "report", requesterId: "card-r1", report: { ok: true }, verdict: "aprovado" } as BusRequest);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("card-r1");
    expect(calls[0][1]).toBe("aprovado");
    expect(typeof calls[0][2]).toBe("number");
  });

  it("cmd 'report' com verdict só no JSON (forma acbridge): a rodada fecha com o valor tipado, não null", async () => {
    const calls: unknown[][] = [];
    const b = makeBus({ listAllConnectors: () => [] as ConnectorRow[], recordParticipationRound: (...args: unknown[]) => calls.push(args) });

    await b.handleRequest({ cmd: "report", requesterId: "card-r-cli", report: { ok: true, verdict: "reprovado" } } as BusRequest);

    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("reprovado");
  });

  it("cmd 'report' SEM verdict: a rodada ainda fecha, com verdict null (não pula a chamada) — 'terminou sem veredito' é um resultado real, não ausência de evento", async () => {
    const calls: unknown[][] = [];
    const b = makeBus({ listAllConnectors: () => [] as ConnectorRow[], recordParticipationRound: (...args: unknown[]) => calls.push(args) });

    await b.handleRequest({ cmd: "report", requesterId: "card-r2", report: { ok: true } } as BusRequest);

    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBeNull();
  });

  it("resolveCardExit, SINAL 2 (card esperado a reportar, saiu sem NUNCA reportar): chama recordParticipationRound(cardId, null, at)", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-v1", to_card_id: "child-v1", updated_at: Date.now() }];
    const calls: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "spawner-v1",
      describeCardLabel: (id: string) => id,
      listCards: () => [{ id: "spawner-v1", kind: "terminal" }],
      getReport: () => undefined,
      listTasks: () => [{ id: "task-v1", card_id: "child-v1", status: "done" }] as FakeTaskRow[],
      listTaskCardsForCard: () => [{ task_id: "task-v1", card_id: "child-v1", role: "implementer" }],
      recordParticipationRound: (...args: unknown[]) => calls.push(args),
    });

    b.resolveCardExit("child-v1", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["child-v1", null, calls[0][2]]);
    expect(typeof calls[0][2]).toBe("number");
  });

  it("resolveCardExit, card JÁ reportou (getReport devolve algo): NÃO fecha uma segunda rodada nesta saída — mesma condição que já protege o aviso ao spawner", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-v2", to_card_id: "child-v2", updated_at: Date.now() }];
    const calls: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => true,
      describeCardLabel: (id: string) => id,
      listCards: () => [{ id: "spawner-v2", kind: "terminal" }],
      getReport: () => ({ card_id: "child-v2", seq: 1, report_json: "{}", updated_at: Date.now() }),
      recordParticipationRound: (...args: unknown[]) => calls.push(args),
    });

    b.resolveCardExit("child-v2", 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(0);
  });

  it("resolveCardExit, card de apoio SEM task vinculada e SEM linhagem de spawn_agent: NÃO fecha rodada nenhuma — mesma qualificação do aviso ao spawner, não uma nova", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-v3", to_card_id: "child-v3", updated_at: Date.now() }];
    const calls: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "spawner-v3",
      describeCardLabel: (id: string) => id,
      listCards: () => [{ id: "spawner-v3", kind: "terminal" }],
      getReport: () => undefined,
      listTasks: () => [] as FakeTaskRow[],
      listTaskCardsForCard: () => [],
      recordParticipationRound: (...args: unknown[]) => calls.push(args),
    });

    b.resolveCardExit("child-v3", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(0);
  });

  it("resolveCardExit, card secundário com papel próprio: fecha a participação mesmo sem aviso ao spawner", async () => {
    const calls: unknown[][] = [];
    const b = makeBus({
      getReport: () => undefined,
      listTasks: () => [] as FakeTaskRow[],
      listTaskCardsForCard: () => [{ task_id: "task-review", card_id: "review-card", role: "reviewer" }],
      recordParticipationRound: (...args: unknown[]) => calls.push(args),
    });

    b.resolveCardExit("review-card", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["review-card", null, calls[0][2]]);
    expect(typeof calls[0][2]).toBe("number");
  });
});
