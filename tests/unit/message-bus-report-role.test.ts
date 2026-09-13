import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// Matar a auto-aprovação (2026-09-13). Medido: `task_verdicts` 156/156
// implementer, `task_cards` 94/94 implementer, e os 14 `reports.verdict =
// 'aprovado'` escritos pelo próprio implementador — não porque ninguém
// revisava, mas porque nenhum writer gravava outro papel e `report` não
// carimbava quem mandou. Este arquivo cobre a metade do MAIN: `report`
// grava `reports.role` a partir de `task_cards` do card que reportou —
// implementer, reviewer e DESCONHECIDO (null, nunca implementer por
// default) — e `get_report` devolve o papel junto com o verdict. Store
// REAL atrás do bus (não mock): a coluna nova, a migração e o choke point
// são testados juntos, como rodam no app.

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    status: "running",
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
        if (prop === "recordParticipationRound") return (cardId: string, verdict: string | null, at: number) => store.recordParticipationRound(cardId, verdict, at);
        // `report` lê a task vinculada por `tasks.card_id` pra decidir
        // aceitação/retry — o store real responde.
        if (prop === "listTasks") return () => store.listTasks();
        if (prop === "upsertTask") return (row: TaskRow) => store.upsertTask(row);
        if (prop === "listAllConnectors") return () => [];
        if (prop === "listCards") return () => [];
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

function rawRole(dir: string, cardId: string): string | null {
  const raw = new Database(join(dir, "agent-canvas.db"), { readonly: true });
  try {
    return (raw.prepare("SELECT role FROM reports WHERE card_id = ? ORDER BY seq DESC LIMIT 1").get(cardId) as { role: string | null }).role;
  } finally {
    raw.close();
  }
}

describe("message-bus + store: report carimba reports.role a partir de task_cards", () => {
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

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-role-"));
    store = openStore(dir);
    bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store));
    return { store, bus };
  }

  it("implementer: card principal da task (`tasks.card_id`) reporta 'aprovado' → role 'implementer' gravado ao lado do verdict", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t-impl", { card_id: "impl-1" }));

    const res = (await b.handleRequest({ cmd: "report", requesterId: "impl-1", report: { ok: true }, verdict: "aprovado" } as BusRequest)) as {
      ok: boolean;
      seq: number;
    };
    expect(res.ok).toBe(true);

    const row = s.getReport("impl-1");
    expect(row?.verdict).toBe("aprovado");
    expect(row?.role).toBe("implementer");
    expect(rawRole(dir, "impl-1")).toBe("implementer");
    // `task_verdicts` continua recebendo a rodada com o MESMO papel — a
    // fonte é uma só (`task_cards`), duas linhas.
    expect(s.getTaskVerdicts("t-impl").map((v) => [v.role, v.verdict])).toEqual([["implementer", "aprovado"]]);
  });

  it("reviewer: card vinculado via linkTaskCard como reviewer reporta → role 'reviewer'; o principal segue implementer", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t-rev", { card_id: "impl-2" }));
    s.linkTaskCard("t-rev", "rev-2", "reviewer");

    await b.handleRequest({ cmd: "report", requesterId: "impl-2", report: { ok: true }, verdict: "aprovado" } as BusRequest);
    const res = (await b.handleRequest({ cmd: "report", requesterId: "rev-2", report: { ok: true, notes: "ok" }, verdict: "reprovado" } as BusRequest)) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);

    expect(s.getReport("rev-2")).toMatchObject({ verdict: "reprovado", role: "reviewer" });
    expect(s.getReport("impl-2")).toMatchObject({ verdict: "aprovado", role: "implementer" });
    expect(s.getTaskVerdicts("t-rev").map((v) => [v.card_id, v.role, v.verdict])).toEqual([
      ["impl-2", "implementer", "aprovado"],
      ["rev-2", "reviewer", "reprovado"],
    ]);
  });

  it("role desconhecido: card sem vínculo em task_cards reporta 'aprovado' → role NULL (fato registrado), NÃO 'implementer'", async () => {
    const { store: s, bus: b } = setup();

    const res = (await b.handleRequest({ cmd: "report", requesterId: "loose-3", report: { ok: true }, verdict: "aprovado" } as BusRequest)) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);

    const row = s.getReport("loose-3");
    expect(row?.verdict).toBe("aprovado");
    expect(row?.role).toBeNull();
    expect(rawRole(dir, "loose-3")).toBeNull();
  });

  it("role ambíguo: card implementer numa task e reviewer em outra → NULL (o report é por card, não diz de qual task fala)", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t-a", { card_id: "both-4" }));
    s.upsertTask(baseTask("t-b"));
    s.linkTaskCard("t-b", "both-4", "reviewer");

    await b.handleRequest({ cmd: "report", requesterId: "both-4", report: { ok: true }, verdict: "aprovado" } as BusRequest);

    expect(s.getReport("both-4")?.role).toBeNull();
    // Mas `task_verdicts` (por task) sabe cada papel — a ambiguidade é só
    // da linha por card.
    expect(s.getTaskVerdicts("t-a")[0]?.role).toBe("implementer");
    expect(s.getTaskVerdicts("t-b")[0]?.role).toBe("reviewer");
  });

  it("get_report devolve `role` junto do `verdict` (sem wait, com wait, e caminhando por afterSeq)", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t-read", { card_id: "impl-5" }));
    s.linkTaskCard("t-read", "rev-5", "reviewer");

    const waiter = b.handleRequest({ cmd: "get_report", target: "rev-5", wait: true, timeoutMs: 2000 } as BusRequest) as Promise<{
      ok: boolean;
      role: string | null;
      verdict: string | null;
    }>;
    await b.handleRequest({ cmd: "report", requesterId: "rev-5", report: { ok: true }, verdict: "aprovado" } as BusRequest);
    expect(await waiter).toMatchObject({ ok: true, verdict: "aprovado", role: "reviewer" });

    const latest = (await b.handleRequest({ cmd: "get_report", target: "rev-5" } as BusRequest)) as { role: string | null };
    expect(latest.role).toBe("reviewer");

    await b.handleRequest({ cmd: "report", requesterId: "loose-6", report: { ok: true } } as BusRequest);
    const unknown = (await b.handleRequest({ cmd: "get_report", target: "loose-6" } as BusRequest)) as { ok: boolean; role: string | null };
    expect(unknown).toMatchObject({ ok: true, role: null });

    const next = (await b.handleRequest({ cmd: "get_report", target: "rev-5", afterSeq: 0 } as BusRequest)) as { role: string | null };
    expect(next.role).toBe("reviewer");
  });

  it("papel é carimbado NO MOMENTO do report: trocar o papel depois (linkTaskCard) não reescreve a linha antiga", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t-hist"));
    s.linkTaskCard("t-hist", "c-7", "reviewer");

    await b.handleRequest({ cmd: "report", requesterId: "c-7", report: { round: 1 }, verdict: "reprovado" } as BusRequest);
    s.linkTaskCard("t-hist", "c-7", "implementer");
    await b.handleRequest({ cmd: "report", requesterId: "c-7", report: { round: 2 }, verdict: "aprovado" } as BusRequest);

    expect(s.getReport("c-7", 0)).toMatchObject({ verdict: "reprovado", role: "reviewer" });
    expect(s.getReport("c-7")).toMatchObject({ verdict: "aprovado", role: "implementer" });
  });
});

describe("store.ts: migração de reports.role", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("banco de ANTES da coluna: linhas existentes ficam role NULL (sem backfill — reescrevê-las inventaria história), linhas novas gravam o papel", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-role-mig-"));
    const dbPath = join(dir, "agent-canvas.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE reports (
        seq INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        verdict TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    // O dado real medido: um "aprovado" de antes da coluna. Não dá pra
    // saber quem mandou — e a migração não deve fingir que sabe.
    raw.prepare("INSERT INTO reports (seq, card_id, report_json, verdict, updated_at) VALUES (?, ?, ?, ?, ?)").run(3, "old-card", "{}", "aprovado", Date.now());
    raw.close();

    const store = openStore(dir);
    try {
      const cols = (new Database(dbPath, { readonly: true }).prepare("SELECT name FROM pragma_table_info('reports')").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("role");

      const old = store.getReport("old-card");
      expect(old).toMatchObject({ seq: 3, verdict: "aprovado", role: null });

      store.upsertReport({ card_id: "new-card", seq: 4, report_json: "{}", verdict: "aprovado", role: "reviewer", updated_at: Date.now() });
      expect(store.getReport("new-card")?.role).toBe("reviewer");
      // Quem não manda `role` (ReportRow sem a chave) grava NULL, não string vazia nem 'implementer'.
      store.upsertReport({ card_id: "quiet-card", seq: 5, report_json: "{}", updated_at: Date.now() });
      expect(store.getReport("quiet-card")?.role).toBeNull();
      // O antigo continua exatamente como estava.
      expect(store.getReport("old-card")?.role).toBeNull();
    } finally {
      store.close();
    }
  });

  it("migração slot→append-only (card_id PK) também ganha a coluna role, e as linhas migradas ficam NULL", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-role-slot-"));
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
    raw.prepare("INSERT INTO reports (card_id, seq, report_json, verdict, updated_at) VALUES (?, ?, ?, ?, ?)").run("legacy", 7, "{}", "aprovado", Date.now());
    raw.close();

    const store = openStore(dir);
    try {
      expect(store.getReport("legacy")).toMatchObject({ seq: 7, verdict: "aprovado", role: null });
      store.upsertReport({ card_id: "legacy", seq: 8, report_json: "{}", verdict: "reprovado", role: "reviewer", updated_at: Date.now() });
      expect(store.getReport("legacy")).toMatchObject({ seq: 8, role: "reviewer" });
    } finally {
      store.close();
    }
  });
});
