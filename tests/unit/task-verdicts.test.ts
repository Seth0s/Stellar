import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";

const cryptoHooks = vi.hoisted(() => ({
  randomUUIDOverride: null as null | (() => string),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: (() => cryptoHooks.randomUUIDOverride?.() ?? actual.randomUUID()) as typeof actual.randomUUID,
  };
});

/**
 * DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação"
 * (levantado 2026-09-11, ao fechar a fidelidade visual do card Fila — "um
 * trabalho que paga quatro": destrava papel-no-passado nos chips, pílulas
 * `rodada N`/`reprovada N×`, e os gráficos 1/2). Cobre o modelo de dados
 * novo — `task_verdicts`, tabela NOVA (não coluna em `task_cards`: a PK
 * `(task_id, card_id)` de lá é "papel atual", presente, upsert; misturar
 * história ali quebraria essa PK e o significado que outro código já lê) —
 * e `store.recordParticipationRound`, o choke point único que grava nela.
 * Mesmo padrão de teste (banco real, `openStore` contra um dir temporário)
 * que `applyColumnDrop` já usa logo abaixo neste mesmo arquivo-irmão.
 */
describe("store.ts: task_verdicts / recordParticipationRound (histórico de veredito por participação)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function baseTaskFields(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
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
    };
  }

  it("grava 1 linha lendo o PAPEL de task_cards no momento da rodada (upsertTask com card_id já criou o vínculo 'implementer' sozinho)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t1", { card_id: "card-a" }));

      const at = Date.now();
      const written = store.recordParticipationRound("card-a", "aprovado", at, "t1");

      expect(written).toEqual([{ id: expect.any(String), task_id: "t1", card_id: "card-a", role: "implementer", verdict: "aprovado", at }]);
      expect(store.getTaskVerdicts("t1")).toEqual(written);
    } finally {
      store.close();
    }
  });

  it("verdict null é um valor real, preservado tal como veio — não 'ainda sem informação', distinto de 'aprovado'/'reprovado'", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t2", { card_id: "card-b" }));
      store.recordParticipationRound("card-b", null, Date.now());

      const rows = store.getTaskVerdicts("t2");
      expect(rows).toHaveLength(1);
      expect(rows[0].verdict).toBeNull();
    } finally {
      store.close();
    }
  });

  it("duas rodadas do MESMO (task_id, card_id): append-only — a segunda NÃO apaga/sobrescreve a primeira", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t3", { card_id: "card-c" }));

      store.recordParticipationRound("card-c", "reprovado", 1000, "t3");
      store.recordParticipationRound("card-c", "reprovado", 2000, "t3");
      store.recordParticipationRound("card-c", "aprovado", 3000, "t3");

      const rows = store.getTaskVerdicts("t3");
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.verdict)).toEqual(["reprovado", "reprovado", "aprovado"]);
      // Nenhuma sobrescrita: os 3 `id`s são distintos (linha nova a cada
      // chamada, nunca um UPDATE no lugar do INSERT anterior).
      expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    } finally {
      store.close();
    }
  });

  it("fan-out: um card vinculado a 2 tasks ao mesmo tempo grava 1 linha em CADA task numa única chamada (atômica via db.transaction, mesma garantia de applyColumnDrop)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t4a", { card_id: "card-multi" }));
      store.upsertTask(baseTaskFields("t4b"));
      store.linkTaskCard("t4b", "card-multi", "reviewer");

      const written = store.recordParticipationRound("card-multi", null, 500);

      expect(written).toHaveLength(2);
      expect(store.getTaskVerdicts("t4a")).toEqual([{ id: expect.any(String), task_id: "t4a", card_id: "card-multi", role: "implementer", verdict: null, at: 500 }]);
      expect(store.getTaskVerdicts("t4b")).toEqual([{ id: expect.any(String), task_id: "t4b", card_id: "card-multi", role: "reviewer", verdict: null, at: 500 }]);
    } finally {
      store.close();
    }
  });

  it("fan-out faz rollback de todas as tasks quando a segunda inserção falha", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-rollback-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t-rollback-a", { card_id: "card-rollback" }));
      store.upsertTask(baseTaskFields("t-rollback-b"));
      store.linkTaskCard("t-rollback-b", "card-rollback", "reviewer");

      // The first link gets a valid id; the second gets the same primary-key
      // value, forcing UNIQUE(id) halfway through the fan-out transaction.
      cryptoHooks.randomUUIDOverride = () => "duplicate-verdict-id";
      expect(() => store.recordParticipationRound("card-rollback", null, 700)).toThrow();

      expect(store.getTaskVerdicts("t-rollback-a")).toEqual([]);
      expect(store.getTaskVerdicts("t-rollback-b")).toEqual([]);
    } finally {
      cryptoHooks.randomUUIDOverride = null;
      store.close();
    }
  });

  it("papel é copiado NO MOMENTO da rodada — trocar o papel depois (linkTaskCard) não reescreve linhas antigas", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t5", { card_id: "card-d" }));
      store.recordParticipationRound("card-d", "reprovado", 100, "t5");

      store.linkTaskCard("t5", "card-d", "reviewer");
      store.recordParticipationRound("card-d", "aprovado", 200, "t5");

      const rows = store.getTaskVerdicts("t5");
      expect(rows.map((r) => r.role)).toEqual(["implementer", "reviewer"]);
    } finally {
      store.close();
    }
  });

  it("card sem NENHUM vínculo em task_cards: 0 linhas gravadas, sem erro — não há rodada de participação nenhuma pra fechar", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-"));
    const store = openStore(dir);
    try {
      const written = store.recordParticipationRound("card-nunca-vinculado", "aprovado", Date.now());
      expect(written).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("getTask anexa `verdicts` em ordem cronológica, mesmo padrão transiente de `transitions`/`cards` — ausente em listTasks", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t6", { card_id: "card-e" }));
      store.recordParticipationRound("card-e", "reprovado", 1, "t6");
      store.recordParticipationRound("card-e", "aprovado", 2, "t6");

      const task = store.getTask("t6")!;
      expect(task.verdicts).toHaveLength(2);
      expect(task.verdicts!.map((v) => v.verdict)).toEqual(["reprovado", "aprovado"]);

      // listTasks não anexa (listagem em massa barata, mesmo contrato de transitions/cards).
      expect(store.listTasks().find((t) => t.id === "t6")!.verdicts).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("migração: abre um banco pré-existente sem task_verdicts sem apagar tasks já lá, e passa a gravar normalmente a partir daqui", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tv-migrate-"));
    const dbPath = join(dir, "agent-canvas.db");

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
        board_id TEXT,
        result_json TEXT,
        deps_json TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        attempted_providers_json TEXT,
        max_retries INTEGER,
        fallback_providers_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare(
        "INSERT INTO tasks (id, prompt, provider, status, card_id, board_id, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run("pre-existing-task", "task antiga", "claude", "running", "card-old", "default", Date.now(), Date.now());
    raw.close();

    const store = openStore(dir);
    try {
      const task = store.getTask("pre-existing-task")!;
      // Sem histórico sintético: a trilha de veredito de uma task que
      // predata esta tabela começa vazia, nunca inventada a partir de
      // `updated_at` — mesma decisão já tomada para `task_transitions`.
      expect(task.verdicts).toEqual([]);

      // Status must be non-terminal: live participation ignores done/failed
      // links (card-id recycle fix, 2026-09-13). Migration itself is what
      // this test covers — recording still has to work on an open task.
      store.recordParticipationRound("card-old", "aprovado", Date.now(), "pre-existing-task");
      expect(store.getTask("pre-existing-task")!.verdicts).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
