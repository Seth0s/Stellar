/**
 * "Member removed on the server" — the pure decision (`teamErrorMeansDetached`)
 * and the shell (`team.ts`): the local team profile turns `detached`, deleting
 * nothing. A FAKE backend in memory, temporary directories.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCloudApi } from "../../src/main/cloud-api";
import { profileDirectory, describeProfilesState } from "../../src/main/profiles";
import { teamErrorMeansDetached } from "../../src/main/team-decision";
import { fetchTeamDetail, fetchTeamOverview, leaveTeam, removeTeamMember, type TeamContext } from "../../src/main/team";

const P1 = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEAM_PROFILE = {
  id: P1,
  name: "Acme",
  kind: "team",
  createdAt: 1,
  homeMode: "isolated",
  team: { id: TEAM, slug: "acme", name: "Acme" },
};

/** Fake backend: `/v1/me` (own teams may be empty), team detail and member
 *  removal answer with the status/code the test asks for. */
function fakeBackend(opts: { meTeams?: { id: string; name: string; slug: string }[]; detailStatus?: number; removeStatus?: number } = {}) {
  const json = (status: number, obj: unknown) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/me" && method === "GET") {
      return json(200, {
        account: { id: ACC, display_name: "Bob" },
        identities: [],
        profiles: [],
        teams: opts.meTeams ?? [],
      });
    }
    if (/^\/v1\/teams\/[^/]+$/.test(url.pathname) && method === "GET") {
      const status = opts.detailStatus ?? 200;
      if (status !== 200) return json(status, { error: { code: status === 403 ? "forbidden" : "not_found", message: "no" } });
      return json(200, { team: { id: TEAM, name: "Acme", slug: "acme" }, members: [{ account_id: ACC, role: "member", joined_at: null }] });
    }
    if (/^\/v1\/teams\/[^/]+\/members\/[^/]+$/.test(url.pathname) && method === "DELETE") {
      const status = opts.removeStatus ?? 204;
      if (status === 204) return new Response(null, { status: 204 });
      return json(status, { error: { code: status === 403 ? "forbidden" : "not_found", message: "gone" } });
    }
    return json(404, { error: { code: "not_found", message: url.pathname } });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stellar-team-detach-"));
  writeFileSync(join(base, "profiles.json"), JSON.stringify({ schemaVersion: 1, defaultProfileId: P1, profiles: [TEAM_PROFILE] }));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function ctx(fetchImpl: typeof fetch): TeamContext {
  return {
    api: createCloudApi({ baseUrl: "http://x", fetchImpl }),
    token: "tok",
    baseUserDataDir: base,
    homeDir: join(base, "home"),
    installId: "inst-1",
    now: 1,
    generateId: () => P1,
    agentProviders: [],
    activeProfile: { id: P1, dir: profileDirectory(base, P1), homeMode: "isolated" },
  };
}

function detached(): boolean {
  return describeProfilesState(base, P1).profiles.find((p) => p.teamId === TEAM)?.detached === true;
}

describe("teamErrorMeansDetached", () => {
  it("404 sempre; 403 só fora das recusas de papel/alvo; resto não", () => {
    expect(teamErrorMeansDetached(404, "not_found")).toBe(true);
    expect(teamErrorMeansDetached(403, "forbidden")).toBe(false);
    expect(teamErrorMeansDetached(403, "invite_target_mismatch")).toBe(false);
    expect(teamErrorMeansDetached(403, "some_new_code")).toBe(true);
    expect(teamErrorMeansDetached(500, "internal")).toBe(false);
    expect(teamErrorMeansDetached(200, "ok")).toBe(false);
  });
});

describe("fetchTeamDetail 404 desliga o perfil de time", () => {
  it("detached", async () => {
    const res = await fetchTeamDetail(ctx(fakeBackend({ detailStatus: 404 })), TEAM);
    expect(res.ok).toBe(false);
    expect(detached()).toBe(true);
  });

  it("403 de papel NÃO desliga", async () => {
    const res = await fetchTeamDetail(ctx(fakeBackend({ detailStatus: 403 })), TEAM);
    expect(res.ok).toBe(false);
    expect(detached()).toBe(false);
  });
});

describe("fetchTeamOverview reconcilia com /me", () => {
  it("time ausente de /me desliga o perfil", async () => {
    const res = await fetchTeamOverview(ctx(fakeBackend({ meTeams: [] })));
    expect(res.ok).toBe(true);
    expect(detached()).toBe(true);
  });

  it("time presente em /me mantém o perfil ativo", async () => {
    const res = await fetchTeamOverview(ctx(fakeBackend({ meTeams: [{ id: TEAM, name: "Acme", slug: "acme" }] })));
    expect(res.ok).toBe(true);
    expect(detached()).toBe(false);
  });
});

describe("leaveTeam trata 404 como 'já saiu' e desliga", () => {
  it("detached", async () => {
    const res = await leaveTeam(ctx(fakeBackend({ removeStatus: 404 })), TEAM);
    expect(res.ok).toBe(true);
    expect(detached()).toBe(true);
  });
});

describe("removeTeamMember (admin removendo terceiro) não desliga o perfil do CHAMADOR", () => {
  it("mantém ativo mesmo com 204", async () => {
    const res = await removeTeamMember(ctx(fakeBackend({ removeStatus: 204 })), TEAM, ACC);
    expect(res.ok).toBe(true);
    expect(detached()).toBe(false);
  });
});
