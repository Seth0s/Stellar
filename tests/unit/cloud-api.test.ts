/**
 * cloud-api.ts — o cliente HTTP, exercitado contra um servidor LOCAL em
 * processo (não é o backend Go, mas fala o MESMO contrato: envelope de erro,
 * TokenPair, /me, logout 204). Cobre tradução de status/erro e falha de rede.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApi } from "../../src/main/cloud-api";

const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVITE_ID = "44444444-4444-4444-8444-444444444444";
const ACC_ID = "22222222-2222-4222-8222-222222222222";

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
        return send(200, {
          account: { id: ACC_ID, display_name: "Lucas" },
          identities: [{ kind: "github", subject: "42", login: "seth" }],
          profiles: [{ id: "33333333-3333-4333-8333-333333333333", kind: "team", team_id: TEAM_ID, name: "Acme" }],
          teams: [{ id: TEAM_ID, name: "Acme", slug: "acme", created_by: ACC_ID, created_at: "2026-10-05T00:00:00Z" }],
        });
      }
      if (req.method === "POST" && req.url === "/v1/auth/token") {
        if (body.code === "bad") return send(401, { error: { code: "invalid_grant", message: "invalid grant" } });
        if (body.grant_type === "refresh_token") {
          return send(200, { access_token: "a2", refresh_token: "r2", expires_in: 900, refresh_expires_in: 2592000 });
        }
        return send(200, { access_token: "a1", refresh_token: "r1", expires_in: 900, refresh_expires_in: 2592000 });
      }

      // ---- TEAMS -----------------------------------------------------------
      const path = req.url ?? "";
      if (req.method === "POST" && path === "/v1/teams") {
        return send(201, { id: TEAM_ID, name: body.name, slug: "acme", created_by: ACC_ID, created_at: "2026-10-05T00:00:00Z" });
      }
      if (req.method === "GET" && path === `/v1/teams/${TEAM_ID}`) {
        return send(200, {
          team: { id: TEAM_ID, name: "Acme", slug: "acme", created_by: ACC_ID, created_at: "2026-10-05T00:00:00Z" },
          members: [{ team_id: TEAM_ID, account_id: ACC_ID, role: "owner", joined_at: null }],
        });
      }
      if (req.method === "POST" && path === `/v1/teams/${TEAM_ID}/invites`) {
        return send(201, {
          id: INVITE_ID,
          team_id: TEAM_ID,
          target: body.target,
          role: body.role,
          invited_by: ACC_ID,
          expires_at: null,
          accepted_at: null,
          revoked_at: null,
          created_at: null,
        });
      }
      if (req.method === "POST" && path === `/v1/invites/tok-1/accept`) {
        return send(200, { team: { id: TEAM_ID, name: "Acme", slug: "acme" }, membership: { team_id: TEAM_ID, account_id: ACC_ID, role: "member", joined_at: null } });
      }
      if (path === `/v1/teams/${TEAM_ID}/house`) {
        if (req.method === "GET") {
          return send(200, { revision: 3, manifest: [{ tool: "claude", path: "{claude}/skills/foo/SKILL.md", sha256: "a".repeat(64), size: 10, mode: "100644" }] });
        }
        if (req.method === "PUT") {
          const ifMatch = req.headers["if-match"];
          if (!ifMatch) return send(428, { error: { code: "precondition_required", message: "If-Match required" } });
          if (ifMatch !== "3") {
            return send(409, { error: { code: "revision_conflict", message: "conflict" }, current_revision: 3, current_manifest: [] });
          }
          return send(200, { revision: 4, manifest: body.manifest });
        }
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

describe("cloud-api — times (A4)", () => {
  it("createTeam/getTeam/meFull leem os shapes do backend", async () => {
    const api = createCloudApi({ baseUrl });
    const created = await api.createTeam("good", { name: "Acme" });
    expect(created.ok && created.value.slug).toBe("acme");

    const detail = await api.getTeam("good", TEAM_ID);
    expect(detail.ok && detail.value.members[0].role).toBe("owner");

    const me = await api.meFull("good");
    expect(me.ok && me.value.teams[0].id).toBe(TEAM_ID);
  });

  it("createInvite e acceptInvite", async () => {
    const api = createCloudApi({ baseUrl });
    const invite = await api.createInvite("good", TEAM_ID, { target: "membro@example.com", role: "member" });
    expect(invite.ok && invite.value.target).toBe("membro@example.com");
    const accepted = await api.acceptInvite("good", "tok-1");
    expect(accepted.ok && accepted.value.membership.role).toBe("member");
  });

  it("casa do time: GET lê o manifesto; PUT exige If-Match e trata 409", async () => {
    const api = createCloudApi({ baseUrl });
    const house = await api.getTeamHouse("good", TEAM_ID);
    expect(house.ok && house.value.revision).toBe(3);
    expect(house.ok && house.value.manifest[0].path).toBe("{claude}/skills/foo/SKILL.md");

    const entry = { tool: "claude" as const, path: "{claude}/skills/foo/SKILL.md", sha256: "a".repeat(64), size: 10, mode: "100644" };
    const ok = await api.putTeamHouse("good", TEAM_ID, { revision: 3, manifest: [entry] });
    expect(ok.ok && ok.value.revision).toBe(4);

    const conflict = await api.putTeamHouse("good", TEAM_ID, { revision: 1, manifest: [entry] });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok && conflict.conflict) expect(conflict.currentRevision).toBe(3);
  });
});
