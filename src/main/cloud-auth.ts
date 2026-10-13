/**
 * Login na conta Stellar — a casca com I/O (BACKEND_V1.md §4/§7.2).
 *
 * Fluxo de app nativo (RFC 8252), sem embutir página de login no Electron.
 * GitHub (o navegador que volta é o do próprio PC):
 *  1. sobe um listener em 127.0.0.1:<porta livre> e gera state + PKCE (S256);
 *  2. abre o navegador do sistema em `/v1/auth/start` (que redireciona ao GitHub);
 *  3. recebe `/cb?code&state` (state CONFERIDO), fecha o listener (timeout 5 min);
 *  4. troca `code`+`code_verifier`+`redirect_uri` (a MESMA do start) por tokens.
 * E-mail (o link pode ser aberto em OUTRO aparelho, então não há listener):
 *  1. POST `/v1/auth/email` sem `redirect_uri` (PKCE S256 + install_id): 202 com
 *     `request_id` e o intervalo de polling;
 *  2. consulta `/v1/auth/email/poll` no intervalo do servidor até o aceite, que
 *     entrega o par de tokens uma única vez; ou o usuário digita o código curto
 *     que a página mostrou (`/v1/auth/email/code-claim`, 3 tentativas).
 * Nos dois: o REFRESH vai para o safeStorage do perfil e o access fica só em
 * memória; renova antes de expirar; logout revoga e apaga.
 *
 * O navegador é aberto por `openUrl` injetado (em produção `shell.openExternal`;
 * no smoke, um log — ver `STELLARCLOUD_AUTH_BROWSER` no index.ts). A decisão
 * pura mora em `cloud-auth-decision.ts`.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
  buildEmailCodeClaimBody,
  buildEmailDeviceStartBody,
  buildEmailPollBody,
  buildRefreshBody,
  buildStartUrl,
  buildTokenExchangeBody,
  classifyCodeClaimResponse,
  classifyPollResponse,
  decideCallback,
  classifyAccountError,
  classifyEmailStartError,
  decidePollStep,
  decideTokenRenewal,
  initialPollState,
  isConnectivityError,
  LOGIN_ERROR,
  loopbackRedirectForPort,
  normalizeUserCode,
  pkceChallengeS256,
  SIGNUP_CLOSED_ERROR,
  type CloudAccount,
  type LoginErrorCode,
  type ParsedTokenPair,
  type PollState,
} from "./cloud-auth-decision";
import { createCloudApi, type CloudApi } from "./cloud-api";
import { createCloudAccountCache, type CachedAccount } from "./cloud-account-cache";
import { createCloudTokenStore } from "./cloud-tokens";
import type { CloudPlan } from "./plan-decision";

export type CloudProvider = "github" | "email";

export type CloudStatus =
  | {
      state: "logged-out";
      apiBaseUrl: string;
      lastError: string | null;
      /** A saved session exists but the API cannot be reached: the app is retrying on its own. */
      sessionOffline?: boolean;
      /** With `sessionOffline`: the account the app last saw, so the UI can show who it is (and how old that is). */
      cachedAccount?: CachedAccount;
    }
  | {
      state: "pending";
      apiBaseUrl: string;
      provider: CloudProvider;
      /** GitHub only: the URL the browser must open, so the UI can offer it to copy. */
      loginUrl?: string;
      /** The OS refused to open `loginUrl` (no browser handler); nothing is waiting on a tab. */
      openFailed?: boolean;
      /** E-mail only: wrong confirmation codes typed so far leave this many of the 3 attempts. */
      codeAttemptsLeft?: number;
      /** E-mail only: the 3rd wrong code cancelled the request; polling has stopped. */
      codeBlocked?: boolean;
    }
  | { state: "logged-in"; apiBaseUrl: string; account: CloudAccount; plan: CloudPlan | null; expiresAtMs: number };

/** What typing the confirmation code did; the status carries the lasting part (attempts left, blocked). */
export type CodeClaimResult =
  | { kind: "approved" }
  | { kind: "wrong"; attemptsLeft: number }
  | { kind: "blocked" }
  /** Not a 6-digit code, or the request is not approved yet: no attempt was spent. */
  | { kind: "not-spent" }
  /** The code could not be checked (offline, API down): nothing changed, try again. */
  | { kind: "unreachable"; code: LoginErrorCode }
  /** The login ended some other way (expired, cancelled, already finished by the polling). */
  | { kind: "ended" };

export type CloudAuthConfig = {
  apiBaseUrl: string;
  /** userData DO PERFIL (onde vive o refresh no safeStorage). */
  dataDir: string;
  /** user_id/install_id locais (A1). `null` se ainda não houver identidade. */
  identity: () => { userId: string; installId: string } | null;
  /** Abre a URL do navegador (produção: `shell.openExternal`). A rejeição (ou
   *  exceção) marca o login como "não abriu": a UI mostra a URL para copiar. */
  openUrl: (url: string) => void | Promise<unknown>;
  deviceLabel: string;
  now?: () => number;
  loginTimeoutMs?: number;
  /** Intervalo de renovação proativa em ms; 0 desliga (testes). */
  autoRenewMs?: number;
  /** How long to wait before retrying a restore that failed for lack of connection; 0 turns it off. */
  restoreRetryMs?: number;
  fetchImpl?: typeof fetch;
  /** Bound on the sign-in e-mail request; tests shrink it. */
  emailStartTimeoutMs?: number;
};

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const RESTORE_RETRY_MS = 15_000;

const CALLBACK_OK_HTML =
  "<!doctype html><meta charset=utf-8><title>Stellar</title><body style='font:16px system-ui;padding:2rem'>" +
  "<h1>Pronto</h1><p>Você pode fechar esta janela e voltar ao Stellar.</p></body>";
const CALLBACK_ERR_HTML =
  "<!doctype html><meta charset=utf-8><title>Stellar</title><body style='font:16px system-ui;padding:2rem'>" +
  "<h1>Não deu</h1><p>O login falhou. Volte ao Stellar e tente de novo.</p></body>";

function randomOpaque(): string {
  return randomBytes(32).toString("base64url");
}

export function createCloudAuth(cfg: CloudAuthConfig) {
  const now = cfg.now ?? Date.now;
  const api: CloudApi = createCloudApi({
    baseUrl: cfg.apiBaseUrl,
    fetchImpl: cfg.fetchImpl,
    emailStartTimeoutMs: cfg.emailStartTimeoutMs,
  });
  const tokens = createCloudTokenStore(cfg.dataDir);
  const accountCache = createCloudAccountCache(cfg.dataDir);

  let access: { token: string; obtainedAtMs: number; expiresInSec: number } | null = null;
  let account: CloudAccount | null = null;
  let plan: CloudPlan | null = null;
  let lastError: string | null = null;

  /** An e-mail login waiting for the approval made on another device. */
  type DeviceFlow = {
    requestId: string;
    verifier: string;
    installId: string;
    poll: PollState;
    pollTimer: NodeJS.Timeout | null;
    /** Aborts the poll or claim in flight when the login ends. */
    abort: AbortController;
    /** Wrong codes already counted against the 3. */
    codeAttempts: number;
    codeAttemptsLeft?: number;
    codeBlocked: boolean;
    /** A claim is on its way: it may have spent an attempt the counter does not show yet. */
    claiming: boolean;
  };
  type Pending = {
    /** GitHub only: the loopback listener. */
    server?: Server;
    device?: DeviceFlow;
    provider: CloudProvider;
    state: string;
    verifier: string;
    redirectUri: string;
    timer: NodeJS.Timeout;
    loginUrl?: string;
    openFailed?: boolean;
  };
  let pending: Pending | null = null;
  // Bumped by every beginLogin/cancel: an e-mail request still in flight when
  // the user cancels or starts over must not resurrect a stale pending login.
  let attempt = 0;
  // Bumped when the session the app holds is replaced or ended (logout, a new
  // login). A refresh or `/me` that was already in flight belongs to the OLD
  // session: when it comes back it must not write its tokens (that would
  // resurrect a signed-out session or overwrite the new account's token).
  let sessionEpoch = 0;

  const listeners = new Set<(status: CloudStatus) => void>();

  function currentStatus(): CloudStatus {
    if (account && access) {
      return {
        state: "logged-in",
        apiBaseUrl: api.baseUrl,
        account,
        // null = the server sent no plan block: unknown, left to the server.
        plan,
        expiresAtMs: access.obtainedAtMs + access.expiresInSec * 1000,
      };
    }
    if (pending) {
      return {
        state: "pending",
        apiBaseUrl: api.baseUrl,
        provider: pending.provider,
        ...(pending.loginUrl ? { loginUrl: pending.loginUrl } : {}),
        ...(pending.openFailed ? { openFailed: true } : {}),
        ...(pending.device?.codeAttemptsLeft !== undefined ? { codeAttemptsLeft: pending.device.codeAttemptsLeft } : {}),
        ...(pending.device?.codeBlocked ? { codeBlocked: true } : {}),
      };
    }
    const sessionOffline = isConnectivityError(lastError) && tokens.getRefreshToken() !== null;
    const cachedAccount = sessionOffline ? accountCache.read() : null;
    return {
      state: "logged-out",
      apiBaseUrl: api.baseUrl,
      lastError,
      ...(sessionOffline ? { sessionOffline: true } : {}),
      ...(cachedAccount ? { cachedAccount } : {}),
    };
  }

  function emit(): void {
    const status = currentStatus();
    for (const cb of listeners) cb(status);
  }

  function clearSession(): void {
    access = null;
    account = null;
    plan = null;
  }

  function stopPolling(device: DeviceFlow): void {
    if (device.pollTimer) clearTimeout(device.pollTimer);
    device.pollTimer = null;
    device.abort.abort();
  }

  function stopPending(): void {
    if (!pending) return;
    clearTimeout(pending.timer);
    try {
      pending.server?.close();
    } catch {
      /* já fechado */
    }
    if (pending.device) stopPolling(pending.device);
    pending = null;
  }

  function applyPair(pair: { accessToken: string; refreshToken: string; expiresInSec: number }): void {
    access = { token: pair.accessToken, obtainedAtMs: now(), expiresInSec: pair.expiresInSec };
    const saved = tokens.setRefreshToken(pair.refreshToken);
    if (!saved.ok) lastError = `não deu para guardar a sessão: ${saved.error}`;
    // Primeiro login concluído: o user_id local já foi anexado no servidor.
    if (!tokens.isLinked()) tokens.setLinked(true);
  }

  async function loadMe(): Promise<void> {
    const epoch = sessionEpoch;
    const token = await ensureAccessToken();
    // Signed out or replaced while the token was being fetched: nothing to load.
    if (epoch !== sessionEpoch) return;
    if (!token) {
      clearSession();
      emit();
      scheduleRestoreRetry();
      return;
    }
    const res = await api.meWithPlan(token);
    if (epoch !== sessionEpoch) return;
    if (!res.ok) {
      // Access acabou de ser obtido; falha aqui é rede/contrato, não credencial.
      lastError = classifyAccountError(res.error);
      clearSession();
      emit();
      scheduleRestoreRetry();
      return;
    }
    account = res.value.account;
    plan = res.value.plan;
    lastError = null;
    // What an offline start will show of this account, and from when.
    accountCache.write({ account: res.value.account, savedAtMs: now() });
    emit();
  }

  let restoreTimer: NodeJS.Timeout | null = null;
  /** A saved session that could not be restored for lack of connection is
   *  retried on its own, so a flaky start does not leave the user signed out. */
  function scheduleRestoreRetry(): void {
    if (restoreTimer || cfg.restoreRetryMs === 0) return;
    if (!isConnectivityError(lastError) || !tokens.getRefreshToken()) return;
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      if (!pending) void restore();
    }, cfg.restoreRetryMs ?? RESTORE_RETRY_MS);
    if (typeof restoreTimer.unref === "function") restoreTimer.unref();
  }

  // The refresh token is single-use: the server rotates it on every refresh and
  // answers a reused one with `invalid_grant`. Several callers ask for a token
  // at the same time (the restore at boot, the inbox, the team and work-home
  // IPC), so they all share ONE refresh in flight. Without that, the first
  // refresh wins and the others present the already-spent token, get
  // `invalid_grant`, and wipe a perfectly good saved session.
  let refreshing: Promise<string | null> | null = null;

  /** The session was replaced or ended: whatever is in flight no longer counts. */
  function endSessionEpoch(): void {
    sessionEpoch++;
    refreshing = null;
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  }

  /** Garante um access válido, renovando ANTES de expirar. `null` = precisa
   *  entrar de novo. */
  async function ensureAccessToken(): Promise<string | null> {
    if (access && decideTokenRenewal({ obtainedAtMs: access.obtainedAtMs, expiresInSec: access.expiresInSec, nowMs: now() }) === "valid") {
      return access.token;
    }
    if (refreshing) return refreshing;
    const inFlight = refreshAccess().finally(() => {
      if (refreshing === inFlight) refreshing = null;
    });
    refreshing = inFlight;
    return inFlight;
  }

  async function refreshAccess(): Promise<string | null> {
    const refreshToken = tokens.getRefreshToken();
    if (!refreshToken) return access?.token ?? null;

    const epoch = sessionEpoch;
    const ident = cfg.identity();
    const res = await api.refresh(
      buildRefreshBody({ refreshToken, installId: ident?.installId ?? "", deviceLabel: cfg.deviceLabel }),
    );
    // The session changed while this refresh was out (logout, another login, a
    // different token saved): its answer is about a session that is gone.
    if (epoch !== sessionEpoch || tokens.getRefreshToken() !== refreshToken) return null;
    if (!res.ok) {
      // invalid_grant = refresh revogado/reusado: a sessão morreu. Only when the
      // saved token is still the one that was refused: if something else saved
      // a newer one meanwhile, that session is alive and stays.
      if (res.error.code === "invalid_grant") {
        tokens.clear();
        accountCache.clear();
        clearSession();
      }
      lastError = classifyAccountError(res.error);
      return null;
    }
    applyPair(res.value);
    return access?.token ?? null;
  }

  async function completeExchange(code: string, verifier: string, redirectUri: string): Promise<void> {
    const ident = cfg.identity();
    const res = await api.exchange(
      buildTokenExchangeBody({
        code,
        codeVerifier: verifier,
        redirectUri,
        installId: ident?.installId ?? "",
        deviceLabel: cfg.deviceLabel,
      }),
    );
    if (!res.ok) {
      lastError = res.error.message;
      emit();
      return;
    }
    // A new login replaces whatever session (and refresh in flight) came before.
    endSessionEpoch();
    applyPair(res.value);
    await loadMe();
  }

  function handleCallback(reqUrl: string): string {
    const snapshot = pending;
    if (!snapshot) return CALLBACK_ERR_HTML;
    const url = new URL(reqUrl, "http://127.0.0.1");
    const outcome = decideCallback(
      {
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
      },
      snapshot.state,
    );
    // Fecha o listener ANTES de trocar: a captura já terminou.
    stopPending();
    if (outcome.kind === "error") {
      lastError =
        outcome.reason === "signup-closed"
          ? SIGNUP_CLOSED_ERROR
          : outcome.reason === "state-mismatch"
            ? "callback com state inválido — recusado"
            : outcome.reason === "provider-error"
              ? "o provedor recusou o login"
              : "callback sem code";
      emit();
      return CALLBACK_ERR_HTML;
    }
    void completeExchange(outcome.code, snapshot.verifier, snapshot.redirectUri);
    return CALLBACK_OK_HTML;
  }

  async function startListener(): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
      if (!req.url || !req.url.startsWith("/cb")) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const html = handleCallback(req.url);
      res.writeHead(html === CALLBACK_OK_HTML ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("loopback listener sem porta");
    return { server, port: address.port };
  }

  async function beginLogin(provider: CloudProvider, email?: string): Promise<CloudStatus> {
    stopPending();
    lastError = null;
    const mine = ++attempt;
    // E-mail needs no listener: the link may be opened on another device.
    if (provider === "email") return beginEmailLogin(mine, email ?? "");
    const { server, port } = await startListener();
    if (mine !== attempt) {
      server.close();
      return currentStatus();
    }
    const redirectUri = loopbackRedirectForPort(port);
    const state = randomOpaque();
    const verifier = randomOpaque();
    const codeChallenge = pkceChallengeS256(verifier);

    function arm(): Pending {
      const timer = setTimeout(() => {
        if (pending?.server === server) {
          stopPending();
          lastError = LOGIN_ERROR.loginTimeout;
          emit();
        }
      }, cfg.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      return { server, provider, state, verifier, redirectUri, timer };
    }

    const ident = cfg.identity();
    // §3/item 3: o `user_id` vai no PRIMEIRO login (anexar a conta). Depois
    // disso, um login de OUTRO provedor NÃO o reenvia — o backend já o tem e
    // recusa com 409 `user_id_taken` (o id pertence à conta anterior).
    const userId = tokens.isLinked() ? null : (ident?.userId ?? null);

    const startUrl = buildStartUrl({ apiBaseUrl: api.baseUrl, provider: "github", redirectUri, state, codeChallenge, userId });
    const armed = arm();
    armed.loginUrl = startUrl;
    pending = armed;
    emit();
    // The open is not awaited (the tab may take a while), but a refusal from
    // the OS must reach the UI instead of leaving it waiting on a tab that
    // never opened.
    void (async () => cfg.openUrl(startUrl))().catch(() => {
      if (pending !== armed) return;
      armed.openFailed = true;
      emit();
    });
    return currentStatus();
  }

  // ---- E-mail login: device flow (no listener) -----------------------------

  async function beginEmailLogin(mine: number, email: string): Promise<CloudStatus> {
    const ident = cfg.identity();
    if (!ident?.installId) {
      // The request is tied to this installation; without one there is nothing to poll for.
      lastError = LOGIN_ERROR.emailFailed;
      emit();
      return currentStatus();
    }
    const verifier = randomOpaque();
    // The `user_id` goes with the FIRST login only (see the GitHub branch).
    const userId = tokens.isLinked() ? null : ident.userId;
    // Nothing is "pending" until the server ACCEPTED the request — announcing
    // it earlier made a network failure look like a sent link.
    const res = await api.startEmailDevice(
      buildEmailDeviceStartBody({
        email,
        codeChallenge: pkceChallengeS256(verifier),
        installId: ident.installId,
        deviceLabel: cfg.deviceLabel,
        userId,
      }),
    );
    if (mine !== attempt) return currentStatus(); // cancelled or superseded while in flight
    if (!res.ok) {
      lastError = classifyEmailStartError(res.error);
      emit();
      return currentStatus();
    }
    const device: DeviceFlow = {
      requestId: res.value.requestId,
      verifier,
      installId: ident.installId,
      poll: initialPollState(res.value.pollIntervalMs),
      pollTimer: null,
      abort: new AbortController(),
      codeAttempts: 0,
      codeBlocked: false,
      claiming: false,
    };
    const timer = setTimeout(() => {
      if (pending?.device === device) {
        stopPending();
        lastError = LOGIN_ERROR.loginTimeout;
        emit();
      }
    }, Math.min(cfg.loginTimeoutMs ?? LOGIN_TIMEOUT_MS, res.value.expiresInMs));
    if (typeof timer.unref === "function") timer.unref();
    const armed: Pending = { device, provider: "email", state: "", verifier, redirectUri: "", timer };
    pending = armed;
    schedulePoll(armed, device.poll.intervalMs);
    emit();
    return currentStatus();
  }

  function schedulePoll(owner: Pending, delayMs: number): void {
    const device = owner.device;
    if (!device) return;
    device.pollTimer = setTimeout(() => void pollOnce(owner), delayMs);
    if (typeof device.pollTimer.unref === "function") device.pollTimer.unref();
  }

  async function pollOnce(owner: Pending): Promise<void> {
    const device = owner.device;
    if (!device || pending !== owner || device.codeBlocked) return;
    device.pollTimer = null;
    const epoch = sessionEpoch;
    const res = await api.pollEmail(
      buildEmailPollBody({ requestId: device.requestId, codeVerifier: device.verifier, installId: device.installId }),
      device.abort.signal,
    );
    // The login ended while this poll was out (logout, cancel, a new login, the
    // code path won): its answer is about a login that is gone.
    if (pending !== owner || epoch !== sessionEpoch) return;
    const step = decidePollStep({
      outcome: classifyPollResponse(res),
      state: device.poll,
      codeAttempts: device.codeAttempts + (device.claiming ? 1 : 0),
    });
    switch (step.kind) {
      case "complete":
        await finishEmailLogin(step.pair);
        return;
      case "fail":
        stopPending();
        lastError = step.code;
        emit();
        return;
      case "blocked":
        blockCodeEntry(owner);
        return;
      case "wait":
        device.poll = step.state;
        schedulePoll(owner, step.delayMs);
    }
  }

  /** The tokens arrived (by the polling or by the code): the login is over, the session is new. */
  async function finishEmailLogin(pair: ParsedTokenPair): Promise<void> {
    stopPending();
    // A new login replaces whatever session (and refresh in flight) came before.
    endSessionEpoch();
    applyPair(pair);
    await loadMe();
  }

  /** The 3rd wrong code (or a denial after wrong codes): the request is dead, say so and stop. */
  function blockCodeEntry(owner: Pending): void {
    const device = owner.device;
    if (!device) return;
    device.codeBlocked = true;
    device.codeAttemptsLeft = 0;
    clearTimeout(owner.timer);
    stopPolling(device);
    emit();
  }

  async function claimCode(raw: string): Promise<CodeClaimResult> {
    const owner = pending;
    const device = owner?.device;
    if (!owner || !device || device.codeBlocked || device.claiming) return { kind: "ended" };
    const userCode = normalizeUserCode(raw);
    if (userCode === null) return { kind: "not-spent" };
    const epoch = sessionEpoch;
    const attemptsBefore = device.codeAttempts;
    device.claiming = true;
    const res = await api.claimEmailCode(
      buildEmailCodeClaimBody({ requestId: device.requestId, codeVerifier: device.verifier, installId: device.installId, userCode }),
      device.abort.signal,
    );
    device.claiming = false;
    if (pending !== owner || epoch !== sessionEpoch) return { kind: "ended" };
    const outcome = classifyCodeClaimResponse(res, attemptsBefore);
    switch (outcome.kind) {
      case "approved":
        await finishEmailLogin(outcome.pair);
        return { kind: "approved" };
      case "wrong":
        device.codeAttempts = attemptsBefore + 1;
        device.codeAttemptsLeft = outcome.attemptsLeft;
        emit();
        return outcome;
      case "blocked":
        device.codeAttempts = attemptsBefore + 1;
        blockCodeEntry(owner);
        return { kind: "blocked" };
      case "expired":
        stopPending();
        lastError = LOGIN_ERROR.loginTimeout;
        emit();
        return { kind: "ended" };
      case "stale":
        // The server refuses the proof: nothing left to wait for.
        stopPending();
        lastError = LOGIN_ERROR.emailFailed;
        emit();
        return { kind: "ended" };
      case "not-spent":
        return outcome;
      case "unreachable":
        return outcome;
    }
  }

  async function logout(): Promise<CloudStatus> {
    stopPending();
    endSessionEpoch();
    const refreshToken = tokens.getRefreshToken();
    if (refreshToken) await api.logout(refreshToken).catch(() => undefined);
    tokens.clear();
    accountCache.clear();
    clearSession();
    lastError = null;
    emit();
    return currentStatus();
  }

  /** No boot: se há refresh guardado, renova e busca `/me`. */
  async function restore(): Promise<CloudStatus> {
    if (account && access) return currentStatus();
    if (!tokens.getRefreshToken()) {
      emit();
      return currentStatus();
    }
    await loadMe();
    return currentStatus();
  }

  let renewTimer: NodeJS.Timeout | null = null;
  if (cfg.autoRenewMs && cfg.autoRenewMs > 0) {
    renewTimer = setInterval(() => {
      if (access) void ensureAccessToken().then((token) => { if (!token) emit(); });
    }, cfg.autoRenewMs);
    if (typeof renewTimer.unref === "function") renewTimer.unref();
  }

  return {
    getStatus: currentStatus,
    beginLogin,
    claimCode,
    cancel(): CloudStatus {
      attempt++;
      stopPending();
      emit();
      return currentStatus();
    },
    logout,
    restore,
    /** The "try again" of an offline saved session: restores now instead of waiting for the timer. */
    async retry(): Promise<CloudStatus> {
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      return restore();
    },
    ensureAccessToken,
    onStatusChanged(cb: (status: CloudStatus) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose(): void {
      stopPending();
      if (restoreTimer) clearTimeout(restoreTimer);
      if (renewTimer) clearInterval(renewTimer);
      listeners.clear();
    },
  };
}

export type CloudAuth = ReturnType<typeof createCloudAuth>;
