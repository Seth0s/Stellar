/**
 * Login na conta Stellar (BACKEND_V1.md §4/§7.2) — a DECISÃO, sem I/O.
 *
 * O fluxo é o de app nativo (RFC 8252): listener loopback + PKCE S256. Este
 * módulo concentra o que dá para testar sem rede nem relógio: geração/validação
 * de PKCE, validação do redirect loopback, decisão do callback (state errado
 * RECUSADO), leitura da resposta de tokens, decisão de RENOVAÇÃO antes de
 * expirar, leitura do `/me`, montagem das URLs/corpos e o envelope de erro.
 *
 * A casca com I/O é `cloud-auth.ts` (listener + fetch + safeStorage). Mesma
 * divisão de `local-identity-decision.ts` / `local-identity.ts`.
 *
 * Contrato do backend (StellarCloud B2):
 *  - `GET  /v1/auth/start`  → 302 para o GitHub (provider=github).
 *  - `POST /v1/auth/email`  → 202, manda o link de uso único.
 *  - `POST /v1/auth/token`  → par de tokens; `grant_type` authorization_code|refresh_token.
 *  - `POST /v1/auth/logout` → 204 (idempotente).
 *  - `GET  /me`             → conta/identidades (Bearer).
 * Erros: `{ "error": { "code", "message" } }`.
 */

import { createHash } from "node:crypto";

export const CLOUD_API_DEFAULT = "https://api.stellar.idyplatform.com";
export const CLOUD_API_ENV = "STELLARCLOUD_API_URL";

/** Base da API: env (dev/smoke) ou produção. */
export function resolveCloudApiBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[CLOUD_API_ENV]?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/+$/, "") : CLOUD_API_DEFAULT;
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636). O backend só aceita S256 e exige challenge de 43 chars.
// ---------------------------------------------------------------------------

const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: string): boolean {
  return PKCE_VERIFIER_RE.test(verifier);
}

/** S256(code_verifier): base64url sem padding do SHA-256 — sempre 43 chars. */
export function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function isValidCodeChallenge(challenge: string): boolean {
  if (challenge.length !== 43) return false;
  return /^[A-Za-z0-9\-_]+$/.test(challenge);
}

// ---------------------------------------------------------------------------
// redirect_uri loopback — espelha `ValidateLoopbackRedirect` do backend:
// http/https, SEM userinfo, host EXATO 127.0.0.1 ou ::1, porta numérica.
// ---------------------------------------------------------------------------

export function loopbackRedirectForPort(port: number): string {
  return `http://127.0.0.1:${port}/cb`;
}

export function isLoopbackRedirectUri(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return false;
  if (parsed.port !== "" && !/^\d+$/.test(parsed.port)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Callback do loopback.
// ---------------------------------------------------------------------------

export type CallbackOutcome =
  | { kind: "ok"; code: string }
  | { kind: "error"; reason: "state-mismatch" | "provider-error" | "missing-code" };

/**
 * Decide o que fazer com a query que chegou em `/cb`. O STATE É CHECADO
 * PRIMEIRO — sem isso, um callback forjado (ou de outro fluxo) entregaria um
 * code. `error` do provedor e `code` ausente são recusas distintas, para a UI
 * poder dizer qual foi.
 */
export function decideCallback(
  query: { state?: string | null; code?: string | null; error?: string | null },
  expectedState: string,
): CallbackOutcome {
  if (!query.state || query.state !== expectedState) return { kind: "error", reason: "state-mismatch" };
  if (query.error) return { kind: "error", reason: "provider-error" };
  if (!query.code) return { kind: "error", reason: "missing-code" };
  return { kind: "ok", code: query.code };
}

// ---------------------------------------------------------------------------
// Resposta de tokens.
// ---------------------------------------------------------------------------

export type ParsedTokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  refreshExpiresInSec: number;
};

export function parseTokenPair(raw: unknown): ParsedTokenPair | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.access_token !== "string" || rec.access_token === "") return null;
  if (typeof rec.refresh_token !== "string" || rec.refresh_token === "") return null;
  if (typeof rec.expires_in !== "number" || !Number.isFinite(rec.expires_in) || rec.expires_in <= 0) return null;
  const refreshExpiresIn = typeof rec.refresh_expires_in === "number" && Number.isFinite(rec.refresh_expires_in) ? rec.refresh_expires_in : 0;
  return {
    accessToken: rec.access_token,
    refreshToken: rec.refresh_token,
    expiresInSec: rec.expires_in,
    refreshExpiresInSec: refreshExpiresIn,
  };
}

// ---------------------------------------------------------------------------
// Renovação: renova ANTES de expirar, com folga.
// ---------------------------------------------------------------------------

export const ACCESS_RENEW_SKEW_MS = 60_000;

export function decideTokenRenewal(input: {
  obtainedAtMs: number;
  expiresInSec: number;
  nowMs: number;
  skewMs?: number;
}): "renew" | "valid" {
  const skew = input.skewMs ?? ACCESS_RENEW_SKEW_MS;
  const expiresAtMs = input.obtainedAtMs + input.expiresInSec * 1000;
  return input.nowMs + skew >= expiresAtMs ? "renew" : "valid";
}

// ---------------------------------------------------------------------------
// GET /me.
// ---------------------------------------------------------------------------

export type CloudIdentity = { kind: string; subject: string; login: string | null };
export type CloudAccount = { displayName: string; identities: CloudIdentity[] };

/** Leitura TOLERANTE do `/me`: campos ausentes não derrubam; o nome cai no
 *  login/subject da primeira identidade quando `display_name` vem vazio. */
export function parseMe(raw: unknown): CloudAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const account = rec.account;
  if (typeof account !== "object" || account === null) return null;

  const identities: CloudIdentity[] = [];
  if (Array.isArray(rec.identities)) {
    for (const item of rec.identities) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      const kind = typeof it.kind === "string" ? it.kind : "unknown";
      const subject = typeof it.subject === "string" ? it.subject : "";
      const login = typeof it.login === "string" && it.login !== "" ? it.login : null;
      identities.push({ kind, subject, login });
    }
  }

  const rawName = (account as Record<string, unknown>).display_name;
  let displayName = typeof rawName === "string" ? rawName.trim() : "";
  if (displayName === "") {
    const first = identities.find((i) => i.login !== null) ?? identities[0];
    displayName = first?.login ?? first?.subject ?? "";
  }
  return { displayName, identities };
}

// ---------------------------------------------------------------------------
// Envelope de erro do backend.
// ---------------------------------------------------------------------------

/**
 * `feature`, `plan` and `expiredAt` are set only by the plan refusals: the 402
 * envelope adds them so the app can tell "this needs the Pro plan" from "this
 * plan expired" without reading a human message. Absent elsewhere, so the
 * ordinary error path is unchanged.
 */
export type CloudApiError = {
  status: number;
  code: string;
  message: string;
  feature?: string;
  plan?: string;
  expiredAt?: string;
};

export function parseCloudApiError(status: number, raw: unknown, fallbackMessage: string): CloudApiError {
  if (typeof raw === "object" && raw !== null) {
    const err = (raw as Record<string, unknown>).error;
    if (typeof err === "object" && err !== null) {
      const e = err as Record<string, unknown>;
      const error: CloudApiError = {
        status,
        code: typeof e.code === "string" ? e.code : "unknown",
        message: typeof e.message === "string" ? e.message : fallbackMessage,
      };
      if (typeof e.feature === "string" && e.feature !== "") error.feature = e.feature;
      if (typeof e.plan === "string" && e.plan !== "") error.plan = e.plan;
      if (typeof e.expired_at === "string" && e.expired_at !== "") error.expiredAt = e.expired_at;
      return error;
    }
  }
  return { status, code: "unknown", message: fallbackMessage };
}

// ---------------------------------------------------------------------------
// Montagem das requisições (URLs e corpos) — o app manda a MESMA redirect_uri
// no /auth/start e no /auth/token (o backend agora exige isso, RFC 6749 §4.1.3).
// ---------------------------------------------------------------------------

export function buildStartUrl(input: {
  apiBaseUrl: string;
  provider: "github" | "email";
  redirectUri: string;
  state: string;
  codeChallenge: string;
  userId?: string | null;
  email?: string | null;
}): string {
  const url = new URL("/v1/auth/start", input.apiBaseUrl);
  const q = url.searchParams;
  q.set("provider", input.provider);
  q.set("redirect_uri", input.redirectUri);
  q.set("state", input.state);
  q.set("code_challenge", input.codeChallenge);
  q.set("code_challenge_method", "S256");
  if (input.userId) q.set("user_id", input.userId);
  if (input.email) q.set("email", input.email);
  return url.toString();
}

export function buildEmailStartBody(input: {
  provider: "email";
  redirectUri: string;
  state: string;
  codeChallenge: string;
  email: string;
  userId?: string | null;
}): Record<string, string> {
  const body: Record<string, string> = {
    provider: input.provider,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    email: input.email,
  };
  if (input.userId) body.user_id = input.userId;
  return body;
}

export function buildTokenExchangeBody(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  installId: string;
  deviceLabel: string;
}): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    install_id: input.installId,
    device_label: input.deviceLabel,
  };
}

export function buildRefreshBody(input: {
  refreshToken: string;
  installId: string;
  deviceLabel: string;
}): Record<string, string> {
  return {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    install_id: input.installId,
    device_label: input.deviceLabel,
  };
}
