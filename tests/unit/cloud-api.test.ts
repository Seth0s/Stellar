/**
 * cloud-api.ts — o cliente HTTP, exercitado contra um servidor LOCAL em
 * processo (não é o backend Go, mas fala o MESMO contrato: envelope de erro,
 * TokenPair, /me, logout 204). Cobre tradução de status/erro e falha de rede.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApi } from "../../src/main/cloud-api";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const send = (status: number, payload: unknown) => {
        const text = payload === null ? "" : JSON.stringify(payload);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(text);
      };
      if (req.method === "GET" && req.url === "/v1/healthz") return send(200, { status: "ok" });
      if (req.method === "POST" && req.url === "/v1/auth/email") return send(202, { status: "sent" });
      if (req.method === "POST" && req.url === "/v1/auth/logout") return send(204, null);
      if (req.method === "GET" && req.url === "/v1/me") {
        if (req.headers.authorization !== "Bearer good") {
          return send(401, { error: { code: "unauthorized", message: "missing bearer token" } });
        }
        return send(200, { account: { display_name: "Lucas" }, identities: [{ kind: "github", subject: "42", login: "seth" }] });
      }
      if (req.method === "POST" && req.url === "/v1/auth/token") {
        if (body.code === "bad") return send(401, { error: { code: "invalid_grant", message: "invalid grant" } });
        if (body.grant_type === "refresh_token") {
          return send(200, { access_token: "a2", refresh_token: "r2", expires_in: 900, refresh_expires_in: 2592000 });
        }
        return send(200, { access_token: "a1", refresh_token: "r1", expires_in: 900, refresh_expires_in: 2592000 });
      }
      send(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

describe("cloud-api contra servidor local", () => {
  it("healthz responde", async () => {
    expect(await createCloudApi({ baseUrl }).health()).toBe(true);
  });

  it("startEmail aceita 202", async () => {
    const api = createCloudApi({ baseUrl });
    expect(await api.startEmail({ provider: "email" })).toEqual({ ok: true, value: null });
  });

  it("exchange lê o TokenPair", async () => {
    const api = createCloudApi({ baseUrl });
    const res = await api.exchange({ grant_type: "authorization_code", code: "good" });
    expect(res.ok && res.value.accessToken).toBe("a1");
    expect(res.ok && res.value.refreshToken).toBe("r1");
  });

  it("refresh lê o par rotacionado", async () => {
    const api = createCloudApi({ baseUrl });
    const res = await api.refresh({ grant_type: "refresh_token", refresh_token: "r1" });
    expect(res.ok && res.value.refreshToken).toBe("r2");
  });

  it("erro do backend vira CloudApiError com code", async () => {
    const api = createCloudApi({ baseUrl });
    const res = await api.exchange({ grant_type: "authorization_code", code: "bad" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ status: 401, code: "invalid_grant", message: "invalid grant" });
  });

  it("logout 204 sem corpo é sucesso", async () => {
    const api = createCloudApi({ baseUrl });
    expect(await api.logout("r1")).toEqual({ ok: true, value: null });
  });

  it("me com Bearer lê a conta; sem token é 401", async () => {
    const api = createCloudApi({ baseUrl });
    const good = await api.me("good");
    expect(good.ok && good.value.displayName).toBe("Lucas");
    const bad = await api.me("wrong");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.status).toBe(401);
  });

  it("falha de rede vira status 0 (nunca lança)", async () => {
    const api = createCloudApi({ baseUrl: "http://127.0.0.1:1" });
    const res = await api.health();
    expect(res).toBe(false);
    const me = await api.me("x");
    expect(me.ok).toBe(false);
    if (!me.ok) expect(me.error.status).toBe(0);
  });
});
