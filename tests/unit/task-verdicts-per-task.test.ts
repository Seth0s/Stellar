import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * `task_verdicts` CARIMBAVA O VEREDITO EM TODOS OS VÍNCULOS VIVOS DO CARD
 * (task 1172cb32, medido no banco vivo em 2026-09-21).
 *
 * O sítio da escrita (`store.ts`'s `recordParticipationRound`) iterava os
 * vínculos do card e gravava UMA LINHA POR VÍNCULO, com o mesmo `verdict` e o
 * mesmo `at` — e o chamador do `report` nem passava a task que o preflight da
 * 6bea994a já tinha resolvido. Consequência medida: das **481 linhas com
 * veredito**, **364 (75,7%) apontavam para uma task que o report nunca
 * declarou** — a tabela de auditoria dizia que um revisor reprovou trabalho
 * que ele aprovou.
 *
 * O que estes testes prendem:
 *   - a rodada do REPORT é de UMA task: só ela ganha linha (e a MUTAÇÃO prova
 *     que é a declaração que decide, não o fan-out);
 *   - a rodada da SAÍDA (card morre sem reportar) NÃO sabe de qual task é, e
 *     ali o fan-out é a verdade — a assimetria é o conserto, não um resto dele.
 */

const CARD = "card-revisor";

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    // NÃO terminal: um vínculo vivo é o que dá sentido ao fan-out, e é o
    // estado em que o defeito foi medido.
    status: "pending",
    card_id: null,
    board_id: "default",
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
  } as TaskRow;
}

function callbacksBackedByStore(store: ReturnType<typeof openStore>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
        if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
        if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
        if (prop === "listTaskCardsForCard") return (cardId: string) => store.listTaskCardsForCard(cardId);
        if (prop === "getTaskCards") return (taskId: string) => store.getTaskCards(taskId);
        if (prop === "recordParticipationRound")
          return (cardId: string, verdict: string | null, at: number, taskId?: string | null) =>
            store.recordParticipationRound(cardId, verdict, at, taskId);
        if (prop === "listTasks") return () => store.listTasks();
        if (prop === "getTask") return (id: string) => store.getTask(id);
        if (prop === "upsertTask") return (row: TaskRow) => store.upsertTask(row);
        if (prop === "isCardAlive") return () => true;
        if (prop === "listCards") return () => [];
        if (prop === "describeCardLabel") return (id: string) => `card ${id}`;
        if (prop === "getCardBoardId") return () => "default";
        if (prop === "getBoardOrchestratorCardId") return () => null;
        if (prop === "getBoardCwd") return () => undefined;
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("task_verdicts — a rodada do report é de UMA task (1172cb32)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Card com TRÊS vínculos vivos: A e B como reviewer, C como implementer. */
  function setup() {
    dir = mkdtempSync(join(tmpdir(), "stellar-verdict-scope-"));
    store = openStore(dir);
    bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store));
    const a = baseTask("task-a");
    const b = baseTask("task-b");
    const c = baseTask("task-c");
    for (const task of [a, b, c]) store.upsertTask(task);
    store.linkTaskCard(a.id, CARD, "reviewer");
    store.linkTaskCard(b.id, CARD, "reviewer");
    store.linkTaskCard(c.id, CARD, "implementer");
    return { store, bus, a, b, c };
  }

  it("report com verdict declarando A: SÓ A ganha linha; B e C ficam vazias", async () => {
    const { store: s, bus: b, a, ...rest } = setup();

    const res = (await b.handleRequest({
      cmd: "report",
      requesterId: CARD,
      report: { ok: true, taskId: a.id },
      verdict: "aprovado",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);

    const onA = s.getTaskVerdicts(a.id);
    expect(onA).toHaveLength(1);
    expect(onA[0].verdict).toBe("aprovado");
    expect(onA[0].role).toBe("reviewer");
    // O DEFEITO: estas duas tinham linha "aprovado" que ninguém escreveu.
    expect(s.getTaskVerdicts(rest.b.id)).toEqual([]);
    expect(s.getTaskVerdicts(rest.c.id)).toEqual([]);
  });

  it("MUTAÇÃO: o mesmo report declarando B manda a linha para B — é a DECLARAÇÃO que decide", async () => {
    const { store: s, bus: b, a, b: taskB, c } = setup();

    const res = (await b.handleRequest({
      cmd: "report",
      requesterId: CARD,
      report: { ok: true, taskId: taskB.id },
      verdict: "aprovado",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);

    expect(s.getTaskVerdicts(taskB.id)).toHaveLength(1);
    expect(s.getTaskVerdicts(a.id)).toEqual([]);
    expect(s.getTaskVerdicts(c.id)).toEqual([]);
  });

  it("sem taskId (SAÍDA do card): a rodada continua terminando em TODOS os vínculos", () => {
    // O OUTRO LADO DA ASSIMETRIA, preso de propósito: aqui o card morreu sem
    // reportar, não há task declarada, e todas as participações dele terminam —
    // unificar isto seria trocar um defeito pelo oposto.
    const { store: s, a, b, c } = setup();

    const written = s.recordParticipationRound(CARD, null, 123);

    expect(written.map((row) => row.task_id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(written.every((row) => row.verdict === null)).toBe(true);
  });

  it("com taskId: a rodada termina numa task só, com o papel daQUELA task", () => {
    const { store: s, a, b, c } = setup();

    const written = s.recordParticipationRound(CARD, "aprovado", 456, a.id);

    expect(written).toHaveLength(1);
    expect(written[0].task_id).toBe(a.id);
    expect(written[0].role).toBe("reviewer");
    expect(JSON.stringify(s.getTaskVerdicts(b.id))).toBe("[]");
    expect(JSON.stringify(s.getTaskVerdicts(c.id))).toBe("[]");
  });

  it("O TESTE DO MISS: um report com veredito sem taskId não espalha nada (recusa o estado impossível)", () => {
    const { store: s, a, b, c } = setup();

    let threw = false;
    try {
      s.recordParticipationRound(CARD, "aprovado", 123);
    } catch (e) {
      threw = true;
    }

    // 1. Prova do defeito latente: se a guarda cair, as tabelas não podem ter sujado
    expect(s.getTaskVerdicts(a.id)).toEqual([]);
    expect(s.getTaskVerdicts(b.id)).toEqual([]);
    expect(s.getTaskVerdicts(c.id)).toEqual([]);
    
    // 2. Prova de que a proteção foi ativa (lançou erro) e não mero acidente
    expect(threw).toBe(true);
  });
});
