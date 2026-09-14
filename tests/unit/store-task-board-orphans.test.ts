import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow, type BoardRow } from "../../src/main/store";

/**
 * RODADA 4 (DESIGN-BACKLOG.md §2.3, diagnóstico do board órfão) — cobre
 * as duas metades da correção:
 *
 * (1) MIGRAÇÃO (`migrate`/pós-migrate em `openStore`): qualquer task cujo
 * `board_id` não corresponda a NENHUMA linha de `boards` volta pra
 * `board_id = NULL` — reusa o significado que a coluna já tem pra
 * "bookkeeping externo puro" (TaskRow.board_id's doc comment), nunca
 * apaga a task. Roda contra um banco real em disco (não uma fixture em
 * memória), reproduzindo o achado real: task presa a `board_id = "1"`
 * enquanto `boards` só tem outras linhas (aqui, "118" — o Idyplatform que
 * NÃO pode ser tocado).
 *
 * (2) `deleteBoard`: reatribui as tasks do board deletado em vez de
 * abandoná-las órfãs — a mesma classe de bug, fechada na origem.
 */
function makeBoard(id: string, name: string): BoardRow {
  return { id, name, project: "", cwd: "", created_at: Date.now(), updated_at: Date.now(), last_accessed_at: null, autonomous: false, concurrency_cap: null, orchestrator_card_id: null };
}

function makeTask(id: string, boardId: string | null): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: `task ${id}`,
    provider: null,
    status: "pending",
    card_id: null,
    board_id: boardId,
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
  };
}

describe("store.ts: migração de tasks órfãs (board_id sem board correspondente)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reatribui board_id=NULL só pras tasks cujo board não existe — o board real (118) fica intocado", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-orphans-"));

    // Escreve o cenário do achado real diretamente por SQL cru — igual
    // `store-effort-persistence.test.ts` recria o schema antigo, isto
    // recria o ESTADO SUJO real (task presa a um board que não existe),
    // não um estado que `upsertTask`/`upsertBoard` de hoje jamais
    // produziriam sozinhos.
    const dbPath = join(dir, "agent-canvas.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, project TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER, autonomous INTEGER NOT NULL DEFAULT 0, concurrency_cap INTEGER
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, prompt TEXT, provider TEXT, status TEXT NOT NULL, card_id TEXT,
        result_json TEXT, deps_json TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
        attempted_providers_json TEXT, board_id TEXT, max_retries INTEGER, fallback_providers_json TEXT,
        "order" INTEGER, suggested_order INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare(`INSERT INTO boards (id, name, project, cwd, created_at, updated_at, last_accessed_at, autonomous, concurrency_cap)
      VALUES ('118', 'Idyplatform', '', '', 0, 0, NULL, 0, NULL)`).run();
    const now = Date.now();
    // Seis tasks órfãs (board_id "1", igual ao achado real) + uma task de
    // verdade no board 118 (não pode ser tocada) + uma pra checar que
    // board_id NULL já-existente (bookkeeping legítimo) também sobrevive
    // intocado.
    const insertTask = raw.prepare(`INSERT INTO tasks (id, prompt, status, board_id, retry_count, created_at, updated_at)
      VALUES (@id, @prompt, 'pending', @board_id, 0, @now, @now)`);
    for (let i = 0; i < 6; i++) insertTask.run({ id: `orphan-${i}`, prompt: `orphan ${i}`, board_id: "1", now });
    insertTask.run({ id: "real-118", prompt: "task real do Idyplatform", board_id: "118", now });
    insertTask.run({ id: "bookkeeping", prompt: "sem board desde sempre", board_id: null, now });
    raw.close();

    // openStore roda migrate() + a reatribuição pós-migrate contra este
    // banco real em disco.
    const store = openStore(dir);
    try {
      for (let i = 0; i < 6; i++) {
        const t = store.getTask(`orphan-${i}`);
        expect(t).toBeDefined();
        expect(t!.board_id).toBeNull(); // órfã reatribuída, nunca apagada
      }
      // O board real fica INTOCADO — nem a task, nem a contagem dele.
      const real = store.getTask("real-118");
      expect(real?.board_id).toBe("118");
      expect(store.listTasksByBoard("118").map((t) => t.id)).toEqual(["real-118"]);

      // Uma task que já era bookkeeping puro (board_id NULL desde antes)
      // não vira "reatribuída" por acidente — continua NULL, sem
      // nenhuma transição espúria de status por causa disso.
      expect(store.getTask("bookkeeping")?.board_id).toBeNull();

      // Nenhuma das seis foi APAGADA — todas continuam alcançáveis por
      // getTask/listTasks, exatamente a garantia "tasks são imortais".
      expect(store.listTasks().length).toBe(8);
    } finally {
      store.close();
    }
  });

  it("é idempotente — rodar a migração de novo (2º openStore) não muda nada nem quebra", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-orphans-idem-"));
    // Primeiro openStore cria o schema do zero (sem órfã nenhuma ainda) e
    // já deixa uma task órfã de verdade via upsertTask (board_id que
    // nunca existiu em `boards`).
    let store = openStore(dir);
    store.upsertBoard(makeBoard("118", "Idyplatform"));
    store.upsertTask(makeTask("orphan-x", "999-nao-existe"));
    store.close();

    // 2ª abertura: migrate() roda nesta chamada e já deve limpar a órfã
    // criada acima (ela foi gravada com board_id="999-nao-existe" ANTES
    // de qualquer openStore rodar a reatribuição sobre ela).
    store = openStore(dir);
    expect(store.getTask("orphan-x")?.board_id).toBeNull();
    store.close();

    // 3ª abertura — nada mudou, nada quebra, o valor já está estável.
    store = openStore(dir);
    expect(store.getTask("orphan-x")?.board_id).toBeNull();
    expect(store.getTask("orphan-x")).toBeDefined();
    store.close();
  });
});

describe("store.ts: deleteBoard reatribui tasks em vez de abandoná-las", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("deletar um board com tasks: as tasks CONTINUAM existindo e alcançáveis, com board_id=NULL", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-deleteboard-"));
    const store = openStore(dir);
    try {
      store.upsertBoard(makeBoard("b1", "Board a apagar"));
      store.upsertBoard(makeBoard("b2", "Board que sobrevive"));
      store.upsertTask(makeTask("t1", "b1"));
      store.upsertTask(makeTask("t2", "b1"));
      store.upsertTask(makeTask("t3", "b2"));

      store.deleteBoard("b1");

      // b1 sumiu de verdade.
      expect(store.getBoard("b1")).toBeUndefined();
      // b2 continua intocado.
      expect(store.getBoard("b2")).toBeDefined();

      // t1/t2 CONTINUAM existindo (getTask nunca undefined) — não foram
      // apagadas, só perderam o board.
      const t1 = store.getTask("t1");
      const t2 = store.getTask("t2");
      expect(t1).toBeDefined();
      expect(t2).toBeDefined();
      expect(t1!.board_id).toBeNull();
      expect(t2!.board_id).toBeNull();

      // Alcançáveis por listTasks (a lista geral, que um agente ainda
      // consegue ler via MCP `list_tasks` sem boardId) — não desaparecem
      // do sistema.
      expect(store.listTasks().map((t) => t.id)).toEqual(expect.arrayContaining(["t1", "t2", "t3"]));

      // t3 (board b2, que não foi deletado) fica 100% intocada.
      expect(store.getTask("t3")?.board_id).toBe("b2");
      expect(store.listTasksByBoard("b2").map((t) => t.id)).toEqual(["t3"]);

      // O rodapé de escopo (taskCountsByBoard) não conta t1/t2 em NENHUM
      // board depois disso — nem no b1 (que já nem existe), nem em
      // nenhum outro — exatamente o "não pode virar órfã com outro
      // nome" que o review pediu pra conferir.
      const counts = store.taskCountsByBoard();
      expect(counts["b1"]).toBeUndefined();
      expect(counts["b2"]).toBe(1);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1); // só t3
    } finally {
      store.close();
    }
  });

  it("deletar um board SEM nenhuma task não afeta tasks de outros boards", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-deleteboard-empty-"));
    const store = openStore(dir);
    try {
      store.upsertBoard(makeBoard("empty-board", "Vazio"));
      store.upsertBoard(makeBoard("other", "Outro"));
      store.upsertTask(makeTask("t-other", "other"));

      store.deleteBoard("empty-board");

      expect(store.getTask("t-other")?.board_id).toBe("other");
      expect(store.listTasks().length).toBe(1);
    } finally {
      store.close();
    }
  });
});
