import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PAGE_TEXT_CHARS,
  MAX_MAX_PAGE_TEXT_CHARS,
  MIN_MAX_PAGE_TEXT_CHARS,
  decidePageTextRequest,
  describePageTextTruncation,
} from "../../src/main/browser-page-text-decision";

/**
 * Lacuna 1 da task 3d58046c — `get_page_text` sem escopo queimava contexto.
 * O teste nasce VERMELHO em HEAD porque este módulo não existia (import
 * quebrado); a prova de que ele está AMARRADO ao comportamento é a mutação no
 * clamp (ver o relatório).
 */
describe("decidePageTextRequest — escopo e teto (lacuna 1)", () => {
  it("sem seletor => página inteira, teto default (o comportamento de hoje, preservado)", () => {
    expect(decidePageTextRequest({})).toEqual({
      scope: { scope: "body" },
      cap: DEFAULT_MAX_PAGE_TEXT_CHARS,
      requestedCap: null,
      clamped: null,
    });
  });

  it("seletor vira ESCOPO; vazio/só-espaço é ausente (não um seletor inválido)", () => {
    expect(decidePageTextRequest({ selector: "  #lista  " })).toEqual({
      scope: { scope: "selector", selector: "#lista" },
      cap: DEFAULT_MAX_PAGE_TEXT_CHARS,
      requestedCap: null,
      clamped: null,
    });
    expect(decidePageTextRequest({ selector: "   " }).scope).toEqual({ scope: "body" });
  });

  it("maxChars no meio da faixa é obedecido; abaixo do piso e acima do teto são CLAMPADOS e o clamp é DITO", () => {
    expect(decidePageTextRequest({ maxChars: 5000 })).toEqual({
      scope: { scope: "body" },
      cap: 5000,
      requestedCap: 5000,
      clamped: null,
    });
    expect(decidePageTextRequest({ maxChars: 10 })).toEqual({
      scope: { scope: "body" },
      cap: MIN_MAX_PAGE_TEXT_CHARS,
      requestedCap: 10,
      clamped: "below-min",
    });
    expect(decidePageTextRequest({ maxChars: 10_000_000 })).toEqual({
      scope: { scope: "body" },
      cap: MAX_MAX_PAGE_TEXT_CHARS,
      requestedCap: 10_000_000,
      clamped: "above-max",
    });
  });

  it("maxChars não-finito / 0 / negativo => ausente (o default), nunca uma string vazia", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decidePageTextRequest({ maxChars: bad }).cap).toBe(DEFAULT_MAX_PAGE_TEXT_CHARS);
      expect(decidePageTextRequest({ maxChars: bad }).requestedCap).toBeNull();
    }
  });
});

describe("describePageTextTruncation — corte NUNCA é mudo", () => {
  it("não cortou => null (nada a dizer)", () => {
    expect(describePageTextTruncation({ truncated: false, totalChars: 100, cap: 500 })).toBeNull();
  });

  it("cortou => diz o teto, o total REAL e que o resto existe e não foi lido", () => {
    const msg = describePageTextTruncation({ truncated: true, totalChars: 42_000, cap: 5000 })!;
    expect(msg).toContain("showing the first 5000 of 42000 characters");
    expect(msg).toContain("selector");
    expect(msg).toContain("maxChars");
    expect(msg).toMatch(/NOT read/);
  });
});
