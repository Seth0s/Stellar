/**
 * Login na conta Stellar — a casca com I/O (BACKEND_V1.md §4/§7.2).
 *
 * Fluxo de app nativo (RFC 8252), sem embutir página de login no Electron:
 *  1. sobe um listener em 127.0.0.1:<porta livre> e gera state + PKCE (S256);
 *  2. GitHub: abre o navegador do sistema em `/v1/auth/start` (que redireciona
 *     ao GitHub). E-mail: POST `/v1/auth/email` (o link chega por e-mail);
 *  3. recebe `/cb?code&state` (state CONFERIDO), fecha o listener (timeout 5 min);
 *  4. troca `code`+`code_verifier`+`redirect_uri` (a MESMA do start) por tokens;
 *  5. guarda o REFRESH no safeStorage do perfil e mantém o access só em memória;
 *     renova antes de expirar; logout revoga e apaga.
 *
 * O navegador é aberto por `openUrl` injetado (em produção `shell.openExternal`;
 * no smoke, um log — ver `STELLARCLOUD_AUTH_BROWSER` no index.ts). A decisão
 * pura mora em `cloud-auth-decision.ts`.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
  buildEmailStartBody,
  buildRefreshBody,
  buildStartUrl,
  buildTokenExchangeBody,
  decideCallback,
  decideTokenRenewal,
  loopbackRedirectForPort,
  pkceChallengeS256,
  type CloudAccount,
} from "./cloud-auth-decision";
import { createCloudApi, type CloudApi } from "./cloud-api";
import { createCloudTokenStore } from "./cloud-tokens";

export type CloudProvider = "github" | "email";

export type CloudStatus =
  | { state: "logged-out"; apiBaseUrl: string; lastError: string | null }
  | { state: "pending"; apiBaseUrl: string; provider: CloudProvider }
  | { state: "logged-in"; apiBaseUrl: string; account: CloudAccount; expiresAtMs: number };

export type CloudAuthConfig = {
  apiBaseUrl: string;
  /** userData DO PERFIL (onde vive o refresh no safeStorage). */
  dataDir: string;
  /** user_id/install_id locais (A1). `null` se ainda não houver identidade. */
  identity: () => { userId: string; installId: string } | null;
  /** Abre a URL do navegador (produção: `shell.openExternal`). */
  openUrl: (url: string) => void;
  deviceLabel: string;
  now?: () => number;
  loginTimeoutMs?: number;
  /** Intervalo de renovação proativa em ms; 0 desliga (testes). */
  autoRenewMs?: number;
  fetchImpl?: typeof fetch;
};

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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
  const api: CloudApi = createCloudApi({ baseUrl: cfg.apiBaseUrl, fetchImpl: cfg.fetchImpl });
  const tokens = createCloudTokenStore(cfg.dataDir);

  let access: { token: string; obtainedAtMs: number; expiresInSec: number } | null = null;
  let account: CloudAccount | null = null;
  let lastError: string | null = null;

  type Pending = {
    server: Server;
    provider: CloudProvider;
    state: string;
    verifier: string;
    redirectUri: string;
    timer: NodeJS.Timeout;
  };
  let pending: Pending | null = null;

  const listeners = new Set<(status: CloudStatus) => void>();

  function currentStatus(): CloudStatus {
    if (account && access) {
      return { state: "logged-in", apiBaseUrl: api.baseUrl, account, expiresAtMs: access.obtainedAtMs + access.expiresInSec * 1000 };
    }
    if (pending) return { state: "pending", apiBaseUrl: api.baseUrl, provider: pending.provider };
    return { state: "logged-out", apiBaseUrl: api.baseUrl, lastError };
  }

  function emit(): void {
    const status = currentStatus();
    for (const cb of listeners) cb(status);
  }

  function clearSession(): void {
    access = null;
    account = null;
  }

  function stopPending(): void {
    if (!pending) return;
    clearTimeout(pending.timer);
    try {
      pending.server.close();
    } catch {
      /* já fechado */
    }
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
    const token = await ensureAccessToken();
    if (!token) {
      clearSession();
      emit();
      return;
    }
    const res = await api.me(token);
    if (!res.ok) {
      // Access acabou de ser obtido; falha aqui é rede/contrato, não credencial.
      lastError = res.error.message;
      clearSession();
      emit();
      return;
    }
    account = res.value;
    lastError = null;
    emit();
  }

  /** Garante um access válido, renovando ANTES de expirar. `null` = precisa
   *  entrar de novo. */
  async function ensureAccessToken(): Promise<string | null> {
    if (access && decideTokenRenewal({ obtainedAtMs: access.obtainedAtMs, expiresInSec: access.expiresInSec, nowMs: now() }) === "valid") {
      return access.token;
    }
    const refreshToken = tokens.getRefreshToken();
    if (!refreshToken) return access?.token ?? null;

    const ident = cfg.identity();
    const res = await api.refresh(
      buildRefreshBody({ refreshToken, installId: ident?.installId ?? "", deviceLabel: cfg.deviceLabel }),
    );
    if (!res.ok) {
      // invalid_grant = refresh revogado/reusado: a sessão morreu.
      if (res.error.code === "invalid_grant") {
        tokens.clear();
        clearSession();
      }
      lastError = res.error.message;
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
        outcome.reason === "state-mismatch"
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
    const { server, port } = await startListener();
    const redirectUri = loopbackRedirectForPort(port);
    const state = randomOpaque();
    const verifier = randomOpaque();
    const codeChallenge = pkceChallengeS256(verifier);
    const timer = setTimeout(() => {
      if (pending?.server === server) {
        stopPending();
        lastError = "tempo esgotado esperando o login no navegador";
        emit();
      }
    }, cfg.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    pending = { server, provider, state, verifier, redirectUri, timer };
    emit();

    const ident = cfg.identity();
    // §3/item 3: o `user_id` vai no PRIMEIRO login (anexar a conta). Depois
    // disso, um login de OUTRO provedor NÃO o reenvia — o backend já o tem e
    // recusa com 409 `user_id_taken` (o id pertence à conta anterior).
    const userId = tokens.isLinked() ? null : (ident?.userId ?? null);

    if (provider === "github") {
      const startUrl = buildStartUrl({ apiBaseUrl: api.baseUrl, provider: "github", redirectUri, state, codeChallenge, userId });
      cfg.openUrl(startUrl);
      return currentStatus();
    }

    const res = await api.startEmail(
      buildEmailStartBody({ provider: "email", redirectUri, state, codeChallenge, email: email ?? "", userId }),
    );
    if (!res.ok) {
      stopPending();
      lastError = res.error.message;
      emit();
      return currentStatus();
    }
    return currentStatus();
  }

  async function logout(): Promise<CloudStatus> {
    stopPending();
    const refreshToken = tokens.getRefreshToken();
    if (refreshToken) await api.logout(refreshToken).catch(() => undefined);
    tokens.clear();
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
    cancel(): CloudStatus {
      stopPending();
      emit();
      return currentStatus();
    },
    logout,
    restore,
    ensureAccessToken,
    onStatusChanged(cb: (status: CloudStatus) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose(): void {
      stopPending();
      if (renewTimer) clearInterval(renewTimer);
      listeners.clear();
    },
  };
}

export type CloudAuth = ReturnType<typeof createCloudAuth>;
