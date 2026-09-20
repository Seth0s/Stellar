import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// AGENT-half restore (2026-09-13): `report` persists JSON, wakes waiters,
// AND enqueues a short PTY pointer at the notify target via
// `enqueueCardDelivery`. OS popup callbacks stay absent from Callbacks —
// the type system is the gate that none of idle/report/exit fire one.

type ConnectorRow = { kind: string | null; from_card_id: string; to_card_id: string; updated_at: number };

type FakeReportRow = { card_id: string; seq: number; report_json: string; verdict?: string | null; updated_at: number };

const POINTER_NEEDLE = "relatório disponível — chame read_report";

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
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
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? reportDefaults[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: report persiste JSON e digita o ponteiro no PTY do orquestrador", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-report-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const written: Array<[string, string]> = [];
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
        listCards: () => [{ id: "spawner-1", kind: "terminal" }],
        isCardAlive: () => true,
        describeCardLabel: (id: string) => id,
        listAllConnectors: () => [] as ConnectorRow[],
        beginCardDelivery: () => true,
        getCardWriteReadiness: () => null,
        ...overrides,
      }),
    );
    return { bus, written };
  }

  async function flushDelivery(ms = 400): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForPointers(written: Array<[string, string]>, min: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (written.filter(([, data]) => data.includes(POINTER_NEEDLE)).length >= min) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  it("spawner vivo com conector de spawn: persiste, acorda waiter, E escreve o ponteiro no PTY", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-1", to_card_id: "child-1", updated_at: Date.now() }];
    const { bus: b, written } = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "spawner-1",
      describeCardLabel: (id: string) => (id === "child-1" ? "Child One" : id),
    });

    const waiter = b.handleRequest({ cmd: "get_report", target: "child-1", wait: true, timeoutMs: 2000 } as BusRequest) as Promise<{
      ok: boolean;
      report: unknown;
      seq: number;
    }>;

    const res = (await b.handleRequest({ cmd: "report", requesterId: "child-1", report: { ok: true, result: "done" } } as BusRequest)) as {
      ok: boolean;
      seq: number;
    };

    expect(res.ok).toBe(true);
    expect(res.seq).toBe(1);
    const waited = await waiter;
    expect(waited.ok).toBe(true);
    expect(waited.report).toEqual({ ok: true, result: "done" });

    await flushDelivery();
    const bodyWrites = written.filter(([, data]) => data !== "\r");
    expect(bodyWrites.length).toBeGreaterThanOrEqual(1);
    expect(bodyWrites[0][0]).toBe("spawner-1");
    expect(bodyWrites[0][1]).toContain("[de: Child One]");
    expect(bodyWrites[0][1]).toContain(POINTER_NEEDLE);
    // Ponteiro só — o corpo do relatório não vaza pro PTY.
    expect(bodyWrites[0][1]).not.toContain("done");
  });

  it("waiter ativo: o ponteiro AINDA sai (humano na tela ≠ waiter da tool)", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-1", to_card_id: "child-w", updated_at: Date.now() }];
    const { bus: b, written } = makeBus({
      listAllConnectors: () => connectors,
      describeCardLabel: (id: string) => (id === "child-w" ? "Waiter Child" : id),
    });

    const waiter = b.handleRequest({ cmd: "get_report", target: "child-w", wait: true, timeoutMs: 2000 } as BusRequest) as Promise<{
      ok: boolean;
      report: unknown;
    }>;
    await b.handleRequest({ cmd: "report", requesterId: "child-w", report: { ok: true } } as BusRequest);
    expect((await waiter).ok).toBe(true);

    await flushDelivery();
    expect(written.some(([, data]) => data.includes(POINTER_NEEDLE))).toBe(true);
  });

  it("card sem conector de spawn: ainda persiste, sem erro, sem escrita", async () => {
    const { bus: b, written } = makeBus();
    const res = (await b.handleRequest({ cmd: "report", requesterId: "human-opened-card", report: { ok: true } } as BusRequest)) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    const stored = (await b.handleRequest({ cmd: "get_report", target: "human-opened-card" } as BusRequest)) as {
      ok: boolean;
      report: unknown;
    };
    expect(stored.ok).toBe(true);
    expect(stored.report).toEqual({ ok: true });
    await flushDelivery();
    expect(written).toHaveLength(0);
  });

  it("Callbacks não expõe notify* de SO — o caminho do report só digita", async () => {
    // Regressão do pedido do dono: idle/report/exit sem popup. Se alguém
    // reintroduzir notifyCardReported no tipo Callbacks, este cast deixa
    // de ser o único lugar que afirma a ausência.
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-1", to_card_id: "child-os", updated_at: Date.now() }];
    const { bus: b } = makeBus({ listAllConnectors: () => connectors });
    await b.handleRequest({ cmd: "report", requesterId: "child-os", report: { ok: true } } as BusRequest);
    await flushDelivery();
    const sample = callbacksWithOverrides({});
    expect("notifyCardReported" in sample).toBe(false);
    expect("notifyIdleCard" in sample).toBe(false);
    expect("notifyCardExitedWithoutReport" in sample).toBe(false);
  });

  it("acbridge-shaped: verdict formal no JSON vira a coluna e some do payload", async () => {
    const { bus: b } = makeBus({});
    await b.handleRequest({
      cmd: "report",
      requesterId: "cli-card",
      report: { ok: true, result: "done", verdict: "aprovado" },
    } as BusRequest);

    const stored = (await b.handleRequest({ cmd: "get_report", target: "cli-card" } as BusRequest)) as {
      report: unknown;
      verdict?: string | null;
    };
    expect(stored.verdict).toBe("aprovado");
    expect(stored.report).toEqual({ ok: true, result: "done" });
  });

  it("card amarrado a uma task: report sem taskId ganha o id completo", async () => {
    const taskId = "d5453f98-31d8-407a-bbde-634812137732";
    const { bus: b } = makeBus({
      listTasks: () => [{ id: taskId, card_id: "child-linked", status: "pending" }],
      listTaskCardsForCard: () => [{ task_id: taskId, card_id: "child-linked", role: "implementer" }],
    });
    await b.handleRequest({ cmd: "report", requesterId: "child-linked", report: { ok: true, verdict: "ship" } } as BusRequest);
    const stored = (await b.handleRequest({ cmd: "get_report", target: "child-linked" } as BusRequest)) as { report: unknown };
    expect(stored.report).toEqual({ ok: true, verdict: "ship", taskId });
  });

  it("card sem task: report não ganha taskId inventado", async () => {
    const { bus: b } = makeBus({
      listTasks: () => [],
      listTaskCardsForCard: () => [],
    });
    await b.handleRequest({ cmd: "report", requesterId: "free-card", report: { ok: true } } as BusRequest);
    const stored = (await b.handleRequest({ cmd: "get_report", target: "free-card" } as BusRequest)) as { report: unknown };
    expect(stored.report).toEqual({ ok: true });
  });

  it("taskId já no corpo: o do chamador fica", async () => {
    // Duas tasks ativas no card, e o corpo declara UMA delas — que é vínculo
    // vivo. Antes isto declarava um id SINTÉTICO ("already") só para exercitar
    // o "não sobrescreve"; a task 4fee76d5 tornou isso recusa (declarado que
    // não é vínculo vivo RECUSA, nunca fallback silencioso), e a intenção
    // original — o id do chamador não é trocado pelo do principal — continua
    // medida: o principal é `linked-a` e o corpo diz `linked-b`.
    const declared = "linked-b";
    const { bus: b } = makeBus({
      listTasks: () => [
        { id: "linked-a", card_id: "child-own", status: "pending" },
        { id: declared, card_id: null, status: "pending" },
      ],
      listTaskCardsForCard: () => [
        { task_id: "linked-a", card_id: "child-own", role: "implementer" },
        { task_id: declared, card_id: "child-own", role: "implementer" },
      ],
    });
    await b.handleRequest({ cmd: "report", requesterId: "child-own", report: { ok: true, taskId: declared } } as BusRequest);
    const stored = (await b.handleRequest({ cmd: "get_report", target: "child-own" } as BusRequest)) as { report: unknown };
    expect(stored.report).toEqual({ ok: true, taskId: declared });
  });

  it("o corpo do relatório NÃO é digitado — só o ponteiro curto", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-1", to_card_id: "child-3", updated_at: Date.now() }];
    const bigReport = { ok: true, result: "x".repeat(5000), secret: "não pode vazar pro PTY do spawner" };
    const { bus: b, written } = makeBus({
      listAllConnectors: () => connectors,
      describeCardLabel: () => "Card Três",
    });

    await b.handleRequest({ cmd: "report", requesterId: "child-3", report: bigReport } as BusRequest);
    await flushDelivery();
    const bodies = written.filter(([, data]) => data !== "\r").map(([, data]) => data);
    expect(bodies.some((t) => t.includes(POINTER_NEEDLE))).toBe(true);
    expect(bodies.every((t) => !t.includes("secret") && !t.includes("xxxx"))).toBe(true);
    const stored = (await b.handleRequest({ cmd: "get_report", target: "child-3" } as BusRequest)) as { report: unknown };
    expect(stored.report).toEqual(bigReport);
  });

  it("dois relatórios rápidos: os dois persistem; os dois ponteiros saem (sem throttle no canal agente)", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-1", to_card_id: "reviewer-loop", updated_at: Date.now() }];
    const { bus: b, written } = makeBus({ listAllConnectors: () => connectors });

    const r1 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-loop", report: { round: 1 } } as BusRequest)) as { seq: number };
    const r2 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-loop", report: { round: 2 } } as BusRequest)) as { seq: number };

    expect(r2.seq).toBeGreaterThan(r1.seq);
    await waitForPointers(written, 2);
    const pointers = written.filter(([, data]) => data.includes(POINTER_NEEDLE));
    expect(pointers.length).toBeGreaterThanOrEqual(2);
    const latest = (await b.handleRequest({ cmd: "get_report", target: "reviewer-loop" } as BusRequest)) as { report: unknown };
    expect(latest.report).toEqual({ round: 2 });
  });
});

describe("message-bus: read_report sequência monotônica (Parte 2b)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus() {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-report-seq-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        listAllConnectors: () => [] as ConnectorRow[],
        listCards: () => [],
      }),
    );
    return bus;
  }

  it("dois relatórios seguidos: get_report com afterSeq do primeiro espera e devolve o SEGUNDO", async () => {
    const b = makeBus();
    const r1 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-1", report: { round: 1 } } as BusRequest)) as { seq: number };

    const waitPromise = b.handleRequest({
      cmd: "get_report",
      target: "reviewer-1",
      wait: true,
      afterSeq: r1.seq,
    } as BusRequest) as Promise<{ ok: boolean; report: unknown; seq: number }>;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const r2 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-1", report: { round: 2 } } as BusRequest)) as { seq: number };

    const waited = await waitPromise;
    expect(waited.ok).toBe(true);
    expect(waited.report).toEqual({ round: 2 });
    expect(waited.seq).toBe(r2.seq);
    expect(waited.seq).toBeGreaterThan(r1.seq);
  });

  it("sem afterSeq: continua devolvendo o último (comportamento de sempre)", async () => {
    const b = makeBus();
    await b.handleRequest({ cmd: "report", requesterId: "reviewer-2", report: { round: 1 } } as BusRequest);
    await b.handleRequest({ cmd: "report", requesterId: "reviewer-2", report: { round: 2 } } as BusRequest);

    const res = (await b.handleRequest({ cmd: "get_report", target: "reviewer-2" } as BusRequest)) as {
      ok: boolean;
      report: unknown;
    };
    expect(res.ok).toBe(true);
    expect(res.report).toEqual({ round: 2 });
  });

  it("afterSeq sem wait e sem relatório mais novo => erro explícito, não o relatório antigo", async () => {
    const b = makeBus();
    const r1 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-3", report: { round: 1 } } as BusRequest)) as { seq: number };

    const res = (await b.handleRequest({ cmd: "get_report", target: "reviewer-3", afterSeq: r1.seq } as BusRequest)) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("sequência é crescente e atribuída pelo BUS mesmo que o `report` do chamador carregue seu próprio campo 'seq'/'round'", async () => {
    const b = makeBus();
    const r1 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-4", report: { seq: 999, round: "final" } } as BusRequest)) as {
      seq: number;
    };
    const r2 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-4", report: { seq: 999, round: "final" } } as BusRequest)) as {
      seq: number;
    };

    expect(typeof r1.seq).toBe("number");
    expect(typeof r2.seq).toBe("number");
    expect(r2.seq).toBeGreaterThan(r1.seq);
    expect(r1.seq).not.toBe(999);
  });
});
