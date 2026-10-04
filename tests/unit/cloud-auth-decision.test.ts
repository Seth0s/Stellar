/**
 * cloud-auth-decision.ts — a decisão pura do login (BACKEND_V1.md §4).
 * Trava: PKCE S256 (vetor da RFC 7636), redirect loopback EXATO, state errado
 * RECUSADO, leitura da resposta de tokens, renovação antes de expirar, `/me`
 * tolerante, envelope de erro e a montagem das requisições.
 */
import { describe, it, expect } from "vitest";
import {
  buildEmailStartBody,
  buildRefreshBody,
  buildStartUrl,
  buildTokenExchangeBody,
  CLOUD_API_DEFAULT,
  decideCallback,
  decideTokenRenewal,
  isLoopbackRedirectUri,
  isValidCodeChallenge,
  isValidCodeVerifier,
  loopbackRedirectForPort,
  parseCloudApiError,
  parseMe,
  parseTokenPair,
  pkceChallengeS256,
  resolveCloudApiBaseUrl,
} from "../../src/main/cloud-auth-decision";

describe("PKCE", () => {
  it("S256 bate o vetor da RFC 7636 (Appendix B)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(isValidCodeVerifier(verifier)).toBe(true);
    expect(isValidCodeChallenge(pkceChallengeS256(verifier))).toBe(true);
  });

  it("recusa verifier fora de 43..128 ou com caractere proibido", () => {
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43) + "!")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
  });

  it("challenge tem de ter 43 chars base64url", () => {
    expect(isValidCodeChallenge("a".repeat(42))).toBe(false);
    expect(isValidCodeChallenge("a".repeat(43) + "!")).toBe(false);
    expect(isValidCodeChallenge("a".repeat(43))).toBe(true);
  });
});

describe("redirect loopback", () => {
  it("gera o redirect que o backend aceita", () => {
    expect(loopbackRedirectForPort(45678)).toBe("http://127.0.0.1:45678/cb");
    expect(isLoopbackRedirectUri(loopbackRedirectForPort(1))).toBe(true);
  });

  it("recusa host não-exato, userinfo e scheme estranho (espelha o backend)", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.2:1234/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://localhost:1234/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://user@127.0.0.1:1234/cb")).toBe(false);
    expect(isLoopbackRedirectUri("ftp://127.0.0.1:1234/cb")).toBe(false);
    expect(isLoopbackRedirectUri("not a url")).toBe(false);
  });
});

describe("decideCallback", () => {
  const state = "S";

  it("code + state certos => ok", () => {
    expect(decideCallback({ state, code: "abc" }, state)).toEqual({ kind: "ok", code: "abc" });
  });

  it("state errado OU ausente => RECUSA (antes de olhar o code)", () => {
    expect(decideCallback({ state: "outro", code: "abc" }, state)).toEqual({ kind: "error", reason: "state-mismatch" });
    expect(decideCallback({ code: "abc" }, state)).toEqual({ kind: "error", reason: "state-mismatch" });
  });

  it("erro do provedor e code ausente são recusas distintas", () => {
    expect(decideCallback({ state, error: "access_denied" }, state)).toEqual({ kind: "error", reason: "provider-error" });
    expect(decideCallback({ state }, state)).toEqual({ kind: "error", reason: "missing-code" });
  });
});

describe("parseTokenPair", () => {
  it("aceita o par completo", () => {
    expect(parseTokenPair({ access_token: "a", refresh_token: "r", expires_in: 900, refresh_expires_in: 100 })).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresInSec: 900,
      refreshExpiresInSec: 100,
    });
  });

  it("recusa faltando campo", () => {
    expect(parseTokenPair({ access_token: "a", refresh_token: "r" })).toBeNull();
    expect(parseTokenPair({ access_token: "", refresh_token: "r", expires_in: 900 })).toBeNull();
    expect(parseTokenPair(null)).toBeNull();
  });
});

describe("decideTokenRenewal", () => {
  it("válido longe de expirar; renova dentro da folga", () => {
    const obtainedAtMs = 1_000_000;
    expect(decideTokenRenewal({ obtainedAtMs, expiresInSec: 900, nowMs: obtainedAtMs + 1000 })).toBe("valid");
    // 900s de vida, folga de 60s: em t+850s já renova.
    expect(decideTokenRenewal({ obtainedAtMs, expiresInSec: 900, nowMs: obtainedAtMs + 850_000 })).toBe("renew");
    expect(decideTokenRenewal({ obtainedAtMs, expiresInSec: 900, nowMs: obtainedAtMs + 900_000 })).toBe("renew");
  });
});

describe("parseMe", () => {
  it("lê display_name e identidades", () => {
    const me = parseMe({
      account: { display_name: "Lucas" },
      identities: [
        { kind: "github", subject: "42", login: "seth" },
        { kind: "email", subject: "a@b", login: null },
      ],
    });
    expect(me?.displayName).toBe("Lucas");
    expect(me?.identities).toEqual([
      { kind: "github", subject: "42", login: "seth" },
      { kind: "email", subject: "a@b", login: null },
    ]);
  });

  it("sem display_name cai no login/subject da 1ª identidade", () => {
    expect(parseMe({ account: {}, identities: [{ kind: "github", subject: "42", login: "seth" }] })?.displayName).toBe("seth");
    expect(parseMe({ account: {}, identities: [{ kind: "email", subject: "a@b" }] })?.displayName).toBe("a@b");
  });

  it("sem account é nulo", () => {
    expect(parseMe({ identities: [] })).toBeNull();
    expect(parseMe(null)).toBeNull();
  });
});

describe("parseCloudApiError", () => {
  it("lê o envelope { error: { code, message } }", () => {
    expect(parseCloudApiError(401, { error: { code: "invalid_grant", message: "invalid grant" } }, "fb")).toEqual({
      status: 401,
      code: "invalid_grant",
      message: "invalid grant",
    });
  });
  it("cai no fallback quando não há envelope", () => {
    expect(parseCloudApiError(500, null, "boom")).toEqual({ status: 500, code: "unknown", message: "boom" });
  });
});

describe("montagem das requisições", () => {
  it("buildStartUrl carrega os params exigidos e o user_id local", () => {
    const url = new URL(
      buildStartUrl({
        apiBaseUrl: "http://127.0.0.1:8080",
        provider: "github",
        redirectUri: "http://127.0.0.1:5555/cb",
        state: "S",
        codeChallenge: "C".repeat(43),
        userId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(url.pathname).toBe("/v1/auth/start");
    expect(url.searchParams.get("provider")).toBe("github");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555/cb");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("user_id")).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("corpos têm as chaves que o backend lê", () => {
    expect(buildEmailStartBody({ provider: "email", redirectUri: "u", state: "s", codeChallenge: "c", email: "a@b" })).toMatchObject({
      provider: "email",
      redirect_uri: "u",
      code_challenge_method: "S256",
      email: "a@b",
    });
    expect(buildTokenExchangeBody({ code: "c", codeVerifier: "v", redirectUri: "u", installId: "i", deviceLabel: "d" })).toEqual({
      grant_type: "authorization_code",
      code: "c",
      code_verifier: "v",
      redirect_uri: "u",
      install_id: "i",
      device_label: "d",
    });
    expect(buildRefreshBody({ refreshToken: "r", installId: "i", deviceLabel: "d" })).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r",
      install_id: "i",
      device_label: "d",
    });
  });
});

describe("resolveCloudApiBaseUrl", () => {
  it("env vence e tira barra final; sem env, produção", () => {
    expect(resolveCloudApiBaseUrl({ STELLARCLOUD_API_URL: "http://127.0.0.1:9999/" })).toBe("http://127.0.0.1:9999");
    expect(resolveCloudApiBaseUrl({})).toBe(CLOUD_API_DEFAULT);
  });
});
