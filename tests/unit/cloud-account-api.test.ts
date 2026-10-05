/**
 * cloud-api.ts — the new account methods (A8): server profiles and devices.
 * A FAKE backend in memory; no real network.
 */
import { describe, expect, it } from "vitest";
import { createCloudApi } from "../../src/main/cloud-api";

const P1 = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";

function backend(routes: Record<string, () => Response>) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = routes[`${method} ${url.pathname}`];
    if (handler) return handler();
    return new Response(JSON.stringify({ error: { code: "not_found", message: url.pathname } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return createCloudApi({ baseUrl: "https://api.test", fetchImpl });
}

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

describe("profiles", () => {
  it("listProfiles lê {profiles:[…]} e descarta id inválido", async () => {
    const api = backend({
      "GET /v1/profiles": () =>
        json(200, {
          profiles: [
            { id: P1, kind: "personal", name: "Pessoal", team_id: null },
            { id: "nope", kind: "personal", name: "Lixo" },
          ],
        }),
    });
    const res = await api.listProfiles("tok");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0]).toEqual({ id: P1, kind: "personal", name: "Pessoal", teamId: null });
  });

  it("createProfile devolve o perfil criado; resposta sem id é erro", async () => {
    const api = backend({ "POST /v1/profiles": () => json(201, { id: P1, kind: "personal", name: "Novo" }) });
    const ok = await api.createProfile("tok", { kind: "personal", name: "Novo" });
    expect(ok.ok && ok.value.id).toBe(P1);

    const bad = backend({ "POST /v1/profiles": () => json(201, { name: "sem id" }) });
    const res = await bad.createProfile("tok", { kind: "personal", name: "Novo" });
    expect(res.ok).toBe(false);
  });
});

describe("devices", () => {
  it("listDevices mapeia install_id/label/last_seen_at", async () => {
    const api = backend({
      "GET /v1/devices": () =>
        json(200, {
          devices: [
            { id: DEV, account_id: "a", install_id: "inst-1", label: "notebook", last_seen_at: "2026-10-05T00:00:00Z" },
            { id: "bad", install_id: "inst-2", label: "lixo" },
          ],
        }),
    });
    const res = await api.listDevices("tok");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([{ id: DEV, installId: "inst-1", label: "notebook", lastSeenAt: "2026-10-05T00:00:00Z" }]);
  });

  it("deleteDevice: 204 é ok; 404 vira erro com status", async () => {
    const ok = backend({ [`DELETE /v1/devices/${DEV}`]: () => new Response(null, { status: 204 }) });
    expect(await ok.deleteDevice("tok", DEV)).toEqual({ ok: true, value: null });

    const missing = backend({ [`DELETE /v1/devices/${DEV}`]: () => json(404, { error: { code: "not_found", message: "no" } }) });
    const res = await missing.deleteDevice("tok", DEV);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.status).toBe(404);
  });
});
