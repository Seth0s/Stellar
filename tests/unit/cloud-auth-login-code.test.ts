/**
 * LoginScreenCode.ts — o campo do código de confirmação do login por e-mail:
 * o que o status do main diz (tentativas, bloqueio), a máscara 481-925 e a
 * mensagem de cada resultado.
 */
import { describe, expect, it } from "vitest";
import type { CloudStatusInfo } from "../../src/preload/index";
import {
  feedbackForClaim,
  formatUserCodeInput,
  isCodeComplete,
  readCodeStatus,
  wrongCodeKey,
} from "../../src/renderer/src/LoginScreenCode";

const pending = (extra: object = {}): CloudStatusInfo => ({ state: "pending", apiBaseUrl: "x", provider: "email", ...extra });

describe("readCodeStatus", () => {
  it("só lê de um pending; sem sinal, sem tentativas gastas e sem bloqueio", () => {
    expect(readCodeStatus(null)).toEqual({ attemptsLeft: null, blocked: false });
    expect(readCodeStatus({ state: "logged-out", apiBaseUrl: "x", lastError: null })).toEqual({ attemptsLeft: null, blocked: false });
    expect(readCodeStatus(pending())).toEqual({ attemptsLeft: null, blocked: false });
  });

  it("tentativas restantes e bloqueio vêm do pending", () => {
    expect(readCodeStatus(pending({ codeAttemptsLeft: 1 }))).toEqual({ attemptsLeft: 1, blocked: false });
    expect(readCodeStatus(pending({ codeAttemptsLeft: 0, codeBlocked: true }))).toEqual({ attemptsLeft: 0, blocked: true });
  });
});

describe("formatUserCodeInput / isCodeComplete", () => {
  it("só dígitos, traço depois do terceiro, no máximo 6 dígitos", () => {
    expect(formatUserCodeInput("4")).toBe("4");
    expect(formatUserCodeInput("481")).toBe("481");
    expect(formatUserCodeInput("4819")).toBe("481-9");
    expect(formatUserCodeInput("481-925")).toBe("481-925");
    expect(formatUserCodeInput("48a1 92 5 77")).toBe("481-925");
    expect(formatUserCodeInput("")).toBe("");
  });

  it("completo só com 481-925", () => {
    expect(isCodeComplete("481-925")).toBe(true);
    expect(isCodeComplete("481-92")).toBe(false);
    expect(isCodeComplete("")).toBe(false);
  });
});

describe("mensagem do código errado", () => {
  it("'Restam N' e, na última, 'Resta 1'", () => {
    expect(wrongCodeKey(2)).toBe("LoginScreen.code.wrong");
    expect(wrongCodeKey(1)).toBe("LoginScreen.code.wrongLast");
  });
});

describe("feedbackForClaim", () => {
  it("errado mostra o que o main contou; não gasto usa o que o status já sabia (3 se nada foi gasto)", () => {
    expect(feedbackForClaim({ kind: "wrong", attemptsLeft: 2 }, null)).toEqual({ kind: "wrong", attemptsLeft: 2 });
    expect(feedbackForClaim({ kind: "not-spent" }, null)).toEqual({ kind: "wrong", attemptsLeft: 3 });
    expect(feedbackForClaim({ kind: "not-spent" }, 1)).toEqual({ kind: "wrong", attemptsLeft: 1 });
  });

  it("sem conexão vira a mensagem de conexão da tela; certo, bloqueado e encerrado não escrevem nada (o status move a tela)", () => {
    expect(feedbackForClaim({ kind: "unreachable", code: "network" }, null)).toEqual({ kind: "unreachable", key: "cloud.error.network" });
    expect(feedbackForClaim({ kind: "unreachable", code: "rate_limited" }, null)).toEqual({ kind: "unreachable", key: "cloud.error.rateLimited" });
    for (const kind of ["approved", "blocked", "ended"] as const) {
      expect(feedbackForClaim({ kind }, null)).toEqual({ kind: "none" });
    }
  });
});
