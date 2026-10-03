import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CARD_TRACE_EVENT_KINDS,
  deriveCardTraceEventRow,
  openStore,
  type CardRow,
  type CardTraceRow,
} from "../../src/main/store";

/**
 * Task 86613ff9 (PEÇA 1 de 7) — o STREAM de rastro.
 *
 * O critério: eventos chaveados por `(task_id, card_id, at)` gravados em SQLite,
 * sobreviventes a RESTART, e nenhum fato de atribuição morando só num `Map`.
 * O `card_traces` (retrato do fecho) já existia; o que entra aqui é a tabela
 * irmã append-only. Fixtures locais — este teste NUNCA abre o banco vivo.
 */

describe("deriveCardTraceEventRow (puro)", () => {
  it("aceita um evento válido e DERIVA tail_bytes da cauda (não confia no emissor)", () => {
    const got = deriveCardTraceEventRow({
      taskId: "t1",
      cardId: "c1",
      at: 100,
      kind: "spawn",
      boardId: "64",
      providerId: "claude",
      tail: "abc",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.row).toMatchObject({
      task_id: "t1",
      card_id: "c1",
      at: 100,
      board_id: "64",
      kind: "spawn",
      provider_id: "claude",
      tail: "abc",
      tail_bytes: 3,
      tail_at_cap: 0,
      redacted: 0,
    });
  });

  it("ausência declarada: cauda vazia, board/provider ausentes => null, redacted/tailAtCap viram 0/1", () => {
    const got = deriveCardTraceEventRow({
      taskId: "  t1  ",
      cardId: " c1 ",
      at: 5,
      kind: "close",
      boardId: "   ",
      tail: "",
      redacted: true,
      tailAtCap: true,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.row).toMatchObject({ task_id: "t1", card_id: "c1", board_id: null, provider_id: null, tail_bytes: 0, redacted: 1, tail_at_cap: 1 });
  });

  it("RECUSA nomeando o campo — taskId, cardId, at e kind", () => {
    const missingTask = deriveCardTraceEventRow({ cardId: "c1", at: 1, kind: "spawn" });
    expect(missingTask.ok).toBe(false);
    if (!missingTask.ok) expect(missingTask.error).toContain("taskId");

    const missingCard = deriveCardTraceEventRow({ taskId: "t1", at: 1, kind: "spawn" });
    expect(missingCard.ok).toBe(false);
    if (!missingCard.ok) expect(missingCard.error).toContain("cardId");

    const badKind = deriveCardTraceEventRow({ taskId: "t1", cardId: "c1", at: 1, kind: "joined" });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) {
      expect(badKind.error).toContain("kind");
      expect(badKind.error).toContain("spawn"); // a lista aceita é dita, não implícita
    }

    for (const at of [0, -1, 1.5, Number.NaN]) {
      const badAt = deriveCardTraceEventRow({ taskId: "t1", cardId: "c1", at, kind: "spawn" });
      expect(badAt.ok).toBe(false);
      if (!badAt.ok) expect(badAt.error).toContain("`at`");
    }
  });

  it("a lista de kinds é declarada (5 viradas) e é ela que a recusa usa", () => {
    expect([...CARD_TRACE_EVENT_KINDS]).toEqual(["spawn", "first_output", "turn_end", "quota", "close"]);
  });
});

describe("card_trace_events no store (fixture local)", () => {
  let dir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;

  function fresh(): ReturnType<typeof openStore> {
    dir = mkdtempSync(join(tmpdir(), "stellar-trace-events-"));
    return openStore(dir);
  }

  function card(id: string): CardRow {
    return {
      id,
      board_id: "64",
      kind: "terminal",
      provider: "claude",
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
      updated_at: 1,
      messages_json: null,
      archived_at: null,
      created_at: 1,
    };
  }

  function trace(cardId: string, closedAt: number): CardTraceRow {
    return {
      card_id: cardId,
      board_id: "64",
      closed_at: closedAt,
      screen_stored: 0,
      tail: "",
      tail_bytes: 0,
      tail_at_cap: 0,
      redacted: 0,
      spawned_at_ms: 1,
      last_activity_at: 1,
      turn_ended_at: null,
      quota_death: 0,
      kill_requested: 0,
    };
  }

  afterEach(() => {
    (store as unknown as { close?: () => void } | null)?.close?.();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("grava e lê os eventos na ORDEM do `at`; re-gravar o MESMO (task,card,at) é idempotente", () => {
    store = fresh();
    expect(store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 200, kind: "turn_end" })).toMatchObject({ ok: true });
    expect(store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 100, kind: "spawn" })).toMatchObject({ ok: true });
    // Re-entrega do MESMO evento: atualiza a linha, NÃO cria um segundo fato.
    expect(store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 100, kind: "first_output" })).toMatchObject({ ok: true });

    const events = store.getCardTraceEvents("c1");
    expect(events.map((e) => e.at)).toEqual([100, 200]);
    expect(events[0].kind).toBe("first_output");
    expect(store.countCardTraceEvents()).toBe(2);
  });

  it("um evento INVÁLIDO é recusado e NADA é gravado (recusa nomeando o campo)", () => {
    store = fresh();
    const refused = store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 1, kind: "nope" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("kind");
    expect(store.countCardTraceEvents()).toBe(0);
  });

  it("SOBREVIVE a restart: fechar e reabrir o mesmo banco mantém os eventos", () => {
    store = fresh();
    const dirPath = dir!;
    store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 100, kind: "spawn", boardId: "64", tail: "cauda" });
    store.close();
    store = openStore(dirPath);
    const events = store.getCardTraceEvents("c1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ task_id: "t1", card_id: "c1", at: 100, kind: "spawn", tail: "cauda", tail_bytes: 5 });
  });

  it("a PORTA DE EXCLUSÃO apaga de verdade: deleteCard leva cards + card_traces + card_trace_events", () => {
    store = fresh();
    store.upsertCard(card("c1"));
    store.upsertCard(card("c2"));
    store.saveCardTrace(trace("c1", 999));
    store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 100, kind: "spawn" });
    store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 200, kind: "close" });
    store.saveCardTraceEvent({ taskId: "t1", cardId: "c2", at: 300, kind: "spawn" });

    store.deleteCard("c1");

    expect(store.getCardTrace("c1")).toBeUndefined(); // retrato do fecho foi junto
    expect(store.getCardTraceEvents("c1")).toEqual([]); // e o STREAM também
    expect(store.countCardTraceEvents()).toBe(1); // o evento do OUTRO card permanece
    expect(store.getCardTraceEvents("c2")).toHaveLength(1);
  });

  it("leitura por TASK e por BOARD (as duas portas que o índice serve)", () => {
    store = fresh();
    store.saveCardTraceEvent({ taskId: "t1", cardId: "c1", at: 100, kind: "spawn", boardId: "64" });
    store.saveCardTraceEvent({ taskId: "t1", cardId: "c2", at: 200, kind: "turn_end", boardId: "64" });
    store.saveCardTraceEvent({ taskId: "t2", cardId: "c3", at: 300, kind: "spawn", boardId: "77" });

    expect(store.getCardTraceEventsForTask("t1").map((e) => e.card_id)).toEqual(["c1", "c2"]);
    expect(store.getCardTraceEventsForBoard("64")).toHaveLength(2);
    expect(store.getCardTraceEventsForBoard("77")).toHaveLength(1);
    store.deleteCardTraceEventsForTask("t1");
    expect(store.countCardTraceEvents()).toBe(1);
  });
});
