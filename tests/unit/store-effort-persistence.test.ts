import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type CardRow } from "../../src/main/store";

// DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" (relato do dono
// do repo, 2026-09-09, custo real em dinheiro).
//
// O QUE ESTE ARQUIVO PROVA, exatamente: (1) `migrate()` adiciona a coluna
// `effort` a um banco antigo sem derrubar linhas existentes; (2)
// `upsertCard`/`getCard` fazem round-trip de QUALQUER string pela coluna
// — incluindo valores fora de "low"/"high" (claude aceita medium/xhigh/
// max) — sem truncar nem coagir, porque `store.ts` nunca valida o
// conteúdo (TEXT puro, mesmo tratamento que `model` já tinha). Ou seja:
// prova o TRANSPORTE (SQL), não o bug relatado em si.
//
// O QUE FICA DESCOBERTO, de propósito (review adversarial, 2026-09-09,
// achado 3): o bug real de coerção destrutiva vivia em App.tsx — um
// `coerceEffort` que existiu numa rodada anterior desta mesma tarefa e
// colapsava qualquer valor fora de "low"/"high" pra `null` em `fromRow`,
// o que faria o próximo `toRow` (drag/resize/rename, qualquer mutação não
// relacionada) sobrescrever o banco com esse `null`, apagando um "medium"
// de verdade. Esse `coerceEffort` foi REMOVIDO (o tipo foi alargado pra
// `string | null` em vez de coagido — ver card-types.ts), então o
// caminho destrutivo não existe mais no código — mas essa afirmação é
// garantida por INSPEÇÃO/type-check (`fromRow` agora faz `effort:
// r.effort`, um passthrough puro, igual `model: r.model`), não por um
// teste que rode `fromRow`/`toRow` de verdade: App.tsx executa
// `window.system.homeDir` no top level do módulo e não importa nesta
// suíte `environment: "node"`, sem jsdom (mesma lacuna documentada, de
// propósito, em connector-label.test.ts). Não existe, antes ou depois
// desta correção, nenhum teste automatizado do comportamento real de
// `fromRow`/`toRow` para `effort` — só este arquivo (transporte SQL) e
// providers.test.ts (buildArgs) cobrem alguma coisa deste bug.
describe("store.ts: effort column", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function baseCardFields(id: string) {
    return {
      id,
      board_id: "default",
      kind: "terminal",
      provider: "claude",
      cwd: "/tmp",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      resume_id: null,
      model: "opus",
      system_prompt: null,
      group_id: null,
      label: null,
      updated_at: Date.now(),
      messages_json: null,
      archived_at: null,
    };
  }

  it("adds the effort column to a pre-existing database (schema from before this column existed) without dropping data", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-effort-"));
    const dbPath = join(dir, "agent-canvas.db");

    // Recria o schema de `cards` EXATAMENTE como era antes desta coluna
    // existir (mesmas colunas do CREATE TABLE atual, menos `effort`) —
    // não um subconjunto arbitrário, pra provar migração real, não um
    // caso de banco vazio que `CREATE TABLE IF NOT EXISTS` já cobriria
    // trivialmente.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL DEFAULT 'default',
        kind TEXT NOT NULL DEFAULT 'terminal',
        provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
        resume_id TEXT,
        model TEXT,
        system_prompt TEXT,
        group_id TEXT,
        label TEXT,
        updated_at INTEGER NOT NULL,
        messages_json TEXT,
        archived_at INTEGER
      );
    `);
    const preExisting = baseCardFields("pre-existing-card");
    raw.prepare(
      `INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, system_prompt, group_id, label, updated_at, messages_json, archived_at)
       VALUES (@id, @board_id, @kind, @provider, @cwd, @x, @y, @w, @h, @resume_id, @model, @system_prompt, @group_id, @label, @updated_at, @messages_json, @archived_at)`,
    ).run(preExisting);
    raw.close();

    // openStore runs migrate() — this is the real ALTER TABLE ADD COLUMN
    // path, against a real on-disk database, not an in-memory fixture.
    const store = openStore(dir);
    try {
      const row = store.getCard("pre-existing-card");
      expect(row).toBeDefined();
      // The pre-existing row survives with effort defaulting to null —
      // never crashes, never silently drops the row.
      expect(row!.effort).toBeNull();
      expect(row!.model).toBe("opus"); // untouched columns are intact too

      // listCards/listAllCards must also survive the new column in their
      // SELECT list (there are 4 separate SELECTs in store.ts — missing
      // one would be a silent bug, not a crash).
      expect(store.listCards("default").some((c) => c.id === "pre-existing-card")).toBe(true);
      expect(store.listAllCards().some((c) => c.id === "pre-existing-card")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("round-trips effort through upsertCard/getCard, independently of model", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-effort-"));
    const store = openStore(dir);
    try {
      const row: CardRow = { ...baseCardFields("c1"), effort: "high" };
      store.upsertCard(row);
      expect(store.getCard("c1")?.effort).toBe("high");

      // Real-world case this bug was about: the SAME card's effort
      // changes on a later upsert (e.g. re-spawn with a different
      // effort) and must overwrite, not stick to the old value.
      store.upsertCard({ ...row, effort: "low", updated_at: Date.now() + 1 });
      expect(store.getCard("c1")?.effort).toBe("low");

      // null effort (every non-terminal card kind, or a terminal card
      // that never had one chosen) round-trips as null, not "null" or "".
      store.upsertCard({ ...row, effort: null, updated_at: Date.now() + 2 });
      expect(store.getCard("c1")?.effort).toBeNull();
    } finally {
      store.close();
    }
  });

  // Review adversarial 2026-09-09, achado 2 — the column itself is a plain
  // TEXT with no CHECK constraint (same as `model`); this store layer
  // never coerces or validates the value, on purpose. Values outside
  // "low"/"high" (claude's real `--effort` range is low/medium/high/
  // xhigh/max) must round-trip byte-for-byte here — any narrowing/
  // coercion belongs, if anywhere, at a layer that can afford to lose
  // data safely, which App.tsx's fromRow (after this same review) no
  // longer does either.
  it("round-trips a value outside low/high (e.g. claude's medium/xhigh) without coercion", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-effort-"));
    const store = openStore(dir);
    try {
      for (const value of ["medium", "xhigh", "max"]) {
        store.upsertCard({ ...baseCardFields("c-wide"), model: "opus", effort: value });
        expect(store.getCard("c-wide")?.effort).toBe(value);
      }
    } finally {
      store.close();
    }
  });

  it("persists effort alongside model on the same row (the pairing the app relies on for relaunch)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-effort-"));
    const store = openStore(dir);
    try {
      const row: CardRow = { ...baseCardFields("c2"), model: "gemini-3.1-pro", effort: "high" };
      store.upsertCard(row);
      const back = store.getCard("c2");
      expect(back?.model).toBe("gemini-3.1-pro");
      expect(back?.effort).toBe("high");
    } finally {
      store.close();
    }
  });
});
