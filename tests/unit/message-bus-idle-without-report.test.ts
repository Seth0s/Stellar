import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { IDLE_WITHOUT_REPORT_MS } from "../../src/main/idle-without-report-decision";
import {
  unreportedIdlePointerBody,
  unreportedNoAgentPointerBody,
  unreportedUnprovenIdlePointerBody,
} from "../../src/main/agent-facing-authorship";

/**
 * SINAL 3 — bus wiring: scanIdleWithoutReport notifies the spawner once,
 * skips has-report / no-task / judgment, and does not re-fire after report.
 * Consent skip is covered in idle-without-report-decision.test.ts (pure gate);
 * the bus feeds `waitingOnConsent.has` into that same gate.
 */

type FakeTaskRow = {
  id: string;
  card_id: string | null;
  status: string;
  result_json?: string | null;
  retry_count?: number;
  max_retries?: number | null;
};

type FakeReportRow = { card_id: string; seq: number; report_json: string; updated_at: number };

/** A frase do silêncio DECLARADO (turno encerrado pelo card) — só os dois
 * testes de `declaredIdle` abaixo a esperam. */
const IDLE_POINTER = unreportedIdlePointerBody();
/** A frase do silêncio INFERIDO (só o relógio). O duble deixa o card quieto por
 * `IDLE_WITHOUT_REPORT_MS + 1s` → 3min na frase. */
const UNPROVEN_POINTER = unreportedUnprovenIdlePointerBody(IDLE_WITHOUT_REPORT_MS + 1_000);
const NO_AGENT_POINTER = unreportedNoAgentPointerBody();

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  const reportsByCard = new Map<string, FakeReportRow[]>();
  const reportDefaults: Record<string, (...args: never[]) => unknown> = {
    getReport: ((cardId: string, afterSeq?: number) => {
      const rows = reportsByCard.get(cardId) ?? [];
      if (afterSeq === undefined) return rows.length ? rows[rows.length - 1] : undefined;
      return rows.find((r) => r.seq > afterSeq);
    }) as never,
    upsertReport: ((row: FakeReportRow) => {
      const rows = reportsByCard.get(row.card_id) ?? [];
      rows.push(row);
      reportsByCard.set(row.card_id, rows);
    }) as never,
    nextReportSeqSeed: (() => 0) as never,
    listTasks: (() => [] as FakeTaskRow[]) as never,
    listTaskCardsForCard: (() => []) as never,
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        // PERF (task 9dd877c8) — o scan de idle passou a ler
        // `listTasksForIdleScan` (linha mínima: id/card_id/status) em vez da
        // tabela inteira. O `FakeTaskRow` daqui JÁ é essa forma mínima, então
        // rotear os dois para o mesmo duble mantém uma única fonte de dados de
        // task no teste, em vez de duplicar o array em 4 overrides.
        const key = prop === "listTasksForIdleScan" ? "listTasks" : prop;
        return overrides[key] ?? reportDefaults[key] ?? (() => undefined);
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: SINAL 3 — idle without report notifies spawner once", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-idle-wo-report-"));
    const written: Array<[string, string]> = [];
    const lastActivity = Date.now() - IDLE_WITHOUT_REPORT_MS - 1_000;
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: () => [
          { id: "spawner-1", kind: "terminal", provider: "claude", cwd: "", label: "MASTER", displayName: "MASTER" },
          { id: "worker-1", kind: "terminal", provider: "cursor", cwd: "", label: "worker", displayName: "worker" },
        ],
        writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
        isCardAlive: (id: string) => id === "spawner-1" || id === "worker-1",
        getCardLastActivityAt: (id: string) => (id === "worker-1" ? lastActivity : Date.now()),
        getCardWriteReadiness: () => ({
          spawnedAtMs: Date.now() - 60_000,
          hasReceivedData: true,
          lastActivityAtMs: lastActivity,
          hasPendingHumanInput: false,
          inputLineLastAtMs: null,
        }),
        beginCardDelivery: () => true,
        onReadCardRequest: ((requestId: string) =>
          bus?.resolveReadCard(requestId, { ok: true, text: "" })) as never,
        describeCardLabel: ((id: string) =>
          id === "worker-1" ? "worker" : id === "spawner-1" ? "MASTER" : id) as never,
        listAllConnectors: (() => [
          { kind: "spawned", from_card_id: "spawner-1", to_card_id: "worker-1", updated_at: Date.now() },
        ]) as never,
        listTasks: (() =>
          [
            {
              id: "task-1",
              card_id: "worker-1",
              status: "pending",
              result_json: null,
              retry_count: 0,
              max_retries: 2,
            },
          ] as FakeTaskRow[]) as never,
        upsertTask: () => ({
          status: "pending",
          statusChanged: false,
          divergedStatus: null,
          divergedActor: null,
          recordDeclaration: false,
          warnAgent: false,
          declaredStatus: null,
        }),
        ...overrides,
      }),
    );
    return { bus: bus!, written };
  }

  async function waitForBodies(written: Array<[string, string]>, min: number, timeoutMs = 4000): Promise<string[]> {
    const start = Date.now();
    for (;;) {
      const bodies = written.filter(([, data]) => data !== "\r").map(([, data]) => data);
      if (bodies.length >= min) return bodies;
      if (Date.now() - start >= timeoutMs) return bodies;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  it("idle + linked + no report → one pointer on the spawner; second scan does not double-fire; worker untouched", async () => {
    const { bus: b, written } = makeBus();
    b.scanIdleWithoutReport();
    b.scanIdleWithoutReport();
    const bodies = await waitForBodies(written, 1);
    const idleLines = bodies.filter((t) => t.includes(UNPROVEN_POINTER));
    expect(idleLines).toHaveLength(1);
    expect(idleLines[0]).toBe(`[de: worker] ${UNPROVEN_POINTER}`);
    expect(written.filter(([id, data]) => id === "worker-1" && data !== "\r")).toHaveLength(0);
    expect(written.filter(([id, data]) => id === "spawner-1" && data.includes(UNPROVEN_POINTER))).toHaveLength(1);
  });

  it("has report (healthy idle waiting for follow-up) → skip", async () => {
    const { bus: b, written } = makeBus({
      getReport: (() => ({
        card_id: "worker-1",
        seq: 1,
        report_json: JSON.stringify({ ok: true }),
        updated_at: Date.now(),
      })) as never,
    });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 200));
    expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(0);
  });

  it("after notify, accepted report → further idle scans do not re-fire the idle pointer", async () => {
    const { bus: b, written } = makeBus();
    b.scanIdleWithoutReport();
    await waitForBodies(written, 1);
    expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(1);

    await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: true, result: "done" },
    } as BusRequest);
    const afterReport = written.length;
    b.scanIdleWithoutReport();
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 400));
    const newIdle = written.slice(afterReport).filter(([, d]) => d.includes(UNPROVEN_POINTER));
    expect(newIdle).toHaveLength(0);
    expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(1);
  });

  it("no linked task → skip", async () => {
    const { bus: b, written } = makeBus({
      listTasks: (() => [] as FakeTaskRow[]) as never,
    });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 200));
    expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(0);
  });

  it("judgment task (done) → skip", async () => {
    const { bus: b, written } = makeBus({
      listTasks: (() =>
        [{ id: "task-1", card_id: "worker-1", status: "done", result_json: null }] as FakeTaskRow[]) as never,
    });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 200));
    expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(0);
  });

  /**
   * A ÂNCORA DO EPISÓDIO (task a1201078) no bus. Os quatro casos abaixo são o
   * contrato da fiação: a pergunta é "houve report NESTE episódio?" — desde a
   * última vez que o card recebeu trabalho — e não "houve report na vida?".
   */
  describe("com a âncora do episódio (getCardLastWorkGrantedAt)", () => {
    it("já reportou na VIDA, mas o trabalho é NOVO e não houve report → cutuca de novo", async () => {
      // O defeito que abriu a task: o primeiro report do card desarmava o
      // watchdog para sempre, e as falhas seguintes passavam em silêncio.
      const reportAt = Date.now() - 10_000;
      const workGrantedAt = Date.now() - 5_000; // trabalho concedido DEPOIS do report
      const { bus: b, written } = makeBus({
        getCardLastWorkGrantedAt: ((id: string) => (id === "worker-1" ? workGrantedAt : null)) as never,
        getReport: (() => ({
          card_id: "worker-1",
          seq: 7,
          report_json: JSON.stringify({ ok: true }),
          updated_at: reportAt,
        })) as never,
      });

      b.scanIdleWithoutReport();
      const bodies = await waitForBodies(written, 1);
      expect(bodies.filter((t) => t.includes(UNPROVEN_POINTER))).toHaveLength(1);
    });

    it("report DEPOIS do trabalho concedido → este episódio está cumprido, não cutuca", async () => {
      const workGrantedAt = Date.now() - 10_000;
      const reportAt = Date.now() - 5_000;
      const { bus: b, written } = makeBus({
        getCardLastWorkGrantedAt: ((id: string) => (id === "worker-1" ? workGrantedAt : null)) as never,
        getReport: (() => ({
          card_id: "worker-1",
          seq: 8,
          report_json: JSON.stringify({ ok: true }),
          updated_at: reportAt,
        })) as never,
      });

      b.scanIdleWithoutReport();
      await new Promise((r) => setTimeout(r, 200));
      expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(0);
    });

    it("segundo episódio: o MESMO trabalho não cutuca duas vezes, mas uma concessão NOVA re-arma", async () => {
      let workGrantedAt = Date.now() - 5_000;
      const { bus: b, written } = makeBus({
        getCardLastWorkGrantedAt: ((id: string) => (id === "worker-1" ? workGrantedAt : null)) as never,
      });

      b.scanIdleWithoutReport();
      b.scanIdleWithoutReport();
      await waitForBodies(written, 1);
      expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(1);

      // Mesma âncora: continua sendo o mesmo episódio, nada de segundo cutucão.
      b.scanIdleWithoutReport();
      await new Promise((r) => setTimeout(r, 150));
      expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(1);

      // Trabalho concedido de novo (o coordenador mandou outra tarefa):
      // a âncora muda, o episódio re-arma, e a falha seguinte é visível.
      workGrantedAt = Date.now();
      b.scanIdleWithoutReport();
      const bodies = await waitForBodies(written, 2);
      expect(bodies.filter((t) => t.includes(UNPROVEN_POINTER))).toHaveLength(2);
    });

    it("turno DECLARADO (declaredIdle) → cutuca sem esperar o piso de 180s", async () => {
      // Fato declarado de fim de turno com a ÚLTIMA saída ANTES dele: é o
      // `idle` de card-status-decision.ts. O relógio de bytes está em 5s, bem
      // abaixo do piso — e mesmo assim cutuca, porque o fato é declarado.
      const now = Date.now();
      const { bus: b, written } = makeBus({
        getCardLastActivityAt: ((id: string) => (id === "worker-1" ? now - 5_000 : now)) as never,
        getCardTurnEndedAt: ((id: string) => (id === "worker-1" ? now - 1_000 : null)) as never,
      });

      b.scanIdleWithoutReport();
      const bodies = await waitForBodies(written, 1);
      expect(bodies.filter((t) => t.includes(IDLE_POINTER))).toHaveLength(1);
    });

    it("saída DEPOIS do fim de turno (turno novo começou) → não cutuca", async () => {
      const now = Date.now();
      const { bus: b, written } = makeBus({
        getCardLastActivityAt: ((id: string) => (id === "worker-1" ? now : now)) as never,
        getCardTurnEndedAt: ((id: string) => (id === "worker-1" ? now - 1_000 : null)) as never,
      });

      b.scanIdleWithoutReport();
      await new Promise((r) => setTimeout(r, 200));
      expect(written.filter(([, d]) => d.includes(IDLE_POINTER))).toHaveLength(0);
    });
  });

  /**
   * A ÂNCORA AUSENTE EM TEMPO DE EXECUÇÃO (corrida: a entry do PTY sumiu
   * entre o `listTerminalCards()` e a leitura do fato — `getLastWorkGrantedAt`
   * devolve `null` por não haver entry). Este NÃO é mais o caso da janela de
   * fiação (aquela fechou: o callback é obrigatório e o `hasReport` absoluto
   * foi removido): é a guarda de corrida, e o que ela trava é NÃO transformar
   * "não dá para datar o trabalho" em cutucão — um report já gravado conta
   * como o episódio cumprido.
   */
  /**
   * A FIAÇÃO DO "SEM AGENTE LENDO" (task 14b8b224) — o defeito medido no board:
   * quatro cards `provider: bash` VAZIOS, vinculados a tasks, acusados de
   * "idle without calling report" por um agente que nunca existiu. Aqui o card do
   * teste é um shell quieto (prompt livre, tela em branco) e o ponteiro tem de
   * ser o OUTRO — a acusação não pode aparecer.
   *
   * O caso oposto (bash COM TUI dentro → acusação normal) é decidido pelo mesmo
   * fato e está em `card-agent-reader-decision.test.ts`; o card `cursor` do
   * teste acima ("idle + linked + no report → one pointer") é o outro lado vivo
   * desta fiação: provider de agente continua sendo acusado.
   */
  it("card bash VAZIO (prompt livre) → ponteiro de 'sem agente lendo', NUNCA a acusação", async () => {
    const { bus: b, written } = makeBus({
      listCards: () =>
        [
          { id: "spawner-1", kind: "terminal", provider: "claude", cwd: "", label: "MASTER", displayName: "MASTER" },
          { id: "worker-1", kind: "terminal", provider: "bash", cwd: "", label: "worker", displayName: "worker" },
        ] as never,
    });
    b.scanIdleWithoutReport();
    b.scanIdleWithoutReport();
    const bodies = await waitForBodies(written, 1);
    const noAgentLines = bodies.filter((t) => t.includes(NO_AGENT_POINTER));
    expect(noAgentLines).toHaveLength(1);
    expect(noAgentLines[0]).toBe(`[de: worker] ${NO_AGENT_POINTER}`);
    // A frase errada: nenhuma acusação de "não reportou" para quem não tem
    // agente — e nem a inferida, que é a outra ponta da mesma pergunta. É este
    // par de asserções que morre se o fato sumir da fiação.
    expect(bodies.filter((t) => t.includes(UNPROVEN_POINTER))).toHaveLength(0);
    expect(bodies.filter((t) => t.includes(IDLE_POINTER))).toHaveLength(0);
    expect(written.filter(([id, data]) => id === "worker-1" && data !== "\r")).toHaveLength(0);
  });

  it("âncora sem data (corrida) → não cutuca quem já reportou", async () => {
    const { bus: b, written } = makeBus({
      getCardLastWorkGrantedAt: (() => null) as never,
      getReport: (() => ({
        card_id: "worker-1",
        seq: 9,
        report_json: JSON.stringify({ ok: true }),
        updated_at: Date.now(),
      })) as never,
    });
    b.scanIdleWithoutReport();
    await new Promise((r) => setTimeout(r, 200));
    expect(written.filter(([, d]) => d.includes(UNPROVEN_POINTER))).toHaveLength(0);
  });
});
