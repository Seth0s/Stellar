import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// Achado ao vivo (2026-09-09) — "ja acabou, novamente você não tem
// informação, precisamos melhorar o report": um agente orquestrador spawna
// cards, eles terminam e chamam `report`, e o orquestrador não fica sabendo
// (só descobre com polling). Este arquivo cobre o push que `report` passou
// a fazer pro spawner (mesmo caminho do `notifySpawnerOfIdleCard`, ver
// message-bus.ts: resolve o conector `kind === "spawned"`, checa vivo,
// avisa só o PONTEIRO) e a sequência monotônica do achado seguinte (Parte
// 2b — `read_report` devolvendo o relatório ERRADO de uma rodada antiga).
//
// `createMessageBus`'s callbacks são dezenas de campos obrigatórios — mesmo
// Proxy no-op de `message-bus-close-ownership.test.ts`, com `overrides` pra
// espiar/controlar só o que cada teste precisa (aqui: `listAllConnectors`,
// `isCardAlive`, `describeCardLabel`, `notifyCardReported`).
type ConnectorRow = { kind: string | null; from_card_id: string; to_card_id: string; updated_at: number };

// DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" — `report`/
// `get_report` agora passam por `getReport`/`upsertReport`/
// `nextReportSeqSeed` (callbacks que o app de verdade liga em store.ts,
// ver ReportRow lá), não mais por um `Map` interno a message-bus.ts. Estes
// testes exercitam os cmds de verdade (não um mock deles), então o Proxy
// precisa de um back-end FAKE — mas real o bastante pra round-trip — pras
// 3 callbacks: um `Map` simples aqui, escopado a UMA instância de
// `createMessageBus` (mesmo tempo de vida que este Proxy já tem).
type FakeReportRow = { card_id: string; seq: number; report_json: string; updated_at: number };

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  const reports = new Map<string, FakeReportRow>();
  const reportDefaults: Record<string, (...args: never[]) => unknown> = {
    getReport: ((cardId: string) => reports.get(cardId)) as never,
    upsertReport: ((row: FakeReportRow) => {
      reports.set(row.card_id, row);
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

describe("message-bus: report avisa o spawner (ponteiro, não conteúdo)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-report-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(sockPath, callbacksWithOverrides(overrides));
    return bus;
  }

  it("spawner vivo com conector de spawn => recebe o aviso, uma vez, com o label do card", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-1", to_card_id: "child-1", updated_at: Date.now() }];
    const notified: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "spawner-1",
      describeCardLabel: (id: string) => (id === "child-1" ? "Child One" : id),
      notifyCardReported: (...args: unknown[]) => notified.push(args),
      // Spawner não é um card de terminal neste teste — só o popup de SO
      // importa aqui, o canal PTY (2º canal, coberto no describe seguinte)
      // fica de fora de propósito.
      listCards: () => [],
    });

    const res = (await b.handleRequest({ cmd: "report", requesterId: "child-1", report: { ok: true, result: "done" } } as BusRequest)) as {
      ok: boolean;
      seq: number;
    };

    expect(res.ok).toBe(true);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toEqual(["spawner-1", "Child One"]);
  });

  it("card sem conector de spawn => ninguém é avisado, sem erro", async () => {
    const notified: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => [] as ConnectorRow[],
      isCardAlive: () => true,
      describeCardLabel: (id: string) => id,
      notifyCardReported: (...args: unknown[]) => notified.push(args),
      listCards: () => [],
    });

    const res = (await b.handleRequest({ cmd: "report", requesterId: "human-opened-card", report: { ok: true } } as BusRequest)) as {
      ok: boolean;
    };

    expect(res.ok).toBe(true);
    expect(notified).toHaveLength(0);
  });

  it("spawner morto (isCardAlive false) => não avisa e não lança", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "dead-spawner", to_card_id: "child-2", updated_at: Date.now() }];
    const notified: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => false,
      describeCardLabel: (id: string) => id,
      notifyCardReported: (...args: unknown[]) => notified.push(args),
      listCards: () => [],
    });

    let threw = false;
    let res: { ok: boolean } | undefined;
    try {
      res = (await b.handleRequest({ cmd: "report", requesterId: "child-2", report: { ok: true } } as BusRequest)) as { ok: boolean };
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(res?.ok).toBe(true);
    expect(notified).toHaveLength(0);
  });

  it("o aviso NÃO contém o corpo do relatório — só o ponteiro (spawnerId, label)", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-3", to_card_id: "child-3", updated_at: Date.now() }];
    const notified: unknown[][] = [];
    const bigReport = { ok: true, result: "x".repeat(5000), secret: "não pode vazar pro PTY do spawner" };
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => true,
      describeCardLabel: () => "Card Três",
      notifyCardReported: (...args: unknown[]) => notified.push(args),
      listCards: () => [],
    });

    await b.handleRequest({ cmd: "report", requesterId: "child-3", report: bigReport } as BusRequest);

    expect(notified).toHaveLength(1);
    const call = notified[0];
    // Só dois argumentos — nenhum terceiro carregando o relatório.
    expect(call).toHaveLength(2);
    for (const arg of call) {
      expect(arg).not.toEqual(bigReport);
      if (typeof arg === "string") expect(arg).not.toContain("não pode vazar");
    }
  });

  it("conector kind !== 'spawned' (ex.: decorativo/depends) não conta como lineage — sem aviso", async () => {
    const connectors: ConnectorRow[] = [{ kind: "depends", from_card_id: "orchestrator-x", to_card_id: "child-4", updated_at: Date.now() }];
    const notified: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => true,
      describeCardLabel: (id: string) => id,
      notifyCardReported: (...args: unknown[]) => notified.push(args),
      listCards: () => [],
    });

    await b.handleRequest({ cmd: "report", requesterId: "child-4", report: { ok: true } } as BusRequest);
    expect(notified).toHaveLength(0);
  });

  // DESIGN-BACKLOG.md §0 "Relatorio nao chega ao orquestrador depois de
  // um restart" — card sem spawner, só diretiva (`modified`), processo
  // main "reiniciado" (bus novo, Map antigo nascendo vazio). A aresta já
  // está no disco/`listAllConnectors`; o report ainda tem que rotear.
  it("RODADA 3 — card sem spawner + modified persistido + bus novo (restart) => ainda avisa quem briefou", async () => {
    const connectors: ConnectorRow[] = [
      { kind: "modified", from_card_id: "orch-readopt", to_card_id: "human-opened-worker", updated_at: Date.now() },
    ];
    const notified: unknown[][] = [];
    // Bus fresco: nenhum `send` neste processo — prova que a rota NÃO
    // depende mais de memória volátil.
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "orch-readopt",
      describeCardLabel: (id: string) => (id === "human-opened-worker" ? "Worker" : id),
      notifyCardReported: (...args: unknown[]) => notified.push(args),
      listCards: () => [],
    });

    const res = (await b.handleRequest({
      cmd: "report",
      requesterId: "human-opened-worker",
      report: { ok: true, result: "done after restart" },
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toEqual(["orch-readopt", "Worker"]);
  });

  it("RODADA 2 + 3 — modified de terceiro NÃO sequestra quando há spawned vivo", async () => {
    const connectors: ConnectorRow[] = [
      { kind: "spawned", from_card_id: "spawner-alive", to_card_id: "child-hijack", updated_at: 1 },
      { kind: "modified", from_card_id: "terceiro", to_card_id: "child-hijack", updated_at: 999 },
    ];
    const notified: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => true,
      describeCardLabel: () => "Child",
      notifyCardReported: (...args: unknown[]) => notified.push(args),
      listCards: () => [],
    });

    await b.handleRequest({ cmd: "report", requesterId: "child-hijack", report: { ok: true } } as BusRequest);
    expect(notified).toHaveLength(1);
    expect(notified[0]![0]).toBe("spawner-alive");
  });
});

describe("message-bus: report entrega uma MENSAGEM ao spawner (2º canal, correção pós-revisão)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Achado da revisão (2026-09-09, 2ª rodada): `writeToCard` termina em
  // `entry.proc.write(data)` no PTY (pty-registry.ts) — digitação
  // simulada, não um canal de mensagem programático. Escrever sem apertar
  // Enter (a versão anterior) deixa o texto pendurado no buffer de input
  // do spawner, exatamente o dano que se queria evitar. A correção usa
  // `typeAndSubmit` (extraído do cmd `send`, ver message-bus.ts) — que
  // além de escrever o texto, aperta Enter e CONFIRMA lendo o card de
  // volta (`readCardText`, via `callbacks.onReadCardRequest` +
  // `bus.resolveReadCard`). Estes testes honram esse round-trip de
  // verdade em vez de contornar: o mock de `onReadCardRequest` abaixo
  // resolve como "já submeteu" (texto vazio, não bate o prefixo
  // enviado), deixando o loop de confirmação sair na 1ª tentativa —
  // rápido o bastante pro teste, sem pular a chamada real de `readCardText`.
  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-report-pty-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        onReadCardRequest: (requestId: string) => {
          // `bus` já está atribuído quando isto roda de verdade (só é
          // chamado de dentro de `handleRequest`, depois que `makeBus`
          // já retornou) — closure sobre a variável do describe, não um
          // valor capturado cedo demais.
          bus?.resolveReadCard(requestId, { ok: true, text: "" });
        },
        ...overrides,
      }),
    );
    return bus;
  }

  it("spawner é card de terminal vivo => entrega o aviso como MENSAGEM (texto + Enter), no formato do `send_to_card`, sem o corpo do relatório", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-t1", to_card_id: "child-t1", updated_at: Date.now() }];
    const written: Array<[string, string]> = [];
    const bigReport = { ok: true, result: "x".repeat(5000), secret: "não pode vazar pro PTY do spawner" };
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: (id: string) => id === "spawner-t1",
      describeCardLabel: (id: string) => (id === "child-t1" ? "Reviewer" : id),
      // `listTerminalCards()` (message-bus.ts) filtra `listCards()` por
      // `kind === "terminal"` — precisa achar o spawner aqui como terminal
      // pra `notifySpawnerOfReport` decidir escrever.
      listCards: () => [{ id: "spawner-t1", kind: "terminal" }],
      writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
    });

    await b.handleRequest({ cmd: "report", requesterId: "child-t1", report: bigReport } as BusRequest);

    // Exatamente 2 escritas: o texto, depois o Enter — a mesma sequência
    // que `send_to_card` produz (texto, depois `\r` separado). Nenhuma
    // 3ª escrita: o mock de `onReadCardRequest` confirma na 1ª tentativa,
    // então o loop de retry do `typeAndSubmit` não repete o Enter.
    expect(written).toHaveLength(2);
    const [firstTarget, firstText] = written[0];
    const [secondTarget, secondText] = written[1];
    expect(firstTarget).toBe("spawner-t1");
    expect(secondTarget).toBe("spawner-t1");
    // Formato exato do `send_to_card`: prefixo `[de: <label>]`.
    expect(firstText).toBe('[de: Reviewer] relatório disponível — chame read_report para ver o resultado.');
    // O Enter é a SEGUNDA escrita, separada da primeira — nunca embutido
    // na mesma string (mesma razão do `send`: um `\r` colado ao texto
    // acima do limiar de paste é engolido como parte do paste).
    expect(secondText).toBe("\r");
    // O ponteiro, nunca o corpo — mesma decisão de desenho do popup.
    expect(firstText).not.toContain("x".repeat(5000));
    expect(firstText).not.toContain("não pode vazar");
  });

  it("spawner NÃO é card de terminal (ex.: card de chat ao vivo do usuário) => nada é escrito, nada estoura", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-chat", to_card_id: "child-t2", updated_at: Date.now() }];
    const written: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => true,
      describeCardLabel: (id: string) => id,
      // Card de chat ao vivo — mesmo cenário citado no comentário de
      // 2026-09-04 ("card de chat ao vivo do usuário"). `kind: "chat"`,
      // não "terminal".
      listCards: () => [{ id: "spawner-chat", kind: "chat" }],
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    let threw = false;
    try {
      await b.handleRequest({ cmd: "report", requesterId: "child-t2", report: { ok: true } } as BusRequest);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("spawner morto (isCardAlive false) => nada é escrito no PTY, mesmo se ele aparecesse como terminal em listCards", async () => {
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-dead", to_card_id: "child-t3", updated_at: Date.now() }];
    const written: unknown[][] = [];
    const b = makeBus({
      listAllConnectors: () => connectors,
      isCardAlive: () => false,
      describeCardLabel: (id: string) => id,
      listCards: () => [{ id: "spawner-dead", kind: "terminal" }],
      writeToCard: (...args: unknown[]) => written.push(args),
    });

    await b.handleRequest({ cmd: "report", requesterId: "child-t3", report: { ok: true } } as BusRequest);
    expect(written).toHaveLength(0);
  });
});

describe("message-bus: report throttla avisos repetidos do MESMO card (Correção 2, revisão 2026-09-09)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(written: unknown[][]) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-report-throttle-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const connectors: ConnectorRow[] = [{ kind: "spawned", from_card_id: "spawner-loop", to_card_id: "reviewer-loop", updated_at: Date.now() }];
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        listAllConnectors: () => connectors,
        isCardAlive: () => true,
        describeCardLabel: () => "Reviewer Loop",
        listCards: () => [], // sem card terminal aqui — só o canal 1 (popup) importa pro throttle
        notifyCardReported: (...args: unknown[]) => written.push(args),
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
      }),
    );
    return bus;
  }

  it("dois relatórios em sequência rápida (< janela) => só UM aviso; a seq avança nos dois", async () => {
    const notified: unknown[][] = [];
    const b = makeBus(notified);

    const r1 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-loop", report: { round: 1 } } as BusRequest)) as { seq: number };
    const r2 = (await b.handleRequest({ cmd: "report", requesterId: "reviewer-loop", report: { round: 2 } } as BusRequest)) as { seq: number };

    expect(notified).toHaveLength(1);
    expect(r2.seq).toBeGreaterThan(r1.seq);
    // O 2º relatório não some — só o aviso foi suprimido. `get_report`
    // sem `afterSeq` continua devolvendo o mais novo normalmente.
    const latest = (await b.handleRequest({ cmd: "get_report", target: "reviewer-loop" } as BusRequest)) as { report: unknown };
    expect(latest.report).toEqual({ round: 2 });
  });

  it("dois relatórios espaçados (>= janela) => DOIS avisos", async () => {
    const notified: unknown[][] = [];
    const b = makeBus(notified);

    // Fake só do relógio (`Date`) — o `typeAndSubmit`/`delay` internos
    // seguem em timers REAIS (rápidos aqui, canal PTY nem entra em jogo
    // neste describe), só o throttle (`Date.now()`) precisa avançar sem
    // um sleep de verdade de `REPORT_NOTIFY_MIN_INTERVAL_MS`.
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start);

    await b.handleRequest({ cmd: "report", requesterId: "reviewer-loop", report: { round: 1 } } as BusRequest);
    vi.setSystemTime(start + 3_100); // > REPORT_NOTIFY_MIN_INTERVAL_MS (3_000)
    await b.handleRequest({ cmd: "report", requesterId: "reviewer-loop", report: { round: 2 } } as BusRequest);

    expect(notified).toHaveLength(2);
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
    // Sem conector "spawned" nenhum aqui — estes testes são sobre a
    // sequência do `report`/`get_report`, não sobre o aviso ao spawner
    // (já coberto no describe acima). `resolveLiveSpawner` só precisa de
    // `listAllConnectors` devolvendo um array de verdade pra não explodir.
    bus = createMessageBus(
      sockPath,
      callbacksWithOverrides({
        listAllConnectors: () => [] as ConnectorRow[],
        // `dispatchRequest`'s entrada resolve `target`/`requesterId` via
        // rótulo (ver `resolveTargetId` em message-bus.ts) ANTES de chegar
        // no handler de `report`/`get_report` — precisa de uma lista real,
        // mesmo vazia, pra não explodir num `.some()` sobre `undefined`.
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

    // Só entrega a 4a rodada DEPOIS que a espera já está registrada — prova
    // que é um wait de verdade (bloqueou), não um "já tinha e devolveu".
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
    // O campo `seq: 999` dentro do JSON do chamador não vaza pra sequência
    // real do bus — a de baixo é sempre a atribuída aqui, nunca a copiada.
    expect(r1.seq).not.toBe(999);
  });
});
