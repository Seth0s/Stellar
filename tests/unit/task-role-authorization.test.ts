import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type CardRow, type TaskRow } from "../../src/main/store";
import { HUMAN_PRINCIPAL_ID } from "../../src/main/judgment-write-decision";

/**
 * AUTORIA DE PAPEL — as três portas do furo 3 (task 05055482), com as
 * sondas P1/P2 virando teste PERMANENTE. Todas nascem contra o bus SEM os
 * gates (capturado vermelho antes do conserto); depois do conserto, o
 * mordomo é a marca do board (`boards.orchestrator_card_id`) — o mesmo
 * precedente da 5412f61e para `gates`, com a diferença declarada: papel em
 * board SEM marca RECUSA (o custo de aceitar é a disciplina de revisão
 * inteira), enquanto gates aceitam+registram.
 *
 * Fluxos que NÃO podem quebrar (pins verdes antes e depois):
 *   - a marca linka revisor/implementer e troca principal (o fluxo desta
 *     sessão inteira — 136 vínculos em 24h, todos da marca);
 *   - spawn_agent SEM role (o filho implementer do agente);
 *   - spawn_agent {role: reviewer} em board NÃO-autônomo (o modal humano
 *     é a autorização);
 *   - reivindicação de task SEM principal (adoção de órfã).
 */

function makeCard(id: string, boardId = "b1"): CardRow {
  const now = Date.now();
  return {
    id, board_id: boardId, kind: "terminal", provider: "claude", cwd: "/tmp",
    x: 0, y: 0, w: 400, h: 300, resume_id: null, model: null, effort: null,
    system_prompt: null, group_id: null, label: null, updated_at: now,
    messages_json: null, archived_at: null, created_at: now,
  };
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id: "t1", prompt: "faz X", provider: "claude", status: "pending", card_id: null,
    board_id: "b1", cwd: null, result_json: null, deps_json: null, retry_count: 0,
    attempted_providers_json: null, max_retries: null, fallback_providers_json: null,
    order: null, suggested_order: null, implicit_order: null, diverged_status: null,
    diverged_actor: null, created_at: now, updated_at: now, ...overrides,
  };
}

function buildRig(dir: string, opts: { orchestratorCardId?: string | null; autonomous?: boolean } = {}) {
  const store = openStore(dir);
  // A marca mora no board (UI humana) — o rig grava direto no store.
  store.upsertBoard({
    id: "b1", name: "Board b1", project: "", cwd: "", created_at: Date.now(),
    updated_at: Date.now(), last_accessed_at: null, autonomous: opts.autonomous ?? false,
    concurrency_cap: null, orchestrator_card_id: opts.orchestratorCardId ?? null,
  });
  const spawnCalls: Array<Record<string, unknown>> = [];
  const callbacks = new Proxy(
    {
      listTasks: () => store.listTasks(),
      getTask: (id: string) => store.getTask(id),
      upsertTask: (task: TaskRow) => store.upsertTask(task),
      getTaskCards: (taskId: string) => store.getTaskCards(taskId),
      listTaskCardsForCard: (cardId: string) => store.listTaskCardsForCard(cardId),
      linkTaskCard: (taskId: string, cardId: string, role: string) => store.linkTaskCard(taskId, cardId, role),
      releaseTaskCardFromTask: (input: Parameters<typeof store.releaseTaskCardFromTask>[0]) =>
        store.releaseTaskCardFromTask(input),
      boardExists: () => true,
      getCardBoardId: (id: string) => store.getCard(id)?.board_id,
      isBoardAutonomous: () => opts.autonomous ?? false,
      getBoardOrchestratorCardId: () => opts.orchestratorCardId ?? null,
      isCardAlive: () => true,
      countRunningAgentsOnBoard: () => 0,
      getBoardConcurrencyCap: () => 4,
      listCards: () => store.listCards("b1"),
      listAllConnectors: () => store.listAllConnectors(),
      getReport: () => undefined,
      getAnyCard: (id: string) => store.getCard(id),
      onSpawnAgentRequest: ((requestId: string, _requesterId: string, params: Record<string, unknown>) => {
        spawnCalls.push(params);
        // resolve como o UI faria: card criado.
        rig?.bus.resolveSpawnAgent(requestId, { ok: true, cardId: "child-1" });
      }) as never,
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
  const bus = createMessageBus(join(dir, "role-auth.sock"), callbacks);
  const rig = { store, bus, spawnCalls };
  return rig;
}

describe("porta 1 — link_task_card: quem atribui papel (05055482)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("P1 PERMANENTE: card não-marcado NÃO se declara revisor e não fecha a task review=wanted", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-p1-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("rogue"));
    store.upsertCard(makeCard("victim"));
    store.upsertTask(baseTask({ id: "tw", status: "running", card_id: "victim", review: "wanted" }));
    store.linkTaskCard("tw", "victim", "implementer");

    const link = (await bus.handleRequest({
      cmd: "link_task_card", taskId: "tw", cardId: "rogue", role: "reviewer", requesterId: "rogue",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(link.ok).toBe(false);
    if (link.ok) return;
    expect(link.error).toContain("REVIEWER");
    expect(link.error).toContain("Nothing was written");
    // A linha não existe: a auto-atribuição não vira participação.
    expect(store.getTaskCards("tw").find((l) => l.card_id === "rogue")).toBeUndefined();

    // E a cadeia P1 inteira morre: sem papel de revisor, o done é refused
    // pelo gate review="wanted" (CAMADA 4).
    const done = (await bus.handleRequest({
      cmd: "update_task", taskId: "tw", status: "done", requesterId: "rogue",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
    expect(store.getTask("tw")?.status).not.toBe("done");
  });

  it("AGRAVANTE (bypass em dois passos): implementer não se relinka como reviewer para se liberar", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-bypass-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("helper"));
    store.upsertCard(makeCard("principal"));
    store.upsertCard(makeCard("extra"));
    // Task com principal "principal" e DOIS implementers vivos (o card
    // "helper" é implementer NÃO-principal — o caso do agravante).
    store.upsertTask(baseTask({ id: "tb", status: "running", card_id: "principal" }));
    store.linkTaskCard("tb", "principal", "implementer");
    store.linkTaskCard("tb", "helper", "implementer");

    const relink = (await bus.handleRequest({
      cmd: "link_task_card", taskId: "tb", cardId: "helper", role: "reviewer", requesterId: "helper",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(relink.ok).toBe(false);
    // O papel NÃO foi sobrescrito: a linha continua implementer.
    expect(store.getTaskCards("tb").find((l) => l.card_id === "helper")?.role).toBe("implementer");

    const res = (await bus.handleRequest({
      cmd: "release_task_card", taskId: "tb", target: "helper", reason: "auto-liberação", requesterId: "helper",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("implementer");
  });

  it("O ACIDENTE MEDIDO: card não-marcado não linka TERCEIROS (nem o card do orchestrator)", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-acc-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("sloppy"));
    store.upsertCard(makeCard("mark-1"));
    store.upsertTask(baseTask({ id: "tf", status: "pending" }));

    const res = (await bus.handleRequest({
      cmd: "link_task_card", taskId: "tf", cardId: "mark-1", role: "reviewer", requesterId: "sloppy",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(store.getTaskCards("tf")).toHaveLength(0);
  });

  it("REIVINDICAÇÃO: card adota task SEM principal como implementer (o fluxo que fica aberto)", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-claim-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("adopter"));
    store.upsertTask(baseTask({ id: "tc", status: "pending", card_id: null }));

    const res = (await bus.handleRequest({
      cmd: "link_task_card", taskId: "tc", cardId: "adopter", role: "implementer", requesterId: "adopter",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store.getTask("tc")?.card_id).toBe("adopter");
  });

  it("PINS: a marca linka revisor (card não-principal); AUSENCIA de identidade e RECUSADA", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-pins1-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("mark-1"));
    store.upsertCard(makeCard("impl-1"));
    store.upsertCard(makeCard("rev-1"));
    store.upsertTask(baseTask({ id: "tp", status: "running", card_id: "impl-1", review: "wanted" }));
    store.linkTaskCard("tp", "impl-1", "implementer");

    const byMark = (await bus.handleRequest({
      cmd: "link_task_card", taskId: "tp", cardId: "rev-1", role: "reviewer", requesterId: "mark-1",
    } as BusRequest)) as { ok: boolean };
    expect(byMark.ok).toBe(true);
    expect(store.getTaskCards("tp").find((l) => l.card_id === "rev-1")?.role).toBe("reviewer");

    // A versão anterior deixava o anonymous PASSAR, com o argumento de que "si
    // mesmo" não se aplica without identity. O argumento cobre P1 e P2 (onde o
    // ataque é apontar para si), mas não cobre impor vínculo a OUTRO — para
    // isso não é preciso ser ninguém. Medido em 2026-09-22: nem `preload` nem
    // `renderer` expõem esta porta, então o "humano anonymous" não existia como
    // chamador; a permissão só enfraquecia a invariante. Quem opera fora de um
    // card declara `HUMAN_PRINCIPAL_ID`.
    const anonymous = (await bus.handleRequest({
      cmd: "link_task_card", taskId: "tp", cardId: "rev-1", role: "implementer",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(anonymous.ok).toBe(false);
    expect(anonymous.error).toContain("without identity");

    // E o humano NOMEADO passa — a porta distingue "nao disse quem e" de "e o humano".
    const byHuman = (await bus.handleRequest({
      cmd: "link_task_card", taskId: "tp", cardId: "rev-1", role: "reviewer", requesterId: HUMAN_PRINCIPAL_ID,
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(byHuman.ok).toBe(true);
  });
});

describe("porta 2 — update_task {cardId}: quem move o principal (05055482)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("P2 PERMANENTE: card não-marcado NÃO aponta o principal para si mesmo", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-p2-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("rogue2"));
    store.upsertCard(makeCard("victim2"));
    store.upsertTask(baseTask({ id: "tw2", status: "running", card_id: "victim2" }));
    store.linkTaskCard("tw2", "victim2", "implementer");

    const res = (await bus.handleRequest({
      cmd: "update_task", taskId: "tw2", cardId: "rogue2", requesterId: "rogue2",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("principal");
    expect(res.error).toContain("Nothing was written");
    expect(store.getTask("tw2")?.card_id).toBe("victim2");
    // A linha de implementer do ladrão não nasce sozinha.
    expect(store.getTaskCards("tw2").find((l) => l.card_id === "rogue2")).toBeUndefined();
  });

  it("PINS do ponteiro: a marca troca; o próprio principal entrega o bastão; órfã é reivindicável", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-pins2-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("mark-1"));
    store.upsertCard(makeCard("impl-a"));
    store.upsertCard(makeCard("impl-b"));
    store.upsertTask(baseTask({ id: "td", status: "running", card_id: "impl-a" }));
    store.linkTaskCard("td", "impl-a", "implementer");

    const byMark = (await bus.handleRequest({
      cmd: "update_task", taskId: "td", cardId: "impl-b", requesterId: "mark-1",
    } as BusRequest)) as { ok: boolean };
    expect(byMark.ok).toBe(true);
    expect(store.getTask("td")?.card_id).toBe("impl-b");

    // O próprio principal entrega o bastão.
    const handoff = (await bus.handleRequest({
      cmd: "update_task", taskId: "td", cardId: "impl-a", requesterId: "impl-b",
    } as BusRequest)) as { ok: boolean };
    expect(handoff.ok).toBe(true);
    expect(store.getTask("td")?.card_id).toBe("impl-a");

    // Órfã reivindicável: card_id NULL → o card aponta para si.
    store.upsertTask(baseTask({ id: "te", status: "pending", card_id: null }));
    const claim = (await bus.handleRequest({
      cmd: "update_task", taskId: "te", cardId: "impl-b", requesterId: "impl-b",
    } as BusRequest)) as { ok: boolean };
    expect(claim.ok).toBe(true);
    expect(store.getTask("te")?.card_id).toBe("impl-b");
  });
});

describe("porta 3 — spawn_agent {role: reviewer}: quem spawna revisor (05055482)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("BOARD AUTÔNOMO: não-marcado NÃO spawna filho já vinculado revisor (o P1 com um passo a mais)", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-sp1-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1", autonomous: true });
    const { store, bus, spawnCalls } = rig;
    store.upsertCard(makeCard("rogue3"));
    store.upsertCard(makeCard("victim3"));
    store.upsertTask(baseTask({ id: "tw3", status: "running", card_id: "victim3", review: "wanted" }));
    store.linkTaskCard("tw3", "victim3", "implementer");

    const res = (await bus.handleRequest({
      cmd: "spawn_agent", provider: "claude", taskId: "tw3", role: "reviewer",
      brief: "revise", reason: "meu filho revisa", requesterId: "rogue3",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("REVIEWER");
    // NENHUM card foi criado: a recusa acontece ANTES do dispatch/consent.
    expect(spawnCalls).toHaveLength(0);
    expect(store.getTaskCards("tw3").filter((l) => l.role === "reviewer")).toHaveLength(0);
  });

  it("PINS do spawn: implementer não-autônomo e revisor pela marca seguem abertos", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-sp2-"));
    rig = buildRig(dir, { orchestratorCardId: "mark-1", autonomous: true });
    const { store, bus, spawnCalls } = rig;
    store.upsertCard(makeCard("mark-1"));
    store.upsertCard(makeCard("agent-1"));
    store.upsertTask(baseTask({ id: "tw4", status: "running", card_id: "agent-1" }));
    store.linkTaskCard("tw4", "agent-1", "implementer");

    // O filho implementer do agente: o caminho que NÃO pode quebrar.
    const implSpawn = (await bus.handleRequest({
      cmd: "spawn_agent", provider: "claude", taskId: "tw4", reason: "subtarefa", requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean };
    expect(implSpawn.ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);

    // Revisor pela marca em board autônomo: autoridade declarada.
    const markSpawn = (await bus.handleRequest({
      cmd: "spawn_agent", provider: "claude", taskId: "tw4", role: "reviewer",
      brief: "revise", reason: "revisão da tw4", requesterId: "mark-1",
    } as BusRequest)) as { ok: boolean };
    expect(markSpawn.ok).toBe(true);
    expect(spawnCalls).toHaveLength(2);
  });

  it("BOARD NÃO-AUTÔNOMO: o modal humano é a autorização — spawn de revisor segue aberto", async () => {
    dir = mkdtempSync(join(tmpdir(), "role-auth-sp3-"));
    rig = buildRig(dir, { orchestratorCardId: null, autonomous: false });
    const { store, bus, spawnCalls } = rig;
    store.upsertCard(makeCard("agent-2"));
    store.upsertTask(baseTask({ id: "tw5", status: "running", card_id: "agent-2", review: "wanted" }));
    store.linkTaskCard("tw5", "agent-2", "implementer");

    const res = (await bus.handleRequest({
      cmd: "spawn_agent", provider: "claude", taskId: "tw5", role: "reviewer",
      brief: "revise", reason: "revisão da tw5", requesterId: "agent-2",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });
});



describe("porta 3 real — release_task_card: quem libera quem (05055482)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("P3 PERMANENTE: card não-marcado NÃO consegue liberar o implementer de uma task", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-role-auth-p3-"));
    rig = buildRig(dir, { orchestratorCardId: "c-marca" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("c-marca"));
    store.upsertCard(makeCard("c-vitima"));
    store.upsertCard(makeCard("c-terceiro"));

    // Cria task com a vitima como principal
    await bus.handleRequest({ cmd: "create_task", prompt: "X", cardId: "c-vitima", boardId: "b1", requesterId: "c-marca" } as any);
    const task = store.listTasks()[0];
    expect(task.card_id).toBe("c-vitima");

    // O terceiro mal-intencionado tenta liberar a vítima
    const reqRelease = {
      cmd: "release_task_card",
      taskId: task.id,
      target: "c-vitima",
      reason: "roubo de task",
      requesterId: "c-terceiro" // Chamador sem papel e sem marca
    } as const;

    const res = await bus.handleRequest(reqRelease);
    // Deve ser RECUSADO
    expect(res.ok).toBe(false);
    expect((res as any).error).toMatch(/release_task_card.*refused/i);

    // O principal da task continua sendo a vítima
    expect(store.getTask(task.id)?.card_id).toBe("c-vitima");
  });

  it("PINS do release: a marca libera o implementer; o próprio principal não se auto-libera; anonymous passa pelo bypass para cair no erro principal caso seja ilegítimo", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-role-auth-p3-pins-"));
    rig = buildRig(dir, { orchestratorCardId: "c-marca" });
    const { store, bus } = rig;
    store.upsertCard(makeCard("c-marca"));
    store.upsertCard(makeCard("c-vitima"));

    // 1. Vitima nao se auto-libera (o behavior de hoje)
    await bus.handleRequest({ cmd: "create_task", prompt: "X", cardId: "c-vitima", boardId: "b1", requesterId: "c-marca" } as any);
    let task = store.listTasks()[0];
    
    let res = await bus.handleRequest({ cmd: "release_task_card", taskId: task.id, target: "c-vitima", reason: "sair", requesterId: "c-vitima" } as any);
    expect(res.ok).toBe(false);
    expect((res as any).error).toMatch(/implementer.*does not release itself/i);

    // 2. A marca libera a vitima (sucesso)
    res = await bus.handleRequest({ cmd: "release_task_card", taskId: task.id, target: "c-vitima", reason: "expulsar", requesterId: "c-marca" } as any);
    expect(res.ok).toBe(true);
    expect(store.getTask(task.id)?.card_id).toBeNull(); // Vitima foi liberada
  });
});
