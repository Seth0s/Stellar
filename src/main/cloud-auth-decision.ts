/**
 * Login na conta Stellar (BACKEND_V1.md §4/§7.2) — a DECISÃO, sem I/O.
 *
 * O fluxo é o de app nativo (RFC 8252): listener loopback + PKCE S256 no GitHub;
 * o login por e-mail é um device flow (pedido + polling + código digitado), sem
 * listener. Este módulo concentra o que dá para testar sem rede nem relógio: geração/validação
 * de PKCE, validação do redirect loopback, decisão do callback (state errado
 * RECUSADO), leitura da resposta de tokens, decisão de RENOVAÇÃO antes de
 * expirar, leitura do `/me`, montagem das URLs/corpos e o envelope de erro.
 *
 * A casca com I/O é `cloud-auth.ts` (listener + fetch + safeStorage). Mesma
 * divisão de `local-identity-decision.ts` / `local-identity.ts`.
 *
 * Contrato do backend (StellarCloud B2):
 *  - `GET  /v1/auth/start`  → 302 para o GitHub (provider=github).
 *  - `POST /v1/auth/email`  → 202, manda o link de uso único. Sem `redirect_uri`
 *    é o device flow (`request_id`), consultado em `/email/poll` e `/email/code-claim`.
 *  - `POST /v1/auth/token`  → par de tokens; `grant_type` authorization_code|refresh_token.
 *  - `POST /v1/auth/logout` → 204 (idempotente).
 *  - `GET  /me`             → conta/identidades (Bearer).
 * Erros: `{ "error": { "code", "message" } }`.
 */

import { createHash } from "node:crypto";

export const CLOUD_API_DEFAULT = "https://api.stellar.idyplatform.com";
export const CLOUD_API_ENV = "STELLARCLOUD_API_URL";

/** Hosts for which plain http is acceptable: the machine itself, never the network. */
const LOOPBACK_API_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Validate an API base URL coming from the environment (dev/testing override).
 * Returns the normalized base (no trailing slash) or null.
 *
 * Rule: `http` only for loopback (127.0.0.1, localhost, ::1); `https` for any
 * host; no userinfo, query or fragment; path only as a prefix. In a PACKAGED
 * app (`loopbackOnly`) even `https` must be loopback: the override receives the
 * login tokens, so a non-loopback host there would hand them to whoever can set
 * the app's environment (a launcher, a shell profile).
 */
export function parseCloudApiOverride(raw: string, opts: { loopbackOnly?: boolean } = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  const loopback = LOOPBACK_API_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !loopback) return null;
  if (opts.loopbackOnly && !loopback) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Electron sets `defaultApp` only when launched as `electron <path>` (dev/testing build). */
function isPackagedElectron(): boolean {
  return Boolean(process.versions.electron) && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp;
}

let warnedInvalidOverride = false;

/**
 * Base da API: env (dev/smoke/ambiente de teste local) ou produção. Um valor
 * recusado pela regra de `parseCloudApiOverride` cai em produção — nunca num
 * destino que o usuário não validou — e avisa uma vez no stderr.
 */
export function resolveCloudApiBaseUrl(
  env: Record<string, string | undefined>,
  opts: { packaged?: boolean } = {},
): string {
  const raw = env[CLOUD_API_ENV]?.trim();
  if (!raw) return CLOUD_API_DEFAULT;
  const accepted = parseCloudApiOverride(raw, { loopbackOnly: opts.packaged ?? isPackagedElectron() });
  if (accepted !== null) return accepted;
  if (!warnedInvalidOverride) {
    warnedInvalidOverride = true;
    process.stderr.write(
      `[cloud-auth] ${CLOUD_API_ENV} ignorada (só http://127.0.0.1|localhost ou https; no app empacotado, só loopback) — usando ${CLOUD_API_DEFAULT}\n`,
    );
  }
  return CLOUD_API_DEFAULT;
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

/** Machine code for lastError when the server refuses unknown identities. */
export const SIGNUP_CLOSED_ERROR = "signup_closed";

/**
 * Machine codes written into `CloudStatus.lastError` for a login that did not
 * happen. The renderer maps each one to a message; anything else it sees there
 * (a refresh failure, a raw server message) is not a login error to display.
 */
export const LOGIN_ERROR = {
  signupClosed: SIGNUP_CLOSED_ERROR,
  emailUnavailable: "email_unavailable",
  rateLimited: "rate_limited",
  invalidEmail: "invalid_email",
  network: "network",
  timeout: "timeout",
  emailFailed: "email_failed",
  loginTimeout: "login_timeout",
  apiUnavailable: "api_unavailable",
} as const;

/** Union of the machine codes a failed login can leave in `lastError`. */
export type LoginErrorCode = (typeof LOGIN_ERROR)[keyof typeof LOGIN_ERROR];

/** Codes that mean "the API could not be reached", as opposed to "it said no". */
export function isConnectivityError(code: string | null | undefined): boolean {
  return code === LOGIN_ERROR.network || code === LOGIN_ERROR.timeout || code === LOGIN_ERROR.apiUnavailable;
}

/**
 * Classify a failed session call (refresh, `/me`). A connectivity failure gets
 * a machine code so the UI can say "no connection" and the app can retry on
 * its own; a refusal keeps the server's message.
 */
export function classifyAccountError(err: CloudApiError): string {
  if (err.status === 0) return err.code === "timeout" ? LOGIN_ERROR.timeout : LOGIN_ERROR.network;
  if (err.status >= 500) return LOGIN_ERROR.apiUnavailable;
  return err.message;
}

/**
 * Classify a failed `POST /v1/auth/email` into a login machine code. Only a
 * real answer from the server is an HTTP status; `status: 0` means the request
 * never got one (unreachable, DNS, TLS, aborted by the timeout).
 */
export function classifyEmailStartError(err: CloudApiError): string {
  if (err.code === "signup_closed") return LOGIN_ERROR.signupClosed;
  if (err.status === 0) return err.code === "timeout" ? LOGIN_ERROR.timeout : LOGIN_ERROR.network;
  if (err.code === "email_unavailable" || err.status === 503) return LOGIN_ERROR.emailUnavailable;
  if (err.status === 429) return LOGIN_ERROR.rateLimited;
  if (err.status === 400 || err.status === 422) return LOGIN_ERROR.invalidEmail;
  return LOGIN_ERROR.emailFailed;
}

export type CallbackOutcome =
  | { kind: "ok"; code: string }
  | { kind: "error"; reason: "state-mismatch" | "provider-error" | "signup-closed" | "missing-code" };

/**
 * Decide o que fazer com a query que chegou em `/cb`. O STATE É CHECADO
 * PRIMEIRO — sem isso, um callback forjado (ou de outro fluxo) entregaria um
 * code. `error` do provedor e `code` ausente são recusas distintas, para a UI
 * poder dizer qual foi. `signup_closed` is the test-period refusal for
 * unknown identities (server redirects with that error query).
 */
export function decideCallback(
  query: { state?: string | null; code?: string | null; error?: string | null },
  expectedState: string,
): CallbackOutcome {
  if (!query.state || query.state !== expectedState) return { kind: "error", reason: "state-mismatch" };
  if (query.error === "signup_closed") return { kind: "error", reason: "signup-closed" };
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

// ---------------------------------------------------------------------------
// Login por e-mail em device flow (AUTH_EMAIL.md §1): pedido sem redirect_uri,
// polling com o intervalo do servidor e código digitado como segundo caminho.
// ---------------------------------------------------------------------------

/** Wrong-code attempts the server allows before it denies the request. */
export const CODE_CLAIM_MAX_ATTEMPTS = 3;
const DEFAULT_POLL_INTERVAL_SEC = 3;
const MAX_POLL_INTERVAL_SEC = 30;
const DEFAULT_REQUEST_LIFETIME_SEC = 300;
/** Added to the interval each time the server answers `slow_down`. */
export const SLOW_DOWN_STEP_MS = 2_000;
/** Ceiling of the interval after `slow_down` or a run of transient failures. */
export const POLL_BACKOFF_CEILING_MS = 15_000;
/** Consecutive polls that could not reach the API before the login gives up. */
export const POLL_MAX_CONSECUTIVE_FAILURES = 5;
const DEVICE_LABEL_MAX = 64;

export type EmailDeviceStart = { requestId: string; pollIntervalMs: number; expiresInMs: number };

/** Read the 202 of a device-flow request. `null` = the answer is not one (no `request_id`). */
export function parseEmailDeviceStart(raw: unknown): EmailDeviceStart | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.request_id !== "string" || rec.request_id === "") return null;
  const interval = typeof rec.poll_interval_sec === "number" && Number.isFinite(rec.poll_interval_sec) && rec.poll_interval_sec > 0
    ? Math.min(rec.poll_interval_sec, MAX_POLL_INTERVAL_SEC)
    : DEFAULT_POLL_INTERVAL_SEC;
  const lifetime = typeof rec.expires_in === "number" && Number.isFinite(rec.expires_in) && rec.expires_in > 0
    ? rec.expires_in
    : DEFAULT_REQUEST_LIFETIME_SEC;
  return { requestId: rec.request_id, pollIntervalMs: interval * 1000, expiresInMs: lifetime * 1000 };
}

/** The device-flow request: NO `redirect_uri` (that is what picks the flow) and no `state`. */
export function buildEmailDeviceStartBody(input: {
  email: string;
  codeChallenge: string;
  installId: string;
  deviceLabel: string;
  userId?: string | null;
}): Record<string, string> {
  const body: Record<string, string> = {
    email: input.email,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    install_id: input.installId,
  };
  const label = input.deviceLabel.trim().slice(0, DEVICE_LABEL_MAX);
  if (label !== "") body.device_label = label;
  if (input.userId) body.user_id = input.userId;
  return body;
}

export function buildEmailPollBody(input: { requestId: string; codeVerifier: string; installId: string }): Record<string, string> {
  return { request_id: input.requestId, code_verifier: input.codeVerifier, install_id: input.installId };
}

export function buildEmailCodeClaimBody(input: {
  requestId: string;
  codeVerifier: string;
  installId: string;
  userCode: string;
}): Record<string, string> {
  return { ...buildEmailPollBody(input), user_code: input.userCode };
}

/** `481925`, `481-925` or `481 925` → `481-925`; anything else → `null` (never sent). */
export function normalizeUserCode(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

/** What `POST /v1/auth/email/poll` and `/code-claim` answer once read: a pair, still pending, or an error. */
export type DeviceTokenReply = { kind: "pending" } | { kind: "tokens"; pair: ParsedTokenPair };

/** Read the 200 of poll/code-claim: `{status:"pending"}` or a TokenPair. `null` = neither. */
export function parseDeviceTokenReply(raw: unknown): DeviceTokenReply | null {
  if (typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).status === "pending") {
    return { kind: "pending" };
  }
  const pair = parseTokenPair(raw);
  return pair ? { kind: "tokens", pair } : null;
}

export type DevicePollOutcome =
  | { kind: "pending" }
  | { kind: "approved"; pair: ParsedTokenPair }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied" }
  /** The server no longer knows this request or refuses the proof: nothing to wait for. */
  | { kind: "rejected" }
  /** Could not get an answer (network, 5xx, rate limit): worth trying again. */
  | { kind: "transient"; error: CloudApiError };

/** Map the answer of one poll to an outcome. */
export function classifyPollResponse(
  res: { ok: true; value: DeviceTokenReply } | { ok: false; error: CloudApiError },
): DevicePollOutcome {
  if (res.ok) return res.value.kind === "tokens" ? { kind: "approved", pair: res.value.pair } : { kind: "pending" };
  const { error } = res;
  if (error.code === "slow_down") return { kind: "slow_down" };
  if (error.code === "expired_token") return { kind: "expired" };
  if (error.code === "access_denied") return { kind: "denied" };
  if (error.code === "invalid_grant" || error.code === "invalid_request") return { kind: "rejected" };
  return { kind: "transient", error };
}

/** The login code for a poll/claim that got no usable answer. */
function unreachableCode(err: CloudApiError): LoginErrorCode {
  if (err.status === 0) return err.code === "timeout" ? LOGIN_ERROR.timeout : LOGIN_ERROR.network;
  if (err.status === 429) return LOGIN_ERROR.rateLimited;
  return LOGIN_ERROR.apiUnavailable;
}

export type PollState = {
  intervalMs: number;
  /** The interval the server asked for; backoff never goes below it. */
  baseIntervalMs: number;
  consecutiveFailures: number;
};

export function initialPollState(intervalMs: number): PollState {
  return { intervalMs, baseIntervalMs: intervalMs, consecutiveFailures: 0 };
}

export type PollStep =
  | { kind: "wait"; delayMs: number; state: PollState }
  | { kind: "complete"; pair: ParsedTokenPair }
  /** The login failed and the screen goes back to the form with this code. */
  | { kind: "fail"; code: LoginErrorCode }
  /** The request was denied after wrong codes typed here: stay on the screen, say so, stop. */
  | { kind: "blocked" };

/**
 * The next step of the polling loop. `slow_down` raises the interval for good;
 * transient failures back off but a good answer returns to the server's
 * interval; a run of failures ends the login as a connectivity error.
 * `access_denied` after codes were typed here is the 3-strikes block; without
 * them it is the closed sign-up (the only other reason a request is denied).
 */
export function decidePollStep(input: { outcome: DevicePollOutcome; state: PollState; codeAttempts: number }): PollStep {
  const { outcome, state } = input;
  switch (outcome.kind) {
    case "approved":
      return { kind: "complete", pair: outcome.pair };
    case "pending":
      return {
        kind: "wait",
        delayMs: state.baseIntervalMs,
        state: { ...state, intervalMs: state.baseIntervalMs, consecutiveFailures: 0 },
      };
    case "slow_down": {
      const raised = Math.min(Math.max(state.intervalMs, state.baseIntervalMs) + SLOW_DOWN_STEP_MS, POLL_BACKOFF_CEILING_MS);
      return {
        kind: "wait",
        delayMs: raised,
        state: { intervalMs: raised, baseIntervalMs: raised, consecutiveFailures: 0 },
      };
    }
    case "expired":
      return { kind: "fail", code: LOGIN_ERROR.loginTimeout };
    case "denied":
      return input.codeAttempts > 0 ? { kind: "blocked" } : { kind: "fail", code: LOGIN_ERROR.signupClosed };
    case "rejected":
      return { kind: "fail", code: LOGIN_ERROR.emailFailed };
    case "transient": {
      const failures = state.consecutiveFailures + 1;
      if (failures >= POLL_MAX_CONSECUTIVE_FAILURES) {
        return { kind: "fail", code: unreachableCode(outcome.error) };
      }
      const backedOff = Math.min(state.intervalMs * 2, Math.max(POLL_BACKOFF_CEILING_MS, state.baseIntervalMs));
      return {
        kind: "wait",
        delayMs: backedOff,
        state: { ...state, intervalMs: backedOff, consecutiveFailures: failures },
      };
    }
  }
}

export type CodeClaimOutcome =
  | { kind: "approved"; pair: ParsedTokenPair }
  /** The code was wrong; `attemptsLeft` is what remains of the 3. */
  | { kind: "wrong"; attemptsLeft: number }
  /** The 3rd wrong code: the request is cancelled. */
  | { kind: "blocked" }
  /** Not an `NNN-NNN` code, or the request is not approved yet: no attempt was spent. */
  | { kind: "not-spent" }
  | { kind: "expired" }
  /** Another path (the polling) already took the tokens, or the proof is refused. */
  | { kind: "stale" }
  | { kind: "unreachable"; code: LoginErrorCode };

/** Map the answer of one code-claim; `attemptsBefore` is how many wrong codes this request already had. */
export function classifyCodeClaimResponse(
  res: { ok: true; value: DeviceTokenReply } | { ok: false; error: CloudApiError },
  attemptsBefore: number,
): CodeClaimOutcome {
  if (res.ok) return res.value.kind === "tokens" ? { kind: "approved", pair: res.value.pair } : { kind: "not-spent" };
  const { error } = res;
  switch (error.code) {
    case "invalid_code": {
      const left = CODE_CLAIM_MAX_ATTEMPTS - (attemptsBefore + 1);
      return left > 0 ? { kind: "wrong", attemptsLeft: left } : { kind: "blocked" };
    }
    case "access_denied":
      return { kind: "blocked" };
    case "authorization_pending":
    case "invalid_request":
      return { kind: "not-spent" };
    case "expired_token":
      return { kind: "expired" };
    case "invalid_grant":
      return { kind: "stale" };
  }
  return { kind: "unreachable", code: unreachableCode(error) };
}
