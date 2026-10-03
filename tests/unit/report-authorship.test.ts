import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, deriveReportAuthorship, type CardTraceRow, type ReportRow } from "../../src/main/store";

/**
 * Task f2559b9b — DE QUEM É UM REPORT sob um card que não é o autor.
 *
 * O defeito: 22 reports ficaram gravados sob um card `cline` que o dono fechou,
 * mas foram escritos por >= 4 cards diferentes pelo hub compartilhado. A regra
 * de leitura usa o marcador `card_traces` onde ele alcança, e uma LISTA DATADA
 * declarada onde ele não alcança. Nada é apagado nem re-atribuído.
 *
 * Fixtures construídas aqui — este teste NUNCA abre o banco vivo.
 */

describe("deriveReportAuthorship (puro)", () => {
  it("escrita DEPOIS do fecho (marcador card_traces) → unattributable", () => {
    const got = deriveReportAuthorship({ cardId: "c1", reportUpdatedAt: 200, cardClosedAt: 100 });
    expect(got).toMatchObject({ authorship: "unattributable", rule: "written_after_card_closed", ghostCardId: "c1" });
  });

  it("escrita ANTES do fecho, ou card sem trace e id comum → attributable", () => {
    expect(deriveReportAuthorship({ cardId: "c1", reportUpdatedAt: 100, cardClosedAt: 200 }).rule).toBe("attributable");
    expect(deriveReportAuthorship({ cardId: "c2", reportUpdatedAt: 999, cardClosedAt: null }).rule).toBe("attributable");
  });

  it("id fantasma CONHECIDO sem trace → unattributable (é o caso do 97924181)", () => {
    const got = deriveReportAuthorship({ cardId: "97924181", reportUpdatedAt: 1790092391478, cardClosedAt: null });
    expect(got).toMatchObject({ authorship: "unattributable", rule: "known_ghost_card", ghostCardId: "97924181" });
    expect(got.cardClosedAt).toBeNull();
    // A lista é DECLARADA e existe: id fora dela não vira fantasma por engano.
    expect(deriveReportAuthorship({ cardId: "97924180", reportUpdatedAt: 1, cardClosedAt: null }).rule).toBe("attributable");
  });

  it("a lista é injetável (a produção usa a declarada)", () => {
    const got = deriveReportAuthorship({
      cardId: "ghost-x",
      reportUpdatedAt: 1,
      cardClosedAt: null,
      knownGhostCards: [{ cardId: "ghost-x", since: 0, note: "fixture" }],
    });
    expect(got.rule).toBe("known_ghost_card");
  });
});

describe("getReport apresenta o authorship (fixture)", () => {
  let dir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;
  afterEach(() => {
    (store as unknown as { close?: () => void } | null)?.close?.();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function trace(cardId: string, closedAt: number): CardTraceRow {
    return {
      card_id: cardId,
      board_id: "b",
      closed_at: closedAt,
      screen_stored: 0,
      tail: "",
      tail_bytes: 0,
      tail_at_cap: 0,
      redacted: 0,
      spawned_at_ms: null,
      last_activity_at: null,
      turn_ended_at: null,
      quota_death: 0,
      kill_requested: 0,
    };
  }
  function report(cardId: string, seq: number, updatedAt: number): ReportRow {
    return { card_id: cardId, seq, report_json: "{}", verdict: null, role: null, updated_at: updatedAt };
  }

  it("marcador card_traces: report escrito depois do fecho é UNATTRIBUTABLE na leitura", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-authorship-"));
    store = openStore(dir);
    store.saveCardTrace(trace("c-closed", 100));
    store.upsertReport(report("c-closed", 1, 200));
    expect(store.getReport("c-closed")?.authorship).toMatchObject({
      authorship: "unattributable",
      rule: "written_after_card_closed",
    });
  });

  it("id fantasma declarado sem trace também é UNATTRIBUTABLE (o caso 97924181)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-authorship-"));
    store = openStore(dir);
    store.upsertReport(report("97924181", 666, 1790092391478));
    expect(store.getReport("97924181")?.authorship).toMatchObject({
      authorship: "unattributable",
      rule: "known_ghost_card",
    });
  });

  it("card comum → attributable (a linha não é reescrita, só lida)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-authorship-"));
    store = openStore(dir);
    store.upsertReport(report("c-ok", 7, 50));
    const row = store.getReport("c-ok");
    expect(row?.authorship?.rule).toBe("attributable");
    // A LINHA continua como sempre: mesmo card_id, mesma seq, mesmo corpo.
    expect(row).toMatchObject({ card_id: "c-ok", seq: 7, report_json: "{}" });
  });
});
