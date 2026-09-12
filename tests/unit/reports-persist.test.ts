import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" — achado ao vivo
// nesta sessão: um card de review chamou `report`, saiu `ok:true`, o
// Electron reiniciou, e o relatório sumiu (o Map em memória de
// message-bus.ts não sobrevive a NENHUM restart — update, crash, relogin,
// `quitAndInstall`). Este arquivo cobre as duas metades da correção:
// (1) store.ts — a tabela `reports` (round-trip, migração contra um banco
// pré-existente sem a tabela, e o cap de contagem); (2) message-bus.ts —
// que a `seq` monotônica sobrevive a um restart SIMULADO de verdade (fecha
// o store, abre outro apontando pro MESMO diretório, como o app faria).
// Nunca contra `~/.config/agent-canvas/agent-canvas.db` — todo teste aqui
// usa um diretório temporário próprio, descartado no afterEach.

describe("store.ts: tabela reports", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips um relatório: upsertReport -> getReport devolve o mesmo seq/JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-"));
    const store = openStore(dir);
    try {
      expect(store.getReport("card-1")).toBeUndefined();

      const row: ReportRow = { card_id: "card-1", seq: 1, report_json: JSON.stringify({ ok: true, result: "done" }), updated_at: Date.now() };
      store.upsertReport(row);

      const back = store.getReport("card-1");
      expect(back).toBeDefined();
      expect(back!.seq).toBe(1);
      expect(JSON.parse(back!.report_json)).toEqual({ ok: true, result: "done" });
    } finally {
      store.close();
    }
  });

  // DESIGN-BACKLOG.md §2.1 decisão 9 — `verdict` vira campo real do
  // schema, opcional. Round-trip básico + "quem não manda continua
  // funcionando" (ReportRow sem a chave, o formato de todo chamador
  // antes desta coluna existir).
  it("verdict: round-trip quando mandado, null quando omitido (opcional, não quebra quem já não manda)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-"));
    const store = openStore(dir);
    try {
      store.upsertReport({ card_id: "reviewer-2", seq: 1, report_json: JSON.stringify({ ok: true }), verdict: "aprovado", updated_at: Date.now() });
      expect(store.getReport("reviewer-2")?.verdict).toBe("aprovado");

      // Chamador que não manda verdict (todo `report` de antes desta
      // coluna) continua funcionando, e o campo lê null, não undefined
      // nem uma string vazia. seq é PK global — não reusa 1.
      store.upsertReport({ card_id: "reviewer-3", seq: 2, report_json: JSON.stringify({ ok: true }), updated_at: Date.now() });
      expect(store.getReport("reviewer-3")?.verdict).toBeNull();
    } finally {
      store.close();
    }
  });

  it("append-only por card_id — reportar de novo ACUMULA linhas; getReport sem afterSeq devolve o mais recente", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-"));
    const store = openStore(dir);
    try {
      store.upsertReport({ card_id: "reviewer-1", seq: 1, report_json: JSON.stringify({ round: 1 }), updated_at: Date.now() });
      store.upsertReport({ card_id: "reviewer-1", seq: 2, report_json: JSON.stringify({ round: 2 }), updated_at: Date.now() });
      store.upsertReport({ card_id: "reviewer-1", seq: 3, report_json: JSON.stringify({ round: 3 }), updated_at: Date.now() });

      const latest = store.getReport("reviewer-1");
      expect(latest!.seq).toBe(3);
      expect(JSON.parse(latest!.report_json)).toEqual({ round: 3 });

      const count = (new Database(join(dir, "agent-canvas.db")).prepare("SELECT COUNT(*) as n FROM reports WHERE card_id = ?").get("reviewer-1") as {
        n: number;
      }).n;
      expect(count).toBe(3);

      // afterSeq caminha o histórico na ordem — não pula pra última.
      expect(JSON.parse(store.getReport("reviewer-1", 0)!.report_json)).toEqual({ round: 1 });
      expect(JSON.parse(store.getReport("reviewer-1", 1)!.report_json)).toEqual({ round: 2 });
      expect(JSON.parse(store.getReport("reviewer-1", 2)!.report_json)).toEqual({ round: 3 });
      expect(store.getReport("reviewer-1", 3)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("nextReportSeqSeed: 0 num banco sem nenhum relatório, MAX(seq) real depois de escrever", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-"));
    const store = openStore(dir);
    try {
      expect(store.nextReportSeqSeed()).toBe(0);
      store.upsertReport({ card_id: "a", seq: 5, report_json: "{}", updated_at: Date.now() });
      store.upsertReport({ card_id: "b", seq: 12, report_json: "{}", updated_at: Date.now() });
      expect(store.nextReportSeqSeed()).toBe(12);
    } finally {
      store.close();
    }
  });

  it("migração: abre um banco pré-existente (schema de ANTES desta tabela existir) sem apagar cards/tasks já lá, e a tabela reports funciona depois", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-migrate-"));
    const dbPath = join(dir, "agent-canvas.db");

    // Recria o schema mínimo de ANTES desta tarefa: cards/tasks existem,
    // `reports` não — exatamente o banco real de um usuário que já usava o
    // app antes desta correção existir.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL DEFAULT 'default',
        kind TEXT NOT NULL DEFAULT 'terminal',
        provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT,
        provider TEXT,
        status TEXT NOT NULL,
        card_id TEXT,
        result_json TEXT,
        deps_json TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        attempted_providers_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare("INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, updated_at) VALUES (?, 'default', 'terminal', 'claude', '/tmp', 0, 0, 400, 300, ?)")
      .run("pre-existing-card", Date.now());
    raw
      .prepare("INSERT INTO tasks (id, prompt, provider, status, card_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("pre-existing-task", "faz X", "claude", "running", "pre-existing-card", Date.now(), Date.now());
    raw.close();

    // openStore roda CREATE TABLE IF NOT EXISTS pra `reports` (tabela
    // nova, sem coluna pra ALTERar — mesmo caminho que `tasks`/
    // `browser_favorites` tiveram quando FORAM criadas) — real, contra um
    // arquivo em disco de verdade, não um fixture em memória.
    const store = openStore(dir);
    try {
      // Dado pré-existente sobrevive intacto.
      expect(store.getCard("pre-existing-card")).toBeDefined();
      expect(store.getTask("pre-existing-task")?.status).toBe("running");

      // E a tabela nova já funciona de ponta a ponta.
      expect(store.getReport("pre-existing-card")).toBeUndefined();
      store.upsertReport({ card_id: "pre-existing-card", seq: 1, report_json: JSON.stringify({ ok: true }), updated_at: Date.now() });
      expect(JSON.parse(store.getReport("pre-existing-card")!.report_json)).toEqual({ ok: true });
    } finally {
      store.close();
    }
  });

  it("abaixo do cap: nenhum relatório é descartado (o caso normal, ~5 cards)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-cap-"));
    const store = openStore(dir);
    try {
      for (let i = 1; i <= 5; i++) {
        store.upsertReport({ card_id: `card-${i}`, seq: i, report_json: JSON.stringify({ i }), updated_at: Date.now() });
      }
      for (let i = 1; i <= 5; i++) {
        expect(store.getReport(`card-${i}`)).toBeDefined();
      }
    } finally {
      store.close();
    }
  });

  it("cap de contagem (MAX_STORED_REPORTS = 1000): passar do limite descarta só as linhas mais ANTIGAS, preservando as mais novas", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-cap-"));
    const store = openStore(dir);
    try {
      // 1010 linhas (cards distintos, seq crescente) — 10 além do cap.
      // Com append-only o prune corta por LINHA/seq, não por card_id.
      const total = 1010;
      for (let i = 1; i <= total; i++) {
        store.upsertReport({ card_id: `card-${i}`, seq: i, report_json: JSON.stringify({ i }), updated_at: Date.now() });
      }

      const raw = new Database(join(dir, "agent-canvas.db"));
      const count = (raw.prepare("SELECT COUNT(*) as n FROM reports").get() as { n: number }).n;
      expect(count).toBe(1000);

      // Os 10 mais ANTIGOS (seq 1..10) foram descartados...
      for (let i = 1; i <= 10; i++) {
        expect(store.getReport(`card-${i}`)).toBeUndefined();
      }
      // ...os 1000 mais NOVOS (seq 11..1010) sobreviveram intactos.
      expect(store.getReport(`card-11`)).toBeDefined();
      expect(store.getReport(`card-${total}`)).toBeDefined();
      expect(JSON.parse(store.getReport(`card-${total}`)!.report_json)).toEqual({ i: total });
      raw.close();
    } finally {
      store.close();
    }
  });

  it("migração de slot→append-only: banco com card_id PK preserva linhas e passa a acumular", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-reports-slot-mig-"));
    const dbPath = join(dir, "agent-canvas.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE reports (
        card_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        verdict TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare("INSERT INTO reports (card_id, seq, report_json, verdict, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-card", 7, JSON.stringify({ legacy: true }), null, Date.now());
    raw.close();

    const store = openStore(dir);
    try {
      const legacy = store.getReport("legacy-card");
      expect(legacy?.seq).toBe(7);
      expect(JSON.parse(legacy!.report_json)).toEqual({ legacy: true });

      store.upsertReport({
        card_id: "legacy-card",
        seq: 8,
        report_json: JSON.stringify({ round: 2 }),
        updated_at: Date.now(),
      });
      expect(store.getReport("legacy-card")!.seq).toBe(8);
      expect(JSON.parse(store.getReport("legacy-card", 7)!.report_json)).toEqual({ round: 2 });

      const count = (new Database(dbPath).prepare("SELECT COUNT(*) as n FROM reports WHERE card_id = ?").get("legacy-card") as {
        n: number;
      }).n;
      expect(count).toBe(2);

      const pk = (
        new Database(dbPath).prepare(`SELECT name FROM pragma_table_info('reports') WHERE pk > 0`).all() as { name: string }[]
      ).map((r) => r.name);
      expect(pk).toEqual(["seq"]);
    } finally {
      store.close();
    }
  });
});

// DESIGN-BACKLOG.md §2.1 — o cenário central do achado: um restart REAL do
// processo (Electron reinicia) não pode nem apagar o relatório nem fazer a
// `seq` mentir pro `afterSeq`. Simulado aqui fechando um `openStore`/
// `createMessageBus` e abrindo um PAR NOVO apontando pro MESMO diretório —
// é exatamente o que `index.ts` faz de verdade num boot novo (`openStore(
// app.getPath("userData"))` sempre aponta pro mesmo arquivo).
describe("message-bus + store: seq monotônica e relatório sobrevivem a um restart simulado", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Mesmo padrão Proxy dos outros testes de message-bus.ts
  // (message-bus-report-notify.test.ts) — aqui as 3 callbacks de
  // relatório vão de verdade pro `store` real (não um fake em Map), e o
  // resto é no-op: estes testes são só sobre `report`/`get_report`. Só
  // MONTA as callbacks — quem chama `createMessageBus` é cada teste.
  function callbacksBackedByStore(store: ReturnType<typeof openStore>): Parameters<typeof createMessageBus>[1] {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
          if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
          if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
          if (prop === "listAllConnectors") return () => [];
          if (prop === "listCards") return () => [];
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
  }

  it("restart simulado: relatório escrito ANTES do restart continua lá DEPOIS, com o mesmo seq", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-restart-"));

    const store1 = openStore(dir);
    const bus1 = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store1));
    const r1 = (await bus1.handleRequest({ cmd: "report", requesterId: "reviewer-1", report: { round: 1 } } as BusRequest)) as { ok: boolean; seq: number };
    expect(r1.ok).toBe(true);
    bus1.close();
    store1.close();

    // "Restart" de verdade: uma segunda instância de store+bus, sem
    // nenhum estado em memória compartilhado com a primeira, apontando pro
    // MESMO arquivo .db.
    const store2 = openStore(dir);
    const bus2 = createMessageBus(join(dir, "b.sock"), callbacksBackedByStore(store2));
    try {
      const read = (await bus2.handleRequest({ cmd: "get_report", target: "reviewer-1" } as BusRequest)) as {
        ok: boolean;
        report: unknown;
        seq: number;
      };
      expect(read.ok).toBe(true);
      expect(read.report).toEqual({ round: 1 });
      expect(read.seq).toBe(r1.seq);
    } finally {
      bus2.close();
      store2.close();
    }
  });

  it("restart simulado: a PRÓXIMA seq depois do restart é MAIOR que a última persistida — nunca reinicia em 1", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-restart-seq-"));

    const store1 = openStore(dir);
    const bus1 = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store1));
    // Duas rodadas antes do restart — seq real fica > 1 (não é o caso
    // trivial "só existia 1 relatório").
    await bus1.handleRequest({ cmd: "report", requesterId: "reviewer-2", report: { round: 1 } } as BusRequest);
    const r2 = (await bus1.handleRequest({ cmd: "report", requesterId: "reviewer-2", report: { round: 2 } } as BusRequest)) as { seq: number };
    bus1.close();
    store1.close();

    const store2 = openStore(dir);
    const bus2 = createMessageBus(join(dir, "b.sock"), callbacksBackedByStore(store2));
    try {
      // O cenário exato do briefing: relatório novo DEPOIS do restart não
      // pode sair com seq menor que um antigo já persistido — senão
      // `afterSeq` mente pro consumidor (relatório novo parece "mais
      // velho" que um que já leu).
      const r3 = (await bus2.handleRequest({ cmd: "report", requesterId: "reviewer-2", report: { round: 3 } } as BusRequest)) as {
        ok: boolean;
        seq: number;
      };
      expect(r3.ok).toBe(true);
      expect(r3.seq).toBeGreaterThan(r2.seq);
    } finally {
      bus2.close();
      store2.close();
    }
  });

  it("restart simulado: read_report com afterSeq atravessa o restart sem pular o relatório novo nem repetir o antigo", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-restart-afterseq-"));

    const store1 = openStore(dir);
    const bus1 = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store1));
    const r1 = (await bus1.handleRequest({ cmd: "report", requesterId: "reviewer-3", report: { round: 1 } } as BusRequest)) as { seq: number };
    bus1.close();
    store1.close();

    const store2 = openStore(dir);
    const bus2 = createMessageBus(join(dir, "b.sock"), callbacksBackedByStore(store2));
    try {
      // Consumidor que já leu o seq de antes do restart (r1) não deve
      // receber o mesmo relatório de novo nem um erro estranho — só
      // "nada mais novo ainda", exatamente como antes de qualquer restart.
      const stale = (await bus2.handleRequest({ cmd: "get_report", target: "reviewer-3", afterSeq: r1.seq } as BusRequest)) as {
        ok: boolean;
      };
      expect(stale.ok).toBe(false);

      // Um relatório novo DEPOIS do restart passa a satisfazer o mesmo
      // afterSeq — a seq persistida (não reiniciada) é o que faz isso
      // funcionar.
      const r2 = (await bus2.handleRequest({ cmd: "report", requesterId: "reviewer-3", report: { round: 2 } } as BusRequest)) as { seq: number };
      const fresh = (await bus2.handleRequest({ cmd: "get_report", target: "reviewer-3", afterSeq: r1.seq } as BusRequest)) as {
        ok: boolean;
        report: unknown;
        seq: number;
      };
      expect(fresh.ok).toBe(true);
      expect(fresh.report).toEqual({ round: 2 });
      expect(fresh.seq).toBe(r2.seq);
    } finally {
      bus2.close();
      store2.close();
    }
  });
});
