/**
 * profiles-cloud.ts — the shell of the local<->server link. A FAKE backend in
 * memory (same `GET`/`POST /v1/profiles` contract) and `profiles.json` in a
 * temporary directory — never the owner's userData.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCloudApi } from "../../src/main/cloud-api";
import {
  ensureCloudProfileId,
  readCloudLinkView,
  writeCloudLink,
} from "../../src/main/profiles-cloud";
import { profileDirectory } from "../../src/main/profiles";
import { workHomeBasePath } from "../../src/main/work-home-sync";

const P1 = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";
const SERVER2 = "33333333-3333-4333-8333-333333333333";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function registryWith(profiles: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, defaultProfileId: P1, profiles });
}

function fakeBackend(opts: { profiles?: unknown[]; created?: unknown } = {}) {
  let getCalls = 0;
  let postCalls = 0;
  let lastPostBody: unknown = null;
  const json = (status: number, obj: unknown) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/profiles" && method === "GET") {
      getCalls++;
      return json(200, { profiles: opts.profiles ?? [] });
    }
    if (url.pathname === "/v1/profiles" && method === "POST") {
      postCalls++;
      const raw = init?.body;
      const text = typeof raw === "string" ? raw : raw ? new TextDecoder().decode(raw as Uint8Array) : "";
      lastPostBody = JSON.parse(text);
      return json(201, opts.created ?? { id: SERVER, kind: "personal", name: "Novo" });
    }
    return json(404, { error: { code: "not_found", message: url.pathname } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => ({ getCalls, postCalls, lastPostBody }) };
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stellar-profiles-cloud-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function apiFor(backend: ReturnType<typeof fakeBackend>) {
  return createCloudApi({ baseUrl: "https://api.test", fetchImpl: backend.fetchImpl });
}

describe("ensureCloudProfileId", () => {
  it("vincula por kind + nome num perfil sem cloudProfileId", async () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([{ id: P1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" }]),
    );
    const backend = fakeBackend({ profiles: [{ id: SERVER, kind: "personal", name: "Pessoal", team_id: null }] });
    const res = await ensureCloudProfileId({ api: apiFor(backend), token: "tok", baseUserDataDir: base, localProfileId: P1 });
    expect(res).toEqual({ ok: true, cloudProfileId: SERVER });
    const saved = JSON.parse(readFileSync(join(base, "profiles.json"), "utf8"));
    expect(saved.profiles[0].cloudProfileId).toBe(SERVER);
    expect(backend.calls().getCalls).toBe(1);
  });

  it("um perfil JÁ vinculado não vai à rede de novo", async () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([{ id: P1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system", cloudProfileId: SERVER }]),
    );
    const backend = fakeBackend({ profiles: [] });
    const res = await ensureCloudProfileId({ api: apiFor(backend), token: "tok", baseUserDataDir: base, localProfileId: P1 });
    expect(res).toEqual({ ok: true, cloudProfileId: SERVER });
    expect(backend.calls().getCalls).toBe(0);
  });

  it("cria um perfil pessoal no servidor quando não há par e vincula o id que voltar", async () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([{ id: P1, name: "Empresa", kind: "personal", createdAt: 1, homeMode: "isolated" }]),
    );
    const backend = fakeBackend({ profiles: [], created: { id: SERVER2, kind: "personal", name: "Empresa" } });
    const res = await ensureCloudProfileId({ api: apiFor(backend), token: "tok", baseUserDataDir: base, localProfileId: P1 });
    expect(res).toEqual({ ok: true, cloudProfileId: SERVER2 });
    expect(backend.calls().lastPostBody).toEqual({ kind: "personal", name: "Empresa" });
    const saved = JSON.parse(readFileSync(join(base, "profiles.json"), "utf8"));
    expect(saved.profiles[0].cloudProfileId).toBe(SERVER2);
  });

  it("perfil de time vincula pelo team_id do servidor", async () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([
        {
          id: P1,
          name: "Acme",
          kind: "team",
          createdAt: 1,
          homeMode: "isolated",
          team: { id: TEAM, slug: "acme", name: "Acme" },
        },
      ]),
    );
    const backend = fakeBackend({ profiles: [{ id: SERVER2, kind: "team", name: "Acme", team_id: TEAM }] });
    const res = await ensureCloudProfileId({ api: apiFor(backend), token: "tok", baseUserDataDir: base, localProfileId: P1 });
    expect(res).toEqual({ ok: true, cloudProfileId: SERVER2 });
    expect(backend.calls().postCalls).toBe(0);
  });

  it("perfil de time ausente no servidor devolve erro (não cria)", async () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([
        {
          id: P1,
          name: "Acme",
          kind: "team",
          createdAt: 1,
          homeMode: "isolated",
          team: { id: TEAM, slug: "acme", name: "Acme" },
        },
      ]),
    );
    const backend = fakeBackend({ profiles: [] });
    const res = await ensureCloudProfileId({ api: apiFor(backend), token: "tok", baseUserDataDir: base, localProfileId: P1 });
    expect(res.ok).toBe(false);
    expect(backend.calls().postCalls).toBe(0);
  });
});

describe("writeCloudLink zera a base local do sync", () => {
  it("some com work-home-base.json e grava o vínculo", () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([{ id: P1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" }]),
    );
    const dir = profileDirectory(base, P1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(workHomeBasePath(dir), JSON.stringify({ version: 1, entries: [], removals: [] }));

    const res = writeCloudLink({ baseUserDataDir: base, localProfileId: P1, cloudProfileId: SERVER });
    expect(res.ok).toBe(true);
    expect(existsSync(workHomeBasePath(dir))).toBe(false);
    const saved = JSON.parse(readFileSync(join(base, "profiles.json"), "utf8"));
    expect(saved.profiles[0].cloudProfileId).toBe(SERVER);
  });

  it("null limpa o vínculo (por omissão)", () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([{ id: P1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system", cloudProfileId: SERVER }]),
    );
    const res = writeCloudLink({ baseUserDataDir: base, localProfileId: P1, cloudProfileId: null });
    expect(res.ok).toBe(true);
    const saved = JSON.parse(readFileSync(join(base, "profiles.json"), "utf8"));
    expect("cloudProfileId" in saved.profiles[0]).toBe(false);
  });
});

describe("readCloudLinkView", () => {
  it("devolve o vínculo do perfil ATIVO e os perfis da conta", async () => {
    writeFileSync(
      join(base, "profiles.json"),
      registryWith([{ id: P1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" }]),
    );
    const backend = fakeBackend({
      profiles: [
        { id: SERVER, kind: "personal", name: "Pessoal", team_id: null },
        { id: SERVER2, kind: "personal", name: "Empresa", team_id: null },
      ],
    });
    const res = await readCloudLinkView({ api: apiFor(backend), token: "tok", baseUserDataDir: base, localProfileId: P1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.profileId).toBe(P1);
    expect(res.view.cloudProfileId).toBeNull();
    expect(res.view.available.map((p) => p.name)).toEqual(["Pessoal", "Empresa"]);
  });
});
