/**
 * cloud-auth.ts — o orquestrador, exercitado contra um backend FALSO em
 * processo (fala o contrato do B2 e o device flow do AUTH_EMAIL.md) e um
 * `openUrl` que faz o papel do navegador (segue o redirect até o listener do
 * app). Cobre: login GitHub (loopback), login e-mail por device flow (polling,
 * slow_down, expiração, logout no meio, código digitado certo e errado ×3),
 * STATE ERRADO recusado sem trocar token, renovação antes de expirar e logout
 * (revoga + apaga o refresh do perfil).
 *
 * `electron` é mockado: sem keychain, o refresh cai em cleartext (mesma postura
 * do secrets.ts), o que deixa o teste inspecionar o arquivo do perfil.
 */
import { createHash } from "node:crypto";
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

/** One device-flow request as the fake server keeps it. */
type DeviceRequest = {
  body: Record<string, string>;
  status: "pending" | "approved" | "used" | "expired" | "denied";
  userCode: string;
  attempts: number;
  /** When each poll arrived, to check the pace the app keeps. */
  pollAt: number[];
  polls: number;
  claims: number;
  /** The next poll answers 429 slow_down once. */
  slowDownOnce: boolean;
  /** The next polls answer this error instead (network-like), counted down. */
  failPolls: number;
  tokens: { access: string; refresh: string };
  /** The poll is recorded on arrival and answered this long after. */
  pollDelayMs: number;
};

type Backend = {
  server: Server;
  baseUrl: string;
  state: {
    code: string;
    nextStateOverride: string | null;
    githubRedirect: { redirectUri: string; state: string } | null;
    emailFlow: { redirectUri: string; state: string } | null;
    /** The device-flow request the app opened (no redirect_uri in the POST). */
    device: DeviceRequest | null;
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
    device: null,
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
        state.emailUserId = body.user_id ?? null;
        if (body.redirect_uri !== undefined) {
          state.emailFlow = { redirectUri: body.redirect_uri, state: body.state };
          return json(202, { status: "sent" });
        }
        state.device = {
          body,
          status: "pending",
          userCode: "481925",
          attempts: 0,
          pollAt: [],
          polls: 0,
          claims: 0,
          slowDownOnce: false,
          failPolls: 0,
          tokens: { access: "A1", refresh: "R1" },
          pollDelayMs: 0,
        };
        return json(202, { request_id: "req-1", poll_interval_sec: 0.05, expires_in: 300 });
      }
      if (req.method === "POST" && (url.pathname === "/v1/auth/email/poll" || url.pathname === "/v1/auth/email/code-claim")) {
        const dev = state.device;
        const proofOk =
          dev !== null &&
          body.request_id === "req-1" &&
          body.install_id === dev.body.install_id &&
          typeof body.code_verifier === "string" &&
          createHash("sha256").update(body.code_verifier).digest("base64url") === dev.body.code_challenge;
        if (!dev || !proofOk) return json(400, { error: { code: "invalid_grant", message: "invalid grant" } });
        const pair = () => {
          dev.status = "used";
          return json(200, { access_token: dev.tokens.access, refresh_token: dev.tokens.refresh, expires_in: 900, refresh_expires_in: 2592000 });
        };
        if (url.pathname.endsWith("/poll")) {
          dev.polls++;
          dev.pollAt.push(Date.now());
          if (dev.pollDelayMs > 0) await new Promise((r) => setTimeout(r, dev.pollDelayMs));
          if (dev.failPolls > 0) {
            dev.failPolls--;
            return json(503, { error: { code: "unavailable", message: "try later" } });
          }
          if (dev.slowDownOnce) {
            dev.slowDownOnce = false;
            return json(429, { error: { code: "slow_down", message: "slow down" } });
          }
          if (dev.status === "pending") return json(200, { status: "pending" });
          if (dev.status === "approved") return pair();
          if (dev.status === "expired") return json(400, { error: { code: "expired_token", message: "expired" } });
          if (dev.status === "denied") return json(400, { error: { code: "access_denied", message: "denied" } });
          return json(400, { error: { code: "invalid_grant", message: "used" } });
        }
        dev.claims++;
        if (dev.status === "denied") return json(400, { error: { code: "access_denied", message: "denied" } });
        if (dev.status === "expired") return json(400, { error: { code: "expired_token", message: "expired" } });
        if (dev.status === "used") return json(400, { error: { code: "invalid_grant", message: "used" } });
        if (dev.status !== "approved") return json(400, { error: { code: "authorization_pending", message: "not approved" } });
        if (String(body.user_code).replace("-", "") === dev.userCode) return pair();
        dev.attempts++;
        if (dev.attempts >= 3) {
          dev.status = "denied";
          return json(400, { error: { code: "access_denied", message: "denied" } });
        }
        return json(400, { error: { code: "invalid_code", message: "wrong code" } });
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

  describe("login por e-mail: device flow (polling e código)", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const device = () => backend.state.device!;

    /** The e-mail login is open and the request is on the fake server. */
    async function openEmailLogin(loginTimeoutMs?: number): Promise<CloudAuth> {
      const auth = createCloudAuth({
        apiBaseUrl: backend.baseUrl,
        dataDir: dir,
        identity: () => ({ userId: USER_ID, installId: INSTALL_ID }),
        openUrl,
        deviceLabel: "test",
        now: () => clock,
        fetchImpl: fetch,
        loginTimeoutMs,
      });
      auths.push(auth);
      const status = await auth.beginLogin("email", "user@example.com");
      expect(status).toMatchObject({ state: "pending", provider: "email" });
      return auth;
    }

    it("o pedido vai SEM redirect_uri, com PKCE S256 e install_id; não abre navegador nem listener", async () => {
      await openEmailLogin();
      const body = device().body;
      expect(body).not.toHaveProperty("redirect_uri");
      expect(body).not.toHaveProperty("state");
      expect(body).toMatchObject({
        email: "user@example.com",
        code_challenge_method: "S256",
        install_id: INSTALL_ID,
        device_label: "test",
        user_id: USER_ID,
      });
      expect(body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(backend.state.emailFlow).toBeNull();
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("aprovado no MEIO do polling: o app loga sozinho, guarda o refresh e para de consultar", async () => {
      const auth = await openEmailLogin();
      await waitFor(() => device().polls >= 2);
      expect(auth.getStatus().state).toBe("pending");

      device().status = "approved"; // approved on another device
      await waitStatus(auth, "logged-in");
      expect(storedRefresh()).toBe("R1");
      expect(device().status).toBe("used");
      // The legacy exchange was never used.
      expect(backend.state.tokenRequests).toBe(0);

      const seen = device().polls;
      await sleep(250);
      expect(device().polls).toBe(seen); // polling stopped
    });

    it("expirado: volta deslogado com login_timeout e para de consultar", async () => {
      const auth = await openEmailLogin();
      await waitFor(() => device().polls >= 1);
      device().status = "expired";
      await waitStatus(auth, "logged-out");
      expect(auth.getStatus()).toMatchObject({ state: "logged-out", lastError: "login_timeout" });
      const seen = device().polls;
      await sleep(250);
      expect(device().polls).toBe(seen);
    });

    it("negado sem código digitado aqui: cadastro fechado", async () => {
      const auth = await openEmailLogin();
      device().status = "denied";
      await waitStatus(auth, "logged-out");
      expect(auth.getStatus()).toMatchObject({ state: "logged-out", lastError: "signup_closed" });
    });

    it("slow_down: o app respeita e espera MAIS antes da próxima consulta", async () => {
      const auth = await openEmailLogin();
      device().slowDownOnce = true;
      await waitFor(() => device().polls >= 2, 6000);
      const [first, second] = device().pollAt;
      // The server's interval is 50ms; after slow_down the app adds 2s.
      expect(second! - first!).toBeGreaterThanOrEqual(1900);
      expect(auth.getStatus().state).toBe("pending");
    }, 10_000);

    it("falha passageira (5xx) não derruba o login: tenta de novo e completa", async () => {
      const auth = await openEmailLogin();
      device().failPolls = 2;
      await waitFor(() => device().polls >= 3, 4000);
      device().status = "approved";
      await waitStatus(auth, "logged-in");
    });

    it("logout durante o polling: para de consultar e a aprovação tardia não loga", async () => {
      const auth = await openEmailLogin();
      await waitFor(() => device().polls >= 1);
      await auth.logout();
      expect(auth.getStatus()).toMatchObject({ state: "logged-out" });

      const seen = device().polls;
      device().status = "approved";
      await sleep(300);
      expect(device().polls).toBe(seen);
      expect(device().status).toBe("approved"); // the tokens were never taken
      expect(auth.getStatus().state).toBe("logged-out");
      expect(storedRefresh()).toBeNull();
    });

    it("logout com a consulta EM VOO: a resposta com os tokens chega depois e é descartada", async () => {
      const auth = await openEmailLogin();
      device().pollDelayMs = 300;
      device().status = "approved";
      await waitFor(() => device().polls >= 1);
      await auth.logout(); // the answer with the tokens is still on its way
      await sleep(500);
      expect(auth.getStatus().state).toBe("logged-out");
      expect(storedRefresh()).toBeNull();
    });

    it("cancelar e pedir de novo: o pedido antigo para de ser consultado", async () => {
      const auth = await openEmailLogin();
      await waitFor(() => device().polls >= 1);
      auth.cancel();
      expect(auth.getStatus().state).toBe("logged-out");
      const seen = device().polls;
      await sleep(250);
      expect(device().polls).toBe(seen);
    });

    it("o tempo do login acaba: login_timeout e nada mais é consultado", async () => {
      const auth = await openEmailLogin(200);
      await waitStatus(auth, "logged-out");
      expect(auth.getStatus()).toMatchObject({ lastError: "login_timeout" });
      const seen = device().polls;
      await sleep(250);
      expect(device().polls).toBe(seen);
    });

    it("refresh em voo + e-mail concluindo: o token atrasado da conta antiga não sobrescreve o da nova", async () => {
      const first = make();
      await first.beginLogin("github");
      await browserStep();
      await waitStatus(first, "logged-in");
      backend.state.strictRefresh = { valid: new Set(["R1"]), counter: 0, log: [], delayMs: 400 };

      const second = make();
      const stale = second.ensureAccessToken();
      await waitFor(() => backend.state.strictRefresh!.log.length === 1);

      await second.beginLogin("email", "other@example.com");
      device().tokens = { access: "A99", refresh: "R-new" };
      device().status = "approved";
      await waitStatus(second, "logged-in");
      expect(storedRefresh()).toBe("R-new");

      expect(await stale).toBeNull();
      expect(storedRefresh()).toBe("R-new");
    });

    describe("código digitado (o polling não serve)", () => {
      /** Approved on the phone, but the polling cannot get through (the API keeps failing for it). */
      async function approvedButPollingBlind(): Promise<CloudAuth> {
        const auth = await openEmailLogin();
        device().failPolls = 1000;
        device().status = "approved";
        return auth;
      }

      it("código certo loga (com ou sem o traço) e para o polling", async () => {
        const auth = await approvedButPollingBlind();
        expect(await auth.claimCode("481-925")).toEqual({ kind: "approved" });
        await waitStatus(auth, "logged-in");
        expect(storedRefresh()).toBe("R1");
        expect(device().claims).toBe(1);
        const seen = device().polls;
        await sleep(300);
        expect(device().polls).toBe(seen);
      });

      it("aceita 481925", async () => {
        const auth = await approvedButPollingBlind();
        expect(await auth.claimCode("481925")).toEqual({ kind: "approved" });
      });

      it("errado ×3: restam 2, restam 1, e na terceira o pedido é cancelado e o polling para", async () => {
        const auth = await approvedButPollingBlind();

        expect(await auth.claimCode("000-000")).toEqual({ kind: "wrong", attemptsLeft: 2 });
        expect(auth.getStatus()).toMatchObject({ state: "pending", codeAttemptsLeft: 2 });
        expect(await auth.claimCode("111-111")).toEqual({ kind: "wrong", attemptsLeft: 1 });
        expect(auth.getStatus()).toMatchObject({ state: "pending", codeAttemptsLeft: 1 });

        expect(await auth.claimCode("222-222")).toEqual({ kind: "blocked" });
        expect(auth.getStatus()).toMatchObject({ state: "pending", provider: "email", codeBlocked: true });
        expect(device().status).toBe("denied");

        // Dead: not even the right code is sent, and nothing is polled.
        const polls = device().polls;
        expect(await auth.claimCode("481-925")).toEqual({ kind: "ended" });
        expect(device().claims).toBe(3);
        await sleep(300);
        expect(device().polls).toBe(polls);
        expect(auth.getStatus().state).toBe("pending");
        auth.cancel();
        expect(auth.getStatus().state).toBe("logged-out");
      });

      it("o bloqueio não vira 'login_timeout' quando o tempo passa", async () => {
        const auth = await openEmailLogin(250);
        device().failPolls = 1000;
        device().status = "approved";
        for (const c of ["000-000", "111-111", "222-222"]) await auth.claimCode(c);
        await sleep(400);
        expect(auth.getStatus()).toMatchObject({ state: "pending", codeBlocked: true });
      });

      it("antes do aceite ou malformado: não gasta tentativa", async () => {
        const auth = await openEmailLogin();
        expect(await auth.claimCode("481-925")).toEqual({ kind: "not-spent" }); // authorization_pending
        expect(device().attempts).toBe(0);
        expect(await auth.claimCode("12")).toEqual({ kind: "not-spent" }); // never sent
        expect(device().claims).toBe(1);
        expect(auth.getStatus()).toEqual(expect.not.objectContaining({ codeAttemptsLeft: expect.anything() }));
      });

      it("sem login por e-mail em andamento: nada a confirmar", async () => {
        const auth = make();
        expect(await auth.claimCode("481-925")).toEqual({ kind: "ended" });
      });

      it("sem conexão ao confirmar: avisa, o pedido continua vivo", async () => {
        const auth = await openEmailLogin();
        backend.server.close();
        const result = await auth.claimCode("481-925");
        expect(result).toMatchObject({ kind: "unreachable" });
        expect(auth.getStatus().state).toBe("pending");
      });
    });
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

    it("202: vira pending DEPOIS da resposta", async () => {
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
