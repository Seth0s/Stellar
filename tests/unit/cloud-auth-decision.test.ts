/**
 * cloud-auth-decision.ts — a decisão pura do login (BACKEND_V1.md §4).
 * Trava: PKCE S256 (vetor da RFC 7636), redirect loopback EXATO, state errado
 * RECUSADO, leitura da resposta de tokens, renovação antes de expirar, `/me`
 * tolerante, envelope de erro e a montagem das requisições.
 */
import { describe, it, expect } from "vitest";
import {
  buildEmailCodeClaimBody,
  buildEmailDeviceStartBody,
  buildEmailPollBody,
  buildRefreshBody,
  buildStartUrl,
  buildTokenExchangeBody,
  classifyCodeClaimResponse,
  classifyPollResponse,
  CLOUD_API_DEFAULT,
  CODE_CLAIM_MAX_ATTEMPTS,
  decideCallback,
  decidePollStep,
  decideTokenRenewal,
  initialPollState,
  isLoopbackRedirectUri,
  isValidCodeChallenge,
  isValidCodeVerifier,
  loopbackRedirectForPort,
  normalizeUserCode,
  parseCloudApiError,
  parseDeviceTokenReply,
  parseEmailDeviceStart,
  parseMe,
  parseTokenPair,
  pkceChallengeS256,
  parseCloudApiOverride,
  POLL_BACKOFF_CEILING_MS,
  POLL_MAX_CONSECUTIVE_FAILURES,
  resolveCloudApiBaseUrl,
  SLOW_DOWN_STEP_MS,
  type CloudApiError,
  type ParsedTokenPair,
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

  it("signup_closed is a distinct refusal (test-period closed registration)", () => {
    expect(decideCallback({ state, error: "signup_closed" }, state)).toEqual({
      kind: "error",
      reason: "signup-closed",
    });
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
    expect(resolveCloudApiBaseUrl({ STELLARCLOUD_API_URL: "   " })).toBe(CLOUD_API_DEFAULT);
  });

  it("aceita http só em loopback e https em qualquer host (fora do empacotado)", () => {
    const resolve = (url: string) => resolveCloudApiBaseUrl({ STELLARCLOUD_API_URL: url }, { packaged: false });
    expect(resolve("http://localhost:18082")).toBe("http://localhost:18082");
    expect(resolve("http://[::1]:18082/")).toBe("http://[::1]:18082");
    expect(resolve("https://api.staging.example.com/")).toBe("https://api.staging.example.com");
    expect(resolve("https://example.com/stellar/")).toBe("https://example.com/stellar");
  });

  it("recusa o resto e cai em produção, sem usar o valor", () => {
    const resolve = (url: string, packaged = false) =>
      resolveCloudApiBaseUrl({ STELLARCLOUD_API_URL: url }, { packaged });
    for (const bad of [
      "http://example.com",
      "http://192.168.0.10:8080",
      "ftp://127.0.0.1",
      "http://127.0.0.1.evil.com",
      "http://user:pw@127.0.0.1:8080",
      "https://example.com?x=1",
      "not a url",
    ]) {
      expect(resolve(bad), bad).toBe(CLOUD_API_DEFAULT);
    }
  });

  it("no app empacotado só loopback: https de outro host é recusado", () => {
    const resolve = (url: string) => resolveCloudApiBaseUrl({ STELLARCLOUD_API_URL: url }, { packaged: true });
    expect(resolve("https://api.staging.example.com")).toBe(CLOUD_API_DEFAULT);
    expect(resolve("http://127.0.0.1:18082")).toBe("http://127.0.0.1:18082");
    expect(resolve("https://localhost:8443")).toBe("https://localhost:8443");
  });
});

describe("parseCloudApiOverride", () => {
  it("normaliza e devolve null para o que a regra recusa", () => {
    expect(parseCloudApiOverride("http://127.0.0.1:1/")).toBe("http://127.0.0.1:1");
    expect(parseCloudApiOverride("http://example.com")).toBeNull();
    expect(parseCloudApiOverride("https://example.com", { loopbackOnly: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Login por e-mail em device flow
// ---------------------------------------------------------------------------

const PAIR: ParsedTokenPair = { accessToken: "A", refreshToken: "R", expiresInSec: 900, refreshExpiresInSec: 0 };
const apiErr = (status: number, code: string): CloudApiError => ({ status, code, message: "m" });

describe("device flow: corpos e leitura do pedido", () => {
  it("o pedido NÃO leva redirect_uri nem state (é isso que escolhe o device flow)", () => {
    const body = buildEmailDeviceStartBody({
      email: "a@b",
      codeChallenge: "C".repeat(43),
      installId: "inst",
      deviceLabel: "meu-pc",
      userId: "uid",
    });
    expect(body).toEqual({
      email: "a@b",
      code_challenge: "C".repeat(43),
      code_challenge_method: "S256",
      install_id: "inst",
      device_label: "meu-pc",
      user_id: "uid",
    });
    expect(body).not.toHaveProperty("redirect_uri");
    expect(body).not.toHaveProperty("state");
  });

  it("device_label vazio some e o grande é cortado em 64; sem user_id, não vai", () => {
    expect(buildEmailDeviceStartBody({ email: "a@b", codeChallenge: "c", installId: "i", deviceLabel: "  " })).not.toHaveProperty("device_label");
    const long = buildEmailDeviceStartBody({ email: "a@b", codeChallenge: "c", installId: "i", deviceLabel: "x".repeat(200), userId: null });
    expect(long.device_label).toHaveLength(64);
    expect(long).not.toHaveProperty("user_id");
  });

  it("poll e code-claim levam request_id + verifier + install_id (e o código)", () => {
    const input = { requestId: "r", codeVerifier: "v", installId: "i" };
    expect(buildEmailPollBody(input)).toEqual({ request_id: "r", code_verifier: "v", install_id: "i" });
    expect(buildEmailCodeClaimBody({ ...input, userCode: "481-925" })).toEqual({
      request_id: "r",
      code_verifier: "v",
      install_id: "i",
      user_code: "481-925",
    });
  });

  it("lê o 202: request_id obrigatório, intervalo em ms limitado, padrões quando faltam", () => {
    expect(parseEmailDeviceStart({ request_id: "r1", poll_interval_sec: 3, expires_in: 300 })).toEqual({
      requestId: "r1",
      pollIntervalMs: 3000,
      expiresInMs: 300_000,
    });
    expect(parseEmailDeviceStart({ request_id: "r1" })).toEqual({ requestId: "r1", pollIntervalMs: 3000, expiresInMs: 300_000 });
    expect(parseEmailDeviceStart({ request_id: "r1", poll_interval_sec: 9999 })?.pollIntervalMs).toBe(30_000);
    expect(parseEmailDeviceStart({ request_id: "r1", poll_interval_sec: -1 })?.pollIntervalMs).toBe(3000);
    expect(parseEmailDeviceStart({ status: "sent" })).toBeNull();
    expect(parseEmailDeviceStart({ request_id: "" })).toBeNull();
    expect(parseEmailDeviceStart(null)).toBeNull();
  });

  it("lê a resposta do poll: pending, par de tokens, ou nada reconhecível", () => {
    expect(parseDeviceTokenReply({ status: "pending" })).toEqual({ kind: "pending" });
    expect(parseDeviceTokenReply({ access_token: "A", refresh_token: "R", expires_in: 900 })).toMatchObject({ kind: "tokens" });
    expect(parseDeviceTokenReply({ status: "weird" })).toBeNull();
    expect(parseDeviceTokenReply(null)).toBeNull();
  });
});

describe("normalizeUserCode", () => {
  it("aceita 481-925, 481925 e com espaço; recusa o resto sem mandar nada", () => {
    expect(normalizeUserCode("481-925")).toBe("481-925");
    expect(normalizeUserCode("481925")).toBe("481-925");
    expect(normalizeUserCode(" 481 925 ")).toBe("481-925");
    expect(normalizeUserCode("48192")).toBeNull();
    expect(normalizeUserCode("4819250")).toBeNull();
    expect(normalizeUserCode("48a-925")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });
});

describe("classifyPollResponse: resposta → estado", () => {
  it("200 pending, 200 tokens", () => {
    expect(classifyPollResponse({ ok: true, value: { kind: "pending" } })).toEqual({ kind: "pending" });
    expect(classifyPollResponse({ ok: true, value: { kind: "tokens", pair: PAIR } })).toEqual({ kind: "approved", pair: PAIR });
  });

  it.each([
    ["slow_down", 429, "slow_down"],
    ["expired_token", 400, "expired"],
    ["access_denied", 400, "denied"],
    ["invalid_grant", 400, "rejected"],
    ["invalid_request", 400, "rejected"],
  ])("%s (%i) → %s", (code, status, kind) => {
    expect(classifyPollResponse({ ok: false, error: apiErr(status, code) }).kind).toBe(kind);
  });

  it("rate_limited, 5xx e rede são transitórios (tenta de novo)", () => {
    for (const e of [apiErr(429, "rate_limited"), apiErr(503, "unavailable"), apiErr(0, "network"), apiErr(0, "timeout")]) {
      expect(classifyPollResponse({ ok: false, error: e }).kind).toBe("transient");
    }
  });
});

describe("decidePollStep: o próximo passo do polling", () => {
  const state = initialPollState(3000);
  const step = (outcome: Parameters<typeof decidePollStep>[0]["outcome"], codeAttempts = 0, s = state) =>
    decidePollStep({ outcome, state: s, codeAttempts });

  it("aprovado entrega o par; pending espera o intervalo do servidor", () => {
    expect(step({ kind: "approved", pair: PAIR })).toEqual({ kind: "complete", pair: PAIR });
    expect(step({ kind: "pending" })).toMatchObject({ kind: "wait", delayMs: 3000 });
  });

  it("slow_down aumenta o intervalo e o novo ritmo vale daí em diante, até o teto", () => {
    const first = step({ kind: "slow_down" });
    expect(first).toMatchObject({ kind: "wait", delayMs: 3000 + SLOW_DOWN_STEP_MS });
    if (first.kind !== "wait") throw new Error("esperava wait");
    // um pending depois NÃO volta ao ritmo antigo
    expect(step({ kind: "pending" }, 0, first.state)).toMatchObject({ kind: "wait", delayMs: 3000 + SLOW_DOWN_STEP_MS });
    let s = first.state;
    for (let i = 0; i < 20; i++) {
      const next = step({ kind: "slow_down" }, 0, s);
      if (next.kind !== "wait") throw new Error("esperava wait");
      s = next.state;
    }
    expect(s.intervalMs).toBe(POLL_BACKOFF_CEILING_MS);
  });

  it("expirado, recusado e rejeitado encerram com o código certo", () => {
    expect(step({ kind: "expired" })).toEqual({ kind: "fail", code: "login_timeout" });
    expect(step({ kind: "rejected" })).toEqual({ kind: "fail", code: "email_failed" });
  });

  it("denied sem código digitado aqui = cadastro fechado; com código errado = bloqueio das 3 tentativas", () => {
    expect(step({ kind: "denied" }, 0)).toEqual({ kind: "fail", code: "signup_closed" });
    expect(step({ kind: "denied" }, 1)).toEqual({ kind: "blocked" });
  });

  it("falha transitória dobra o intervalo (com teto), e uma boa volta ao do servidor", () => {
    const e = apiErr(0, "network");
    const a = step({ kind: "transient", error: e });
    expect(a).toMatchObject({ kind: "wait", delayMs: 6000 });
    if (a.kind !== "wait") throw new Error("esperava wait");
    expect(a.state.consecutiveFailures).toBe(1);
    const ok = step({ kind: "pending" }, 0, a.state);
    expect(ok).toMatchObject({ kind: "wait", delayMs: 3000 });
    if (ok.kind !== "wait") throw new Error("esperava wait");
    expect(ok.state.consecutiveFailures).toBe(0);
  });

  it("uma sequência de falhas desiste como erro de conexão, no código certo", () => {
    for (const [e, code] of [
      [apiErr(0, "network"), "network"],
      [apiErr(0, "timeout"), "timeout"],
      [apiErr(503, "unavailable"), "api_unavailable"],
    ] as const) {
      let s = state;
      let last = step({ kind: "transient", error: e }, 0, s);
      for (let i = 1; i < POLL_MAX_CONSECUTIVE_FAILURES; i++) {
        if (last.kind !== "wait") break;
        s = last.state;
        last = step({ kind: "transient", error: e }, 0, s);
      }
      expect(last).toEqual({ kind: "fail", code });
    }
  });
});

describe("classifyCodeClaimResponse: código digitado", () => {
  const claim = (res: Parameters<typeof classifyCodeClaimResponse>[0], before = 0) => classifyCodeClaimResponse(res, before);
  const err = (status: number, code: string) => ({ ok: false as const, error: apiErr(status, code) });

  it("código certo entrega o par", () => {
    expect(claim({ ok: true, value: { kind: "tokens", pair: PAIR } })).toEqual({ kind: "approved", pair: PAIR });
  });

  it("errado ×3: restam 2, restam 1 e na terceira o pedido é bloqueado", () => {
    expect(claim(err(400, "invalid_code"), 0)).toEqual({ kind: "wrong", attemptsLeft: 2 });
    expect(claim(err(400, "invalid_code"), 1)).toEqual({ kind: "wrong", attemptsLeft: 1 });
    expect(claim(err(400, "invalid_code"), CODE_CLAIM_MAX_ATTEMPTS - 1)).toEqual({ kind: "blocked" });
  });

  it("access_denied é bloqueio mesmo sem a contagem local (o servidor manda)", () => {
    expect(claim(err(400, "access_denied"), 0)).toEqual({ kind: "blocked" });
  });

  it("authorization_pending e código malformado não gastam tentativa", () => {
    expect(claim(err(400, "authorization_pending"))).toEqual({ kind: "not-spent" });
    expect(claim(err(400, "invalid_request"))).toEqual({ kind: "not-spent" });
  });

  it("expirado, prova recusada e sem conexão", () => {
    expect(claim(err(400, "expired_token"))).toEqual({ kind: "expired" });
    expect(claim(err(400, "invalid_grant"))).toEqual({ kind: "stale" });
    expect(claim(err(0, "network"))).toEqual({ kind: "unreachable", code: "network" });
    expect(claim(err(0, "timeout"))).toEqual({ kind: "unreachable", code: "timeout" });
    expect(claim(err(429, "rate_limited"))).toEqual({ kind: "unreachable", code: "rate_limited" });
    expect(claim(err(503, "x"))).toEqual({ kind: "unreachable", code: "api_unavailable" });
  });
});
