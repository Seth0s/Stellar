import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore, type CardRow, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Card-id recycle vs live participation — two cases that MUST share a
 * criterion (epoch), because "task is done/failed" alone cannot tell them
 * apart:
 *
 * 1. Reviewer linked onto a task that is ALREADY `done` → verdict WRITTEN
 *    with role `reviewer` (the case 5bd45eb's status filter broke: card
 *    494 → ef31e603).
 * 2. Recycled short id MUST NOT inherit a stale `task_cards` row from a
 *    previous incarnation (the 37-verdict bug the status filter was
 *    protecting).
 *
 * Also: `nextIdSeed` covers every schema column in the short-id space,
 * including `task_transitions.card_id` (the hole in the hand-written UNION).
 */

function baseCard(id: string): CardRow {
  return {
    id,
    board_id: "default",
    kind: "terminal",
    provider: "cursor",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: Date.now(),
    messages_json: null,
    archived_at: null,
  };
}

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "work",
    provider: "cursor",
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
        if (prop === "recordParticipationRound")
          return (cardId: string, verdict: string | null, at: number, taskId?: string | null) => store.recordParticipationRound(cardId, verdict, at, taskId);
        if (prop === "listTasks") return () => store.listTasks();
        if (prop === "upsertTask") return (row: TaskRow) => store.upsertTask(row);
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "getTaskCards") return (taskId: string) => store.getTaskCards(taskId);
        // O rig não tem pty-registry, então a liveness dos dois ids que ele
        // usa é DECLARADA — e explicitamente, porque este arquivo é sobre id
        // RECICLADO: "478" é o id reciclado (a encarnação nova, criada
        // depois) e "494" é o card do primeiro caso. Sem esta linha o guarda
        // de identidade do `report` (task 34e27f66) recusaria os dois por "o
        // card não existe" e nenhum dos casos chegaria ao veredito.
        if (prop === "isCardAlive") return (cardId: string) => cardId === "478" || cardId === "494";
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("card id recycle vs live participation (store real)", () => {
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

  it("nextIdSeed does not reuse a deleted card id still referenced only by task_transitions", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-id-seed-tt-"));
    store = openStore(dir);
    store.upsertCard(baseCard("10"));
    store.upsertTask(baseTask("t-tt", { status: "pending" }));
    store.close();
    store = null;

    // The hole 5bd45eb left: a card that only left footprints in
    // task_transitions, then was DELETEd from cards, with no row in the
    // hand-written UNION tables.
    const raw = new Database(join(dir, "agent-canvas.db"));
    raw.prepare(
      `INSERT INTO task_transitions (id, task_id, kind, from_value, to_value, actor, card_id, at)
       VALUES ('tt-1', 't-tt', 'status', 'pending', 'done', 'agent', '10', ?)`,
    ).run(Date.now());
    raw.prepare("DELETE FROM cards WHERE id = '10'").run();
    raw.close();

    store = openStore(dir);
    expect(store.getCard("10")).toBeUndefined();
    expect(store.listTaskCardsForCardHistory("10")).toEqual([]);
    expect(store.getTaskTransitions("t-tt").some((t) => t.card_id === "10")).toBe(true);
    expect(store.nextIdSeed()).toBeGreaterThanOrEqual(10);
  });

  it("nextIdSeed does not reuse a deleted card id still referenced by task_cards", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-id-seed-"));
    store = openStore(dir);
    store.upsertCard(baseCard("10"));
    store.upsertTask(baseTask("t-old", { card_id: "10", status: "done" }));
    store.deleteCard("10");
    expect(store.getCard("10")).toBeUndefined();
    expect(store.listTaskCardsForCardHistory("10")).toEqual([
      expect.objectContaining({ task_id: "t-old", card_id: "10", role: "implementer" }),
    ]);

    expect(store.nextIdSeed()).toBeGreaterThanOrEqual(10);
  });

  it("SAME file: reviewer on done task writes verdict; recycled id does NOT inherit stale link", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-epoch-"));
    store = openStore(dir);
    bus = createMessageBus(join(dir, "epoch.sock"), callbacksBackedByStore(store));

    // --- Case A: reviewer on already-done task (the mechanism 5bd45eb broke) ---
    store.upsertCard(baseCard("494"));
    store.upsertTask(baseTask("ef31-done", { status: "done", card_id: null }));
    store.linkTaskCard("ef31-done", "494", "reviewer");
    expect(store.listTaskCardsForCard("494")).toEqual([
      expect.objectContaining({ task_id: "ef31-done", card_id: "494", role: "reviewer" }),
    ]);

    const resReview = (await bus.handleRequest({
      cmd: "report",
      requesterId: "494",
      report: { ok: true },
      verdict: "reprovado",
    } as BusRequest)) as { ok: boolean };
    expect(resReview.ok).toBe(true);
    expect(store.getReport("494")?.role).toBe("reviewer");
    expect(store.getTaskVerdicts("ef31-done").map((v) => [v.role, v.verdict])).toEqual([["reviewer", "reprovado"]]);

    // --- Case B: recycle — same short id, stale done-task link must not fire ---
    //
    // O veículo é um REVIEWER no vínculo novo, não o implementer principal
    // (2026-09-19): um veredito de implementer é recusado pelo gate do
    // `report` antes de qualquer gravação — mesma regra que a porta MCP já
    // aplicava (mudança em message-bus.ts). O ponto deste caso nunca foi o
    // papel, e sim a ÉPOCA: o veredito tem de cair na task do vínculo vivo e
    // nunca na task done herdada de outra encarnação do mesmo id curto. Um
    // reviewer é quem de fato pode julgar, então é ele que exercita a época.
    store.upsertCard(baseCard("478"));
    store.upsertTask(baseTask("ec01-old", { card_id: "478", status: "pending" }));
    store.recordParticipationRound("478", null, 1_000);
    store.upsertTask(baseTask("ec01-old", { card_id: "478", status: "done", updated_at: Date.now() }));
    store.deleteCard("478");

    // Pin epochs explicitly (avoid same-ms flakiness between linked_at and created_at).
    store.close();
    store = null;
    bus.close();
    bus = null;
    {
      const raw = new Database(join(dir, "agent-canvas.db"));
      raw.prepare("UPDATE task_cards SET linked_at = 1000 WHERE task_id = 'ec01-old' AND card_id = '478'").run();
      raw.close();
    }
    store = openStore(dir);
    bus = createMessageBus(join(dir, "epoch.sock"), callbacksBackedByStore(store));
    store.upsertCard({ ...baseCard("478"), created_at: 2000 });
    // `card_id: null` de propósito: um reviewer nunca é `tasks.card_id` (o
    // retry/falha da task é derivado dessa coluna — ver store.ts), então o
    // vínculo dele é só a linha de `task_cards` escrita por `linkTaskCard`.
    store.upsertTask(baseTask("d107-new", { card_id: null, status: "pending" }));
    store.linkTaskCard("d107-new", "478", "reviewer");
    {
      // Ensure the NEW link is of this incarnation (Date.now() is fine; pin for certainty).
      store.close();
      store = null;
      bus.close();
      bus = null;
      const raw = new Database(join(dir, "agent-canvas.db"));
      raw.prepare("UPDATE task_cards SET linked_at = 3000 WHERE task_id = 'd107-new' AND card_id = '478'").run();
      raw.close();
      store = openStore(dir);
      bus = createMessageBus(join(dir, "epoch.sock"), callbacksBackedByStore(store));
    }

    expect(store.listTaskCardsForCardHistory("478").map((l) => l.task_id).sort()).toEqual(["d107-new", "ec01-old"]);
    expect(store.listTaskCardsForCard("478")).toEqual([
      expect.objectContaining({ task_id: "d107-new", card_id: "478", role: "reviewer" }),
    ]);

    const beforeOld = store.getTaskVerdicts("ec01-old").length;
    const resRecycle = (await bus.handleRequest({
      cmd: "report",
      requesterId: "478",
      report: { ok: true },
      verdict: "aprovado",
    } as BusRequest)) as { ok: boolean };
    expect(resRecycle.ok).toBe(true);

    expect(store.getReport("478")?.role).toBe("reviewer");
    expect(store.getTaskVerdicts("ec01-old")).toHaveLength(beforeOld);
    expect(store.getTaskVerdicts("d107-new").map((v) => [v.role, v.verdict])).toEqual([["reviewer", "aprovado"]]);
  });

  it("legacy NULL clocks still drop a lone done-task link (recycle fallback)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-id-stale-only-"));
    store = openStore(dir);
    store.upsertCard(baseCard("99"));
    store.upsertTask(baseTask("dead", { card_id: "99", status: "done" }));
    store.close();
    store = null;

    const raw = new Database(join(dir, "agent-canvas.db"));
    raw.prepare("UPDATE cards SET created_at = NULL WHERE id = '99'").run();
    raw.prepare("UPDATE task_cards SET linked_at = NULL WHERE card_id = '99'").run();
    raw.close();

    store = openStore(dir);
    expect(store.listTaskCardsForCardHistory("99")).toHaveLength(1);
    expect(store.listTaskCardsForCard("99")).toEqual([]);
    expect(store.recordParticipationRound("99", "aprovado", Date.now())).toEqual([]);
    expect(store.getTaskVerdicts("dead")).toEqual([]);
  });
});
