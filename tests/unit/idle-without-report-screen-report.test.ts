import { describe, expect, it } from "vitest";
import {
  MIN_REPORT_SHAPE_KEYS,
  decideIdleWithoutReport,
  looksLikeReportShape,
  screenReportPointerBody,
} from "../../src/main/idle-without-report-decision";

/**
 * A card that reports on screen only: when a turn ends without a `report`
 * since the last delivery and the output carries a report's shape (the
 * `reportSchema` keys), the orchestrator notice says so instead of the generic
 * "idle without report".
 */

// Recorded output: the full report written to the terminal, carrying the
// contract's keys, with no call to the report tool.
const RECORDED_SCREEN = [
  "cadeia concluída.",
  "",
  "filesChanged:",
  "  - src/main/foo.ts",
  "  - src/main/foo.test.ts",
  "",
  "gatesOutput:",
  "  npm run check:types -> 0",
  "  npx vitest run -> 3449 passed",
  "",
  "oQueNaoFiz: nada.",
].join("\n");

const REPORT_SCHEMA = ["filesChanged", "gatesOutput", "oQueNaoFiz"];

describe("looksLikeReportShape (pura)", () => {
  it("a saída gravada casa o reportSchema (>= MIN chaves distintas)", () => {
    expect(looksLikeReportShape(RECORDED_SCREEN, REPORT_SCHEMA)).toBe(true);
  });

  it("UMA chave só NÃO basta quando o schema tem várias (min 2)", () => {
    expect(MIN_REPORT_SHAPE_KEYS).toBe(2);
    expect(looksLikeReportShape("só mention filesChanged aqui", REPORT_SCHEMA)).toBe(false);
  });

  it("schema de UMA chave casa com essa chave", () => {
    expect(looksLikeReportShape("... gatesOutput: ok ...", ["gatesOutput"])).toBe(true);
  });

  it("sem reportSchema declarado NÃO há forma a casar → false (nunca um palpite)", () => {
    expect(looksLikeReportShape(RECORDED_SCREEN, [])).toBe(false);
    expect(looksLikeReportShape(RECORDED_SCREEN, ["", "  "])).toBe(false);
  });

  it("texto normal, sem as chaves → false", () => {
    expect(looksLikeReportShape("bom dia, tudo certo por aqui", REPORT_SCHEMA)).toBe(false);
  });
});

const base = {
  alive: true,
  waitingOnConsent: false,
  reportedSinceWorkGranted: false,
  answeredDirectorSinceWorkGranted: false,
  declaredIdle: true,
  hasLinkedRunningTask: true,
  alreadyNotified: false,
  msSinceLastActivity: 10_000,
  hasAgentReader: true,
};

describe("decideIdleWithoutReport — notify_screen_report", () => {
  it("turno encerrado + relatório na tela → notify_screen_report (precede o genérico)", () => {
    expect(decideIdleWithoutReport({ ...base, screenLooksLikeReport: true })).toEqual({ action: "notify_screen_report" });
  });

  it("mesmo SEM leitor da linha, o relatório na tela ainda é dito (foi ESCRITO)", () => {
    expect(decideIdleWithoutReport({ ...base, hasAgentReader: false, screenLooksLikeReport: true })).toEqual({ action: "notify_screen_report" });
  });

  it("sem o fato, o comportamento é o de antes (idle declarado → notify)", () => {
    expect(decideIdleWithoutReport({ ...base })).toEqual({ action: "notify" });
    expect(decideIdleWithoutReport({ ...base, declaredIdle: false, msSinceLastActivity: 200_000 })).toEqual({ action: "notify_unproven" });
  });

  it("o corpo do aviso diz o que se vê (relatório na tela, sem report)", () => {
    expect(screenReportPointerBody()).toMatch(/on screen/i);
    expect(screenReportPointerBody()).toMatch(/report left on screen/i);
  });
});
