/**
 * cloud-auth.ts — o orquestrador loopback, exercitado contra um backend FALSO
 * em processo (fala o contrato do B2) e um `openUrl` que faz o papel do
 * navegador (segue o redirect até o listener do app). Cobre: login GitHub,
 * login e-mail, STATE ERRADO recusado sem trocar token, renovação antes de
 * expirar e logout (revoga + apaga o refresh do perfil).
 *
 * `electron` é mockado: sem keychain, o refresh cai em cleartext (mesma postura
 * do secrets.ts), o que deixa o teste inspecionar o arquivo do perfil.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

import { createCloudAuth, type CloudAuth, type CloudStatus } from "../../src/main/cloud-auth";
import { cloudAuthPath } from "../../src/main/cloud-tokens";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const INSTALL_ID = "22222222-2222-4222-8222-222222222222";

type Backend = {
  server: Server;
  baseUrl: string;
  state: {
    code: string;
    nextStateOverride: string | null;
    githubRedirect: { redirectUri: string; state: string } | null;
    emailFlow: { redirectUri: string; state: string } | null;
    startUserId: string | null;
    emailUserId: string | null;
    tokenRequests: number;
    refreshRequests: number;
    loggedOut: boolean;
    lastExchangeRedirectUri: string | null;
    /** How the fake answers POST /v1/auth/email; `hang` never answers. */
    emailReply: { status: number; error?: { code: string; message: string } } | "hang";
    emailRequests: number;
    /** When set, refresh tokens are single-use like the real server's: only these are accepted. */
    strictRefresh: { valid: Set<string>; counter: number; log: { used: string; ok: boolean }[]; delayMs?: number } | null;
    /** When set, the authorization_code exchange hands out these tokens (a different account's session). */
    exchangeTokens: { access: string; refresh: string } | null;
  };
};

async function startBackend(): Promise<Backend> {
  const state: Backend["state"] = {
    code: "CODE1",
    nextStateOverride: null,
    githubRedirect: null,
    emailFlow: null,
    startUserId: null,
    emailUserId: null,
    tokenRequests: 0,
    refreshRequests: 0,
    loggedOut: false,
    lastExchangeRedirectUri: null,
    emailReply: { status: 202 },
    emailRequests: 0,
    strictRefresh: null,
    exchangeTokens: null,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

      if (req.method === "GET" && url.pathname === "/v1/auth/start") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const st = url.searchParams.get("state") ?? "";
        const effective = state.nextStateOverride ?? st;
        state.githubRedirect = { redirectUri, state: st };
        state.startUserId = url.searchParams.get("user_id");
        res.writeHead(302, { Location: `${redirectUri}?code=${state.code}&state=${effective}` });
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/email") {
        state.emailRequests++;
        if (state.emailReply === "hang") return; // the request is never answered
        if (state.emailReply.status !== 202) {
          return json(state.emailReply.status, { error: state.emailReply.error ?? { code: "boom", message: "boom" } });
        }
        state.emailFlow = { redirectUri: body.redirect_uri, state: body.state };
        state.emailUserId = body.user_id ?? null;
        return json(202, { status: "sent" });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/token") {
        if (body.grant_type === "refresh_token" && state.strictRefresh) {
          const strict = state.strictRefresh;
          const ok = strict.valid.delete(body.refresh_token);
          strict.log.push({ used: body.refresh_token, ok });
          // A little latency, so that concurrent callers really overlap.
          await new Promise((r) => setTimeout(r, strict.delayMs ?? 30));
          if (!ok) return json(400, { error: { code: "invalid_grant", message: "refresh token reused or revoked" } });
          const next = `S${++strict.counter}`;
          strict.valid.add(next);
          return json(200, { access_token: `A${strict.counter}`, refresh_token: next, expires_in: 900, refresh_expires_in: 2592000 });
        }
        if (body.grant_type === "refresh_token") {
          state.refreshRequests++;
          return json(200, { access_token: "A2", refresh_token: "R2", expires_in: 900, refresh_expires_in: 2592000 });
        }
        state.tokenRequests++;
        state.lastExchangeRedirectUri = body.redirect_uri;
        if (state.exchangeTokens) {
          return json(200, { access_token: state.exchangeTokens.access, refresh_token: state.exchangeTokens.refresh, expires_in: 900, refresh_expires_in: 2592000 });
        }
        return json(200, { access_token: "A1", refresh_token: "R1", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
        state.loggedOut = true;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/me") {
        if (!/^Bearer A\d+$/.test(req.headers.authorization ?? "")) {
          return json(401, { error: { code: "unauthorized", message: "missing bearer token" } });
        }
        return json(200, {
          account: { display_name: "Ana" },
          identities: [{ kind: "github", subject: "42", login: "octo" }],
        });
      }
      json(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, state };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function waitStatus(auth: CloudAuth, state: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = auth.getStatus();
      if (s.state === state) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out esperando ${state}; status=${JSON.stringify(s)}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("cloud-auth (loopback, backend falso)", () => {
  let backend: Backend;
  let dir: string;
  let auths: CloudAuth[];
  let clock: number;
  let openUrl: ReturnType<typeof vi.fn<(url: string) => void | Promise<unknown>>>;

  beforeEach(async () => {
    backend = await startBackend();
    dir = mkdtempSync(join(tmpdir(), "stellar-cloud-auth-"));
    auths = [];
    clock = 1_000_000;
    // `openUrl` só REGISTRA a URL (não faz fetch): cada teste conduz o
    // "navegador" UMA vez via `browserStep()`, para não abrir dois flows.
    openUrl = vi.fn<(url: string) => void | Promise<unknown>>();
  });

  afterEach(() => {
    for (const a of auths) a.dispose();
    backend.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function make(): CloudAuth {
    const auth = createCloudAuth({
      apiBaseUrl: backend.baseUrl,
      dataDir: dir,
      identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
      openUrl,
      deviceLabel: "test",
      now: () => clock,
      fetchImpl: fetch,
    });
    auths.push(auth);
    return auth;
  }

  function storedRefresh(): string | null {
    try {
      const raw = JSON.parse(readFileSync(cloudAuthPath(dir), "utf8")) as { refreshToken?: { value: string } };
      return raw.refreshToken?.value ?? null;
    } catch {
      return null;
    }
  }

  /** O papel do navegador: segue a URL do /auth/start UMA vez. */
  async function browserStep(): Promise<Response> {
    const url = openUrl.mock.calls.at(-1)?.[0];
    if (!url) throw new Error("openUrl não foi chamado");
    return fetch(url);
  }

  it("login GitHub completa: abre o navegador, troca code, loga e guarda o refresh", async () => {
    const auth = make();
    await auth.beginLogin("github");
    expect(auth.getStatus().state).toBe("pending");
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0][0]).toContain("/v1/auth/start");
    expect((await browserStep()).status).toBe(200);

    await waitStatus(auth, "logged-in");
    const status = auth.getStatus();
    if (status.state !== "logged-in") throw new Error("not logged in");
    expect(status.account.displayName).toBe("Ana");
    expect(status.account.identities[0]).toEqual({ kind: "github", subject: "42", login: "octo" });
    expect(backend.state.tokenRequests).toBe(1);
    // A redirect_uri da troca é a MESMA do start (exigência do backend).
    expect(backend.state.lastExchangeRedirectUri).toBe(backend.state.githubRedirect?.redirectUri);
    // Refresh persistido no perfil.
    expect(storedRefresh()).toBe("R1");
  });

  it("state errado RECUSA o callback: não troca token e não loga", async () => {
    backend.state.nextStateOverride = "FORJADO";
    const auth = make();
    await auth.beginLogin("github");
    expect((await browserStep()).status).toBe(400); // listener recusa o state
    await waitFor(() => auth.getStatus().state === "logged-out");
    const status = auth.getStatus();
    expect(status.state === "logged-out" && status.lastError).toContain("state");
    expect(backend.state.tokenRequests).toBe(0);
    expect(storedRefresh()).toBeNull();
  });

  it("login por e-mail: pede o link e completa quando o /cb chega", async () => {
    const auth = make();
    await auth.beginLogin("email", "user@example.com");
    expect(auth.getStatus().state).toBe("pending");
    expect(backend.state.emailFlow).not.toBeNull();
    expect(openUrl).not.toHaveBeenCalled();

    const flow = backend.state.emailFlow!;
    await fetch(`${flow.redirectUri}?code=CODE1&state=${flow.state}`);
    await waitFor(() => auth.getStatus().state === "logged-in");
    expect(backend.state.tokenRequests).toBe(1);
  });

  describe("login por e-mail: só vira pending com o 202 real", () => {
    /** Every status the UI would have been told about, in order. */
    function recordStatuses(auth: CloudAuth): string[] {
      const seen: string[] = [];
      auth.onStatusChanged((st) => seen.push(st.state === "logged-out" ? `out:${st.lastError ?? ""}` : st.state));
      return seen;
    }

    it.each([
      [503, { code: "email_unavailable", message: "mail down" }, "email_unavailable"],
      [403, { code: "signup_closed", message: "closed" }, "signup_closed"],
      [429, { code: "rate_limited", message: "slow down" }, "rate_limited"],
      [422, { code: "invalid_request", message: "bad email" }, "invalid_email"],
      [500, { code: "internal", message: "oops" }, "email_failed"],
    ])("resposta %i da API vira logged-out com o código %s, sem nunca passar por pending", async (status, error, code) => {
      backend.state.emailReply = { status, error };
      const auth = make();
      const seen = recordStatuses(auth);
      const result = await auth.beginLogin("email", "user@example.com");
      expect(backend.state.emailRequests).toBe(1);
      expect(result).toMatchObject({ state: "logged-out", lastError: code });
      expect(seen).toEqual([`out:${code}`]);
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("API inalcançável: logged-out com 'network' (nenhum 'link enviado' falso)", async () => {
      const auth = createCloudAuth({
        apiBaseUrl: "http://127.0.0.1:1", // nothing listens here
        dataDir: dir,
        identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
        openUrl,
        deviceLabel: "test",
        fetchImpl: fetch,
      });
      auths.push(auth);
      const seen = recordStatuses(auth);
      const result = await auth.beginLogin("email", "user@example.com");
      expect(result).toMatchObject({ state: "logged-out", lastError: "network" });
      expect(seen).toEqual(["out:network"]);
    });

    it("API que não responde: o timeout vira 'timeout' em vez de esperar para sempre", async () => {
      backend.state.emailReply = "hang";
      const auth = createCloudAuth({
        apiBaseUrl: backend.baseUrl,
        dataDir: dir,
        identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
        openUrl,
        deviceLabel: "test",
        fetchImpl: fetch,
        emailStartTimeoutMs: 150,
      });
      auths.push(auth);
      const result = await auth.beginLogin("email", "user@example.com");
      expect(backend.state.emailRequests).toBe(1);
      expect(result).toMatchObject({ state: "logged-out", lastError: "timeout" });
    });

    it("202: vira pending DEPOIS da resposta, e o listener segue vivo para o link", async () => {
      const auth = createCloudAuth({
        apiBaseUrl: backend.baseUrl,
        dataDir: dir,
        identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
        openUrl,
        deviceLabel: "test",
        fetchImpl: fetch,
      });
      auths.push(auth);
      const seen = recordStatuses(auth);
      const result = await auth.beginLogin("email", "user@example.com");
      expect(result).toMatchObject({ state: "pending", provider: "email" });
      expect(seen).toEqual(["pending"]);
      expect(backend.state.emailRequests).toBe(1);
    });

    it("cancelar com o pedido em voo não ressuscita um pending", async () => {
      backend.state.emailReply = "hang";
      const auth = createCloudAuth({
        apiBaseUrl: backend.baseUrl,
        dataDir: dir,
        identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
        openUrl,
        deviceLabel: "test",
        fetchImpl: fetch,
        emailStartTimeoutMs: 200,
      });
      auths.push(auth);
      const inFlight = auth.beginLogin("email", "user@example.com");
      await waitFor(() => backend.state.emailRequests === 1);
      auth.cancel();
      await inFlight;
      expect(auth.getStatus().state).toBe("logged-out");
    });
  });

  describe("login GitHub: abrir o navegador", () => {
    it("o pending carrega a URL para o usuário copiar", async () => {
      const auth = make();
      const result = await auth.beginLogin("github");
      expect(result.state === "pending" && result.loginUrl).toBe(openUrl.mock.calls[0][0]);
      expect(result.state === "pending" && result.openFailed).toBeUndefined();
    });

    it("openUrl que rejeita marca openFailed (a URL continua disponível)", async () => {
      openUrl.mockRejectedValueOnce(new Error("xdg-open: not found"));
      const auth = make();
      const seen: CloudStatus[] = [];
      auth.onStatusChanged((st) => seen.push(st));
      await auth.beginLogin("github");
      await waitFor(() => seen.some((st) => st.state === "pending" && st.openFailed === true));
      const status = auth.getStatus();
      expect(status).toMatchObject({ state: "pending", provider: "github", openFailed: true });
      expect(status.state === "pending" && status.loginUrl).toContain("/v1/auth/start");
    });

    it("openUrl que lança de forma síncrona também marca openFailed", async () => {
      openUrl.mockImplementationOnce(() => {
        throw new Error("no handler");
      });
      const auth = make();
      await auth.beginLogin("github");
      await waitFor(() => {
        const st = auth.getStatus();
        return st.state === "pending" && st.openFailed === true;
      });
    });
  });

  it("renova o access ANTES de expirar (rotaciona o refresh)", async () => {
    const auth = make();
    await auth.beginLogin("github");
    await browserStep();
    await waitFor(() => auth.getStatus().state === "logged-in");

    // 900s de vida; avança para dentro da folga de 60s.
    clock += 850_000;
    expect(await auth.ensureAccessToken()).toBe("A2");
    expect(backend.state.refreshRequests).toBe(1);
    expect(storedRefresh()).toBe("R2");
  });

  it("logout revoga no backend, apaga o refresh e volta a deslogado", async () => {
    const auth = make();
    await auth.beginLogin("github");
    await browserStep();
    await waitFor(() => auth.getStatus().state === "logged-in");

    await auth.logout();
    expect(auth.getStatus().state).toBe("logged-out");
    expect(backend.state.loggedOut).toBe(true);
    expect(storedRefresh()).toBeNull();
  });

  it("manda o user_id SÓ no primeiro login (evita 409 user_id_taken)", async () => {
    const auth = make();
    await auth.beginLogin("github");
    await browserStep();
    await waitStatus(auth, "logged-in");
    expect(backend.state.startUserId).toBe(USER_ID); // enviado no 1º login

    await auth.logout(); // logout PRESERVA "já anexou"
    await auth.beginLogin("email", "user@example.com");
    // 2º login (outro provedor): NÃO reenvia o user_id já anexado.
    expect(backend.state.emailUserId).toBeNull();
  });

  it("restore sem conexão: fica deslogado COM aviso de sessão offline e se recupera sozinho", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");

    let down = true;
    const second = createCloudAuth({
      apiBaseUrl: backend.baseUrl,
      dataDir: dir,
      identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
      openUrl,
      deviceLabel: "test",
      now: () => clock,
      fetchImpl: ((...args: Parameters<typeof fetch>) =>
        down ? Promise.reject(new TypeError("fetch failed")) : fetch(...args)) as typeof fetch,
      restoreRetryMs: 40,
    });
    auths.push(second);
    await second.restore();
    expect(second.getStatus()).toMatchObject({ state: "logged-out", lastError: "network", sessionOffline: true });
    expect(storedRefresh()).toBe("R1"); // the saved session is kept

    down = false; // the API comes back: no user action needed
    await waitStatus(second, "logged-in");
    expect(second.getStatus()).toMatchObject({ state: "logged-in" });
  });

  it("sem conexão no boot: o status traz a conta que a máquina já conhecia e de QUANDO ela é", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");
    const savedAt = clock; // the login wrote the cache at this time

    clock += 3_600_000;
    const offline = createCloudAuth({
      apiBaseUrl: backend.baseUrl,
      dataDir: dir,
      identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
      openUrl,
      deviceLabel: "test",
      now: () => clock,
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
      restoreRetryMs: 0,
    });
    auths.push(offline);
    await offline.restore();
    const status = offline.getStatus();
    expect(status).toMatchObject({ state: "logged-out", sessionOffline: true });
    expect(status.state === "logged-out" && status.cachedAccount?.account.displayName).toBe("Ana");
    expect(status.state === "logged-out" && status.cachedAccount?.account.identities[0]).toMatchObject({ kind: "github", subject: "42" });
    expect(status.state === "logged-out" && status.cachedAccount?.savedAtMs).toBe(savedAt);
  });

  it("logout apaga a conta guardada: um boot offline depois dele não mostra mais nada", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");
    await first.logout();

    const offline = createCloudAuth({
      apiBaseUrl: backend.baseUrl,
      dataDir: dir,
      identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
      openUrl,
      deviceLabel: "test",
      now: () => clock,
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
      restoreRetryMs: 0,
    });
    auths.push(offline);
    await offline.restore();
    const status = offline.getStatus();
    expect(status.state === "logged-out" && status.cachedAccount).toBeFalsy();
    expect(status.state === "logged-out" && status.sessionOffline).toBeFalsy();
  });

  it("retry() manual: restaura na hora, sem esperar o timer", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");

    let down = true;
    const second = createCloudAuth({
      apiBaseUrl: backend.baseUrl,
      dataDir: dir,
      identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
      openUrl,
      deviceLabel: "test",
      now: () => clock,
      fetchImpl: ((...args: Parameters<typeof fetch>) =>
        down ? Promise.reject(new TypeError("fetch failed")) : fetch(...args)) as typeof fetch,
      restoreRetryMs: 0, // no automatic retry: only the manual one
    });
    auths.push(second);
    await second.restore();
    expect(second.getStatus()).toMatchObject({ state: "logged-out", sessionOffline: true });
    expect(await second.retry()).toMatchObject({ state: "logged-out", sessionOffline: true }); // still down

    down = false;
    expect(await second.retry()).toMatchObject({ state: "logged-in" });
  });

  it("restore com a API fora do ar (5xx): api_unavailable, também com retry", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");

    const second = createCloudAuth({
      apiBaseUrl: backend.baseUrl,
      dataDir: dir,
      identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
      openUrl,
      deviceLabel: "test",
      now: () => clock,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: "unavailable", message: "down" } }), { status: 503 })) as typeof fetch,
      restoreRetryMs: 0,
    });
    auths.push(second);
    await second.restore();
    expect(second.getStatus()).toMatchObject({ state: "logged-out", lastError: "api_unavailable", sessionOffline: true });
  });

  it("boot com vários pedidos de token ao mesmo tempo: UM refresh só, e a sessão salva sobrevive", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");
    // From here the refresh token is single-use, and the saved one is the login's.
    backend.state.strictRefresh = { valid: new Set(["R1"]), counter: 0, log: [] };

    const second = make(); // a restart: nothing in memory, a refresh token on disk
    const results = await Promise.all([
      second.restore(),
      second.ensureAccessToken(),
      second.ensureAccessToken(),
      second.ensureAccessToken(),
    ]);
    expect(results[0].state).toBe("logged-in");
    expect(results.slice(1)).toEqual(["A1", "A1", "A1"]);
    expect(backend.state.strictRefresh.log).toEqual([{ used: "R1", ok: true }]); // never presented twice
    expect(storedRefresh()).toBe("S1"); // the rotated token is what is saved

    // And the next restart still finds a live session.
    const third = make();
    await third.restore();
    expect(third.getStatus().state).toBe("logged-in");
    expect(backend.state.strictRefresh.log.map((e) => e.ok)).toEqual([true, true]);
  });

  it("refresh em voo + logout: a resposta atrasada NÃO ressuscita a sessão", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");
    backend.state.strictRefresh = { valid: new Set(["R1"]), counter: 0, log: [], delayMs: 200 };

    const second = make(); // a restart with the saved session
    const inFlight = second.ensureAccessToken();
    await waitFor(() => backend.state.strictRefresh!.log.length === 1); // the refresh is out
    await second.logout();
    expect(storedRefresh()).toBeNull();

    expect(await inFlight).toBeNull(); // the late answer is dropped
    await new Promise((r) => setTimeout(r, 300));
    expect(second.getStatus().state).toBe("logged-out");
    expect(storedRefresh()).toBeNull(); // the rotated token was NOT written back
    expect(await second.ensureAccessToken()).toBeNull();
  });

  it("refresh em voo + novo login: o token atrasado da conta antiga não sobrescreve o da nova", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");
    backend.state.strictRefresh = { valid: new Set(["R1"]), counter: 0, log: [], delayMs: 400 };

    const second = make();
    const stale = second.ensureAccessToken(); // refresh of the OLD account's session, slow
    await waitFor(() => backend.state.strictRefresh!.log.length === 1);

    // Meanwhile another account signs in on this app.
    backend.state.exchangeTokens = { access: "A99", refresh: "R-new" };
    await second.beginLogin("github");
    await browserStep();
    await waitStatus(second, "logged-in");
    expect(storedRefresh()).toBe("R-new");

    expect(await stale).toBeNull(); // dropped, not applied
    expect(storedRefresh()).toBe("R-new"); // the new account's token survives
    const status = second.getStatus();
    expect(status.state).toBe("logged-in");
  });

  it("refresh recusado com invalid_grant: a sessão morta é apagada (e só ela)", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitStatus(first, "logged-in");
    backend.state.strictRefresh = { valid: new Set(), counter: 0, log: [] }; // R1 is already spent

    const second = make();
    clock += 10_000_000; // access long expired
    await second.ensureAccessToken(); // R1 is refused and it is still the saved one -> cleared
    expect(storedRefresh()).toBeNull();
  });

  it("restore: com refresh guardado, renova e volta logado", async () => {
    const first = make();
    await first.beginLogin("github");
    await browserStep();
    await waitFor(() => first.getStatus().state === "logged-in");
    expect(storedRefresh()).toBe("R1");

    // Nova instância (como um restart), lendo o mesmo dataDir.
    const second = make();
    expect(second.getStatus().state).toBe("logged-out");
    await second.restore();
    await waitFor(() => second.getStatus().state === "logged-in");
    const restored = second.getStatus();
    expect(restored.state === "logged-in" && restored.account.displayName).toBe("Ana");
  });
});
