import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";

// DESIGN-BACKLOG.md §2.1 "Card `task`" — Fase 1, só o modelo de dados.
// Cobre as quatro peças novas em store.ts: (1) `task_transitions`, gravada
// automaticamente DENTRO de `upsertTask` — nunca uma função separada que
// um chamador precisa lembrar de invocar; (2) `order`/`suggested_order`,
// dois campos com dois donos; (3) `task_cards`, o vínculo task<->vários
// cards com papel; (4) migração aditiva sobre um banco pré-existente sem
// nenhuma dessas três coisas. Nunca contra o banco real do usuário — todo
// teste usa um diretório temporário próprio, descartado no afterEach.

describe("store.ts: task_transitions / order / task_cards", () => {
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
      status: "pending",
      card_id: null,
      board_id: "default",
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

  it("upsertTask grava uma transição de status quando o status muda (inclusive na criação: null -> status inicial)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t1", { status: "pending" }));
      let transitions = store.getTask("t1")!.transitions!;
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ kind: "status", from_value: null, to_value: "pending", actor: "agent" });

      store.upsertTask(baseTaskFields("t1", { status: "running", updated_at: Date.now() + 1 }));
      transitions = store.getTask("t1")!.transitions!;
      expect(transitions).toHaveLength(2);
      expect(transitions[1]).toMatchObject({ kind: "status", from_value: "pending", to_value: "running", actor: "agent" });
    } finally {
      store.close();
    }
  });

  it("upsertTask NÃO grava transição quando o upsert não muda o status", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t2", { status: "running" }));
      expect(store.getTask("t2")!.transitions).toHaveLength(1);

      // Mesmo status, só outro campo mudando (resultado parcial, por
      // exemplo) — nenhuma linha nova em task_transitions.
      store.upsertTask(baseTaskFields("t2", { status: "running", result_json: JSON.stringify({ progress: 0.5 }), updated_at: Date.now() + 1 }));
      expect(store.getTask("t2")!.transitions).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("actor: 'agent' quando omitido (default), respeita o que a task carrega quando presente ('app'/'human')", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t3", { status: "pending" })); // actor omitido
      store.upsertTask(baseTaskFields("t3", { status: "running", actor: "app", updated_at: Date.now() + 1 }));
      store.upsertTask(baseTaskFields("t3", { status: "done", actor: "human", updated_at: Date.now() + 2 }));

      const transitions = store.getTask("t3")!.transitions!;
      expect(transitions.map((t) => t.actor)).toEqual(["agent", "app", "human"]);

      // `actor` nunca vira coluna persistida de `tasks` — transiente.
      const raw = new Database(join(dir, "agent-canvas.db")).prepare("SELECT * FROM tasks WHERE id = ?").get("t3") as Record<string, unknown>;
      expect(raw).not.toHaveProperty("actor");
    } finally {
      store.close();
    }
  });

  it("ordem/at monotônicos: getTask devolve as transições em ordem cronológica real", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-"));
    const store = openStore(dir);
    try {
      const t0 = Date.now();
      store.upsertTask(baseTaskFields("t4", { status: "pending", created_at: t0, updated_at: t0 }));
      store.upsertTask(baseTaskFields("t4", { status: "running", updated_at: t0 })); // mesmo milissegundo de propósito
      store.upsertTask(baseTaskFields("t4", { status: "done", updated_at: t0 + 50 }));

      const transitions = store.getTask("t4")!.transitions!;
      expect(transitions.map((t) => t.to_value)).toEqual(["pending", "running", "done"]);
      for (let i = 1; i < transitions.length; i++) {
        expect(transitions[i].at).toBeGreaterThanOrEqual(transitions[i - 1].at);
      }
    } finally {
      store.close();
    }
  });

  it("migração aditiva: abre um banco pré-existente sem task_transitions/task_cards/order sem apagar tasks já lá", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-migrate-"));
    const dbPath = join(dir, "agent-canvas.db");

    // Schema de ANTES desta tarefa existir: exatamente as colunas de
    // `tasks` sem `order`/`suggested_order`, e nem `task_transitions` nem
    // `task_cards` existem.
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
      .run("pre-existing-task", "task antiga", "claude", "done", "card-old", "default", Date.now(), Date.now());
    raw.close();

    // openStore roda migrate() (ALTER TABLE de order/suggested_order) e
    // CREATE TABLE IF NOT EXISTS pra task_transitions/task_cards contra um
    // arquivo em disco de verdade.
    const store = openStore(dir);
    try {
      const task = store.getTask("pre-existing-task");
      expect(task).toBeDefined();
      expect(task!.status).toBe("done");
      expect(task!.order).toBeNull();
      expect(task!.suggested_order).toBeNull();

      // Task antiga sem histórico continua legível — trilha vazia, NUNCA
      // sintetizada a partir de created_at (decisão explícita do dono do
      // repo: pareceria dado real e sujaria os gráficos futuros).
      expect(task!.transitions).toEqual([]);

      // O backfill de card_id ainda funciona: a task antiga com card_id
      // vira uma linha de junção com papel razoável.
      expect(task!.cards).toEqual([{ task_id: "pre-existing-task", card_id: "card-old", role: "implementer" }]);

      // E as tabelas novas já funcionam de ponta a ponta a partir daqui.
      store.upsertTask({ ...task!, status: "failed", updated_at: Date.now() });
      expect(store.getTask("pre-existing-task")!.transitions).toHaveLength(1);
      expect(store.getTask("pre-existing-task")!.transitions![0]).toMatchObject({ from_value: "done", to_value: "failed" });
    } finally {
      store.close();
    }
  });

  it("round-trip de order/suggested_order — independentes, um não pisa no outro", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t5", { order: null, suggested_order: 3 }));
      let t = store.getTask("t5")!;
      expect(t.order).toBeNull();
      expect(t.suggested_order).toBe(3);

      // Humano arrasta (escreve `order`) sem tocar no palpite do agente.
      store.upsertTask({ ...t, order: 1, updated_at: Date.now() + 1 });
      t = store.getTask("t5")!;
      expect(t.order).toBe(1);
      expect(t.suggested_order).toBe(3);

      // Agente atualiza o palpite depois — não sobrescreve o `order`
      // humano.
      store.upsertTask({ ...t, suggested_order: 7, updated_at: Date.now() + 2 });
      t = store.getTask("t5")!;
      expect(t.order).toBe(1);
      expect(t.suggested_order).toBe(7);
    } finally {
      store.close();
    }
  });

  it("junção task_cards: dois papéis simultâneos para a mesma task (implementa + revisa)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-"));
    const store = openStore(dir);
    try {
      // upsertTask com card_id popula 'implementer' sozinho (sem chamada
      // extra que alguém precise lembrar).
      store.upsertTask(baseTaskFields("t6", { card_id: "card-306" }));
      expect(store.getTaskCards("t6")).toEqual([{ task_id: "t6", card_id: "card-306", role: "implementer" }]);

      // Um segundo card, papel diferente, via o primitivo explícito.
      store.linkTaskCard("t6", "card-304", "reviewer");
      const cards = store.getTaskCards("t6");
      expect(cards).toHaveLength(2);
      expect(cards).toEqual(
        expect.arrayContaining([
          { task_id: "t6", card_id: "card-306", role: "implementer" },
          { task_id: "t6", card_id: "card-304", role: "reviewer" },
        ]),
      );

      // upsertTask de novo com o MESMO card_id não pisa num papel já
      // decidido pra esse par (task, card) — troca de papel é via
      // linkTaskCard, não via upsertTask.
      store.linkTaskCard("t6", "card-306", "reviewer");
      store.upsertTask({ ...store.getTask("t6")!, updated_at: Date.now() + 1 });
      expect(store.getTaskCards("t6").find((c) => c.card_id === "card-306")?.role).toBe("reviewer");

      // getTask também expõe `cards`, não só getTaskCards.
      expect(store.getTask("t6")!.cards).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("listTasks (sem board) e listTasksByBoard (com filtro) — comportamento existente intacto + variante nova", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-tt-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("t7", { board_id: "board-1" }));
      store.upsertTask(baseTaskFields("t8", { board_id: "board-2" }));

      expect(store.listTasks().map((t) => t.id).sort()).toEqual(["t7", "t8"]);
      expect(store.listTasksByBoard("board-1").map((t) => t.id)).toEqual(["t7"]);
      expect(store.listTasksByBoard("board-2").map((t) => t.id)).toEqual(["t8"]);
      expect(store.listTasksByBoard("board-3")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

/**
 * DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 — review adversarial RODADA 3.
 * `applyColumnDrop` é o choke point que `store:tasks:move` (main/index.ts)
 * chama pra gravar um drop inteiro — cobre os DOIS achados desta rodada
 * no nível do banco de verdade (não só na função pura de
 * task-board-model.ts): achado 1 (a restrição inegociável — a arrastada
 * recebe `order`, vizinhos SÓ `implicit_order`, NUNCA `order`) e achado 2
 * (atomicidade — `db.transaction`, tudo-ou-nada).
 */
describe("store.ts: applyColumnDrop (peça 3, review adversarial rodada 3)", () => {
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
      status: "pending",
      card_id: null,
      board_id: "default",
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

  it("[restrição inegociável, achado 1] arrastada recebe order+status; vizinho recebe SÓ implicit_order — nunca order, nunca suggested_order, nunca muda de status", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-drop-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("dragged", { status: "pending" }));
      store.upsertTask(baseTaskFields("sib1", { status: "pending" }));

      const dragged = { ...store.getTask("dragged")!, status: "running", order: 500, updated_at: Date.now() + 1 };
      store.applyColumnDrop(dragged, [{ id: "sib1", implicitOrder: 250 }]);

      const draggedAfter = store.getTask("dragged")!;
      expect(draggedAfter.status).toBe("running");
      expect(draggedAfter.order).toBe(500);
      expect(draggedAfter.implicit_order).toBeNull(); // a arrastada nunca ganha implicit_order — ela já tem order de verdade

      const sibAfter = store.getTask("sib1")!;
      expect(sibAfter.implicit_order).toBe(250);
      expect(sibAfter.order).toBeNull(); // A RESTRIÇÃO: nunca order
      expect(sibAfter.suggested_order).toBeNull(); // nem suggested_order
      expect(sibAfter.status).toBe("pending"); // nem status — só posição, nada decidido
    } finally {
      store.close();
    }
  });

  it("[restrição inegociável, achado 1] depois do drop, um suggested_order real do agente (update_task-equivalent) ainda vence o implicit_order materializado — zero imunidade", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-drop-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("dragged2", { status: "pending" }));
      store.upsertTask(baseTaskFields("sib2", { status: "pending" }));
      store.applyColumnDrop({ ...store.getTask("dragged2")!, status: "running", order: 500, updated_at: Date.now() + 1 }, [
        { id: "sib2", implicitOrder: 250 },
      ]);

      // Um agente chamando update_task({taskId:"sib2", suggestedOrder:1})
      // depois do drop — mesmo caminho de escrita de sempre (spread +
      // upsertTask), nada especial precisa acontecer aqui.
      store.upsertTask({ ...store.getTask("sib2")!, suggested_order: 1, updated_at: Date.now() + 2 });

      const sibAfter = store.getTask("sib2")!;
      expect(sibAfter.suggested_order).toBe(1);
      expect(sibAfter.implicit_order).toBe(250); // o implicit_order antigo continua lá...
      expect(sibAfter.order).toBeNull(); // ...mas nunca teve order pra "travar" a leitura em primeiro lugar
    } finally {
      store.close();
    }
  });

  it("[achado 2] atômica: uma falha no meio do lote não deixa a arrastada parcialmente gravada", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-drop-"));
    const store = openStore(dir);
    try {
      store.upsertTask(baseTaskFields("dragged3", { status: "pending", order: null }));

      let threw = false;
      try {
        store.applyColumnDrop(
          { ...store.getTask("dragged3")!, status: "running", order: 999, updated_at: Date.now() + 1 },
          // `implicitOrder: {}` força better-sqlite3 a rejeitar o binding
          // ("SQLite3 can only bind numbers, strings, bigints, buffers,
          // and null" — confirmado ao vivo, `undefined` sozinho NÃO
          // lança, vira NULL em silêncio) no MEIO do lote — a arrastada
          // já foi gravada antes deste laço, dentro da MESMA
          // `db.transaction`. Simula um erro real a meio caminho.
          [{ id: "sib3", implicitOrder: {} as unknown as number }],
        );
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      // Rollback de verdade: a arrastada NÃO ficou com o status/order
      // novo — `db.transaction` desfez a escrita que já tinha rodado.
      const draggedAfter = store.getTask("dragged3")!;
      expect(draggedAfter.status).toBe("pending");
      expect(draggedAfter.order).toBeNull();
    } finally {
      store.close();
    }
  });
});
