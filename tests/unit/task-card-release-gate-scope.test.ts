import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type CardRow, type TaskRow } from "../../src/main/store";

/**
 * ESCOPO DO GATE DE LIBERAÇÃO (review seq 607 — reprovação da e8802e32).
 *
 * O furo medido ao vivo: `decideTaskCardRelease` lia o papel do requisitante
 * de `listTaskCardsForCard(requesterId)` — conjunto VIVO mas CEGO À TASK.
 * "Sou reviewer em OUTRA task" é o estado normal de um card reciclado, e o
 * `find()` na primeira linha devolvia esse papel como se fosse o papel NESTA
 * task → ALLOW → o implementer da task viva liberava a si mesmo.
 *
 * Quatro provas, cada uma nascida contra o código furado:
 *   A) o cenário medido no board vivo (bus + store real);
 *   B) principal sem linha em `task_cards` (o estado das 7 órfãs) — a recusa
 *      tem de nomear a regra, não morrer por acaso no store;
 *   C) filtro de task terminada no conjunto VIVO — implementer de task done
 *      sai; reviewer de task done PERMANECE (o caso 494→ef31 é pin);
 *   D) ORDER BY determinístico — `find()` numa lista sem ordem é sorte;
 *   E/F) o status da liberação entra NO FUNIL (`upsertTask` →
 *      `decideStatusWrite`): transição `kind:status` registrada e decisão
 *      humana respeitada (hold + divergência), nunca UPDATE cru.
 */

function makeCard(id: string, boardId = "b1"): CardRow {
  const now = Date.now();
  return {
    id,
    board_id: boardId,
    kind: "terminal",
    provider: "claude",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: now,
    messages_json: null,
    archived_at: null,
    created_at: now,
  };
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id: "t1",
    prompt: "faz X",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
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
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildRig(dir: string) {
  const store = openStore(dir);
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
      isBoardAutonomous: () => false,
      getBoardOrchestratorCardId: (boardId: string) => store.getBoard(boardId)?.orchestrator_card_id ?? null,
      isCardAlive: () => true,
      countRunningAgentsOnBoard: () => 0,
      getBoardConcurrencyCap: () => 4,
      listCards: () => store.listCards("b1"),
      listAllConnectors: () => store.listAllConnectors(),
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
  const bus = createMessageBus(join(dir, "release-scope.sock"), callbacks);
  return { store, bus };
}

describe("gate de liberação escopado À TASK (seq 607)", () => {
  let dir: string;
  let rig: ReturnType<typeof buildRig> | null;

  afterEach(() => {
    rig?.bus.close();
    rig = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("A1) CENÁRIO MEDIDO: implementer na task viva com vínculos de reviewer em tasks done — recusa NOMEANDO o papel", async () => {
    dir = mkdtempSync(join(tmpdir(), "release-scope-a1-"));
    rig = buildRig(dir);
    const { store, bus } = rig;
    // O card existe (created_at antigo) — é o que torna as linhas de task
    // done VIVAS pelo critério de época: exatamente o estado medido.
    store.upsertCard({ ...makeCard("rc"), created_at: Date.now() - 10000 });
    store.upsertTask(baseTask({ id: "done-a", status: "done" }));
    store.upsertTask(baseTask({ id: "done-b", status: "done" }));
    store.upsertTask(baseTask({ id: "t1", status: "running", card_id: "rc" }));
    store.linkTaskCard("done-a", "rc", "reviewer");
    store.linkTaskCard("done-b", "rc", "reviewer");
    store.linkTaskCard("t1", "rc", "implementer");
    // Pré-condição do estado medido: o conjunto vivo do card contém linhas
    // de REVIEWER de task terminada E a linha de implementer da task viva.
    // (A ORDEM entre elas é o próprio defeito — find() sem ordem é sorte —
    // então a prova determinística do furo é A2, não esta.)
    const live = store.listTaskCardsForCard("rc").map((l) => l.role);
    expect(live).toContain("reviewer");
    expect(live).toContain("implementer");

    const res = (await bus.handleRequest({
      cmd: "release_task_card",
      taskId: "t1",
      target: "rc",
      reason: "tentativa de auto-liberação",
      requesterId: "rc",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("implementer");
    expect(res.error).toContain("Nothing was written");
    // NADA foi gravado: a linha continua participante viva.
    expect(store.getTaskCards("t1").find((l) => l.card_id === "rc")?.released_at ?? null).toBeNull();
    expect(store.getTask("t1")?.card_id).toBe("rc");
  });

  it("A2) SONDA DETERMINÍSTICA (seq 607): o papel dado ao gate é o DA TASK — sem isso a recusa morre 'por acaso' no alvo", async () => {
    dir = mkdtempSync(join(tmpdir(), "release-scope-a2-"));
    rig = buildRig(dir);
    const { store, bus } = rig;
    // O mesmo estado de board, com a linha de implementer REMOVIDA (o
    // formato legado das 7 órfãs): o conjunto vivo do card fica SÓ com
    // reviewers de tasks done — ordem irrelevante, TODAS são reviewer.
    store.upsertCard({ ...makeCard("rc"), created_at: Date.now() - 10000 });
    store.upsertTask(baseTask({ id: "done-a", status: "done" }));
    store.upsertTask(baseTask({ id: "done-b", status: "done" }));
    store.upsertTask(baseTask({ id: "t1", status: "running", card_id: "rc" }));
    store.linkTaskCard("done-a", "rc", "reviewer");
    store.linkTaskCard("done-b", "rc", "reviewer");
    store.linkTaskCard("t1", "rc", "implementer");
    {
      const raw = new Database(join(dir, "agent-canvas.db"));
      raw.prepare("DELETE FROM task_cards WHERE task_id = 't1' AND card_id = 'rc'").run();
      raw.close();
    }
    expect(store.listTaskCardsForCard("rc").map((l) => l.role)).toEqual(["reviewer", "reviewer"]);

    const res = (await bus.handleRequest({
      cmd: "release_task_card",
      taskId: "t1",
      target: "rc",
      reason: "tentativa de auto-liberação",
      requesterId: "rc",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // HOJE o gate ALLOW (lê "reviewer" como se fosse o papel NESTA task) e a
    // recusa vem do store por acaso ("not a live participant") — exatamente
    // o que a sonda ao vivo mediu. O correto: o principal da task É o
    // implementer de fato (leitura da 1547), e o gate nomeia a regra.
    expect(res.error).toContain("implementer");
    expect(res.error).toContain("Nothing was written");
  });

  it("B) principal SEM linha em task_cards (o estado das 7 órfãs) não se auto-libera — a recusa nomeia a regra", async () => {
    dir = mkdtempSync(join(tmpdir(), "release-scope-b-"));
    rig = buildRig(dir);
    const { store, bus } = rig;
    store.upsertCard({ ...makeCard("rc2"), created_at: Date.now() - 10000 });
    store.upsertTask(baseTask({ id: "t2", status: "running", card_id: "rc2" }));
    // Estado legado medido (task com card_id e sem NENHUMA linha em
    // task_cards): remove a linha que o upsert cria hoje.
    {
      const raw = new Database(join(dir, "agent-canvas.db"));
      raw.prepare("DELETE FROM task_cards WHERE task_id = 't2' AND card_id = 'rc2'").run();
      raw.close();
    }
    expect(store.getTaskCards("t2")).toHaveLength(0);

    const res = (await bus.handleRequest({
      cmd: "release_task_card",
      taskId: "t2",
      target: "rc2",
      reason: "tentativa de auto-liberação",
      requesterId: "rc2",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // O que não vale: recusar por ACASO ("not a live participant") — o
    // principal da task É o implementer de fato (mesma leitura da 1547).
    expect(res.error).toContain("implementer");
    expect(res.error).toContain("Nothing was written");
  });
});

describe("conjunto VIVO de task_cards: ordem e task terminada (seq 607)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("C) implementer de task DONE sai do vivo; reviewer de task done permanece (pin 494→ef31)", () => {
    dir = mkdtempSync(join(tmpdir(), "release-scope-c-"));
    store = openStore(dir);
    store.upsertCard({ ...makeCard("c1"), created_at: Date.now() - 10000 });
    // Task done com principal c1: o upsert cria a linha implementer (viva
    // pela época hoje — é o vazamento).
    store.upsertTask(baseTask({ id: "d1", status: "done", card_id: "c1" }));
    store.upsertTask(baseTask({ id: "d2", status: "done" }));
    store.linkTaskCard("d2", "c1", "reviewer");
    const live = store.listTaskCardsForCard("c1").map((l) => l.task_id);
    // A participação de implementer TERMINOU com a task; não é mais viva.
    expect(live).not.toContain("d1");
    // O reviewer pós-done continua vivo — é o caso medido que a época existe
    // para proteger (veredito de reviewer em task já done).
    expect(live).toContain("d2");
  });

  it("D) ORDER BY determinístico (linked_at ASC, rowid ASC): find() não é sorte", () => {
    dir = mkdtempSync(join(tmpdir(), "release-scope-d-"));
    store = openStore(dir);
    store.upsertCard({ ...makeCard("c2"), created_at: 1000 });
    store.upsertTask(baseTask({ id: "e1", status: "running" }));
    store.upsertTask(baseTask({ id: "e2", status: "running" }));
    store.linkTaskCard("e1", "c2", "reviewer");
    store.linkTaskCard("e2", "c2", "reviewer");
    // Insere na ordem CONTRÁRIA dos vínculos (e1 primeiro, vínculo mais novo).
    {
      const raw = new Database(join(dir, "agent-canvas.db"));
      raw.prepare("UPDATE task_cards SET linked_at = 3000 WHERE task_id = 'e1' AND card_id = 'c2'").run();
      raw.prepare("UPDATE task_cards SET linked_at = 2000 WHERE task_id = 'e2' AND card_id = 'c2'").run();
      raw.close();
    }
    // Store reaberto: a leitura tem de vir ordenada pelo vínculo, não pela
    // ordem de inserção.
    store.close();
    store = openStore(dir);
    expect(store.listTaskCardsForCard("c2").map((l) => l.task_id)).toEqual(["e2", "e1"]);
  });
});

describe("status da liberação passa pelo FUNIL (seq 607)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("E) a volta a pending registra transição kind:status (2 → 3, não 2 → 2)", () => {
    dir = mkdtempSync(join(tmpdir(), "release-scope-e-"));
    store = openStore(dir);
    // CAMADA 3 nunca persiste `running` (coerce para `pending`), então o
    // cenário de mudança real é o MEDIDO (seq 607): um `failed` gravado por
    // ator agente (o hold humano é o teste F) vira `pending` — com rastro.
    store.upsertCard({ ...makeCard("old") });
    store.upsertTask(baseTask({ id: "t3", status: "pending", card_id: "old" }));
    store.linkTaskCard("t3", "old", "implementer");
    const cur = store.getTask("t3")!;
    store.upsertTask({ ...cur, status: "failed", actor: "agent", statusProposed: true });
    const before = store.getTaskTransitions("t3").length;

    const res = store.releaseTaskCardFromTask({
      taskId: "t3",
      cardId: "old",
      reason: "sem sucessor",
      releasedBy: "orch",
      actor: "agent",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.taskStatus).toBe("pending");
    expect(store.getTask("t3")?.status).toBe("pending");
    const trans = store.getTaskTransitions("t3");
    expect(trans.length).toBe(before + 1);
    expect(trans[trans.length - 1]).toEqual(
      expect.objectContaining({ kind: "status", from_value: "failed", to_value: "pending" }),
    );
  });

  it("F) decisão humana NÃO é atropelada: hold com divergência declarada, nunca UPDATE cru", () => {
    dir = mkdtempSync(join(tmpdir(), "release-scope-f-"));
    store = openStore(dir);
    store.upsertCard({ ...makeCard("oldf") });
    store.upsertTask(baseTask({ id: "t4", status: "running", card_id: "oldf" }));
    store.linkTaskCard("t4", "oldf", "implementer");
    const cur = store.getTask("t4")!;
    store.upsertTask({ ...cur, status: "failed", actor: "human", statusProposed: true });
    expect(store.getTask("t4")?.status).toBe("failed");

    const res = store.releaseTaskCardFromTask({
      taskId: "t4",
      cardId: "oldf",
      reason: "implementer saiu",
      releasedBy: "orch",
      actor: "agent",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // O hold humano vale: failed permanece; o pending vira DIVERGÊNCIA
    // declarada (visível na Fila), não sobrescrita silenciosa.
    expect(res.taskStatus).toBe("failed");
    expect(store.getTask("t4")?.status).toBe("failed");
    expect(store.getTask("t4")?.diverged_status).toBe("pending");
    expect(store.getTask("t4")?.diverged_actor).toBe("agent");
    // O rastro existe: declaration para o pending que o app queria.
    const trans = store.getTaskTransitions("t4");
    expect(trans[trans.length - 1]).toEqual(
      expect.objectContaining({ kind: "declaration", to_value: "pending" }),
    );
  });
});
