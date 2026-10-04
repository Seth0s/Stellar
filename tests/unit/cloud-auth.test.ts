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

import { createCloudAuth, type CloudAuth } from "../../src/main/cloud-auth";
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
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
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
        state.emailFlow = { redirectUri: body.redirect_uri, state: body.state };
        state.emailUserId = body.user_id ?? null;
        return json(202, { status: "sent" });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/token") {
        if (body.grant_type === "refresh_token") {
          state.refreshRequests++;
          return json(200, { access_token: "A2", refresh_token: "R2", expires_in: 900, refresh_expires_in: 2592000 });
        }
        state.tokenRequests++;
        state.lastExchangeRedirectUri = body.redirect_uri;
        return json(200, { access_token: "A1", refresh_token: "R1", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
        state.loggedOut = true;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/me") {
        if (req.headers.authorization !== "Bearer A1" && req.headers.authorization !== "Bearer A2") {
          return json(401, { error: { code: "unauthorized", message: "missing bearer token" } });
        }
        return json(200, {
          account: { display_name: "Lucas" },
          identities: [{ kind: "github", subject: "42", login: "seth" }],
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
  let openUrl: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(async () => {
    backend = await startBackend();
    dir = mkdtempSync(join(tmpdir(), "stellar-cloud-auth-"));
    auths = [];
    clock = 1_000_000;
    // `openUrl` só REGISTRA a URL (não faz fetch): cada teste conduz o
    // "navegador" UMA vez via `browserStep()`, para não abrir dois flows.
    openUrl = vi.fn<(url: string) => void>();
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
    expect(status.account.displayName).toBe("Lucas");
    expect(status.account.identities[0]).toEqual({ kind: "github", subject: "42", login: "seth" });
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
    await auth.beginLogin("email", "lucas@example.com");
    expect(auth.getStatus().state).toBe("pending");
    expect(backend.state.emailFlow).not.toBeNull();
    expect(openUrl).not.toHaveBeenCalled();

    const flow = backend.state.emailFlow!;
    await fetch(`${flow.redirectUri}?code=CODE1&state=${flow.state}`);
    await waitFor(() => auth.getStatus().state === "logged-in");
    expect(backend.state.tokenRequests).toBe(1);
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
    await auth.beginLogin("email", "lucas@example.com");
    // 2º login (outro provedor): NÃO reenvia o user_id já anexado.
    expect(backend.state.emailUserId).toBeNull();
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
    expect(restored.state === "logged-in" && restored.account.displayName).toBe("Lucas");
  });
});
