/**
 * team.ts — the team I/O shell. A FAKE backend in memory (same contract as the
 * real one), temporary directories — never the owner's real house.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCloudApi, type CloudApi } from "../../src/main/cloud-api";
import { profileDirectory, type ProfileEntry } from "../../src/main/profiles";
import { describeProfilesState } from "../../src/main/profiles";
import type { RemoteManifestEntry } from "../../src/main/work-home-manifest";
import {
  acceptTeamInvite,
  applyTeamHouse,
  createAccountTeam,
  leaveTeam,
  previewTeamPublish,
  publishTeamHouse,
  pullTeamHouse,
  type TeamContext,
} from "../../src/main/team";

const P1 = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVITE = "44444444-4444-4444-8444-444444444444";

const SHA = (text: string) => createHash("sha256").update(Buffer.from(text)).digest("hex");

function fakeBackend(opts: { accept?: "ok" | "mismatch" } = {}) {
  let revision = 0;
  let manifest: RemoteManifestEntry[] = [];
  const blobs = new Map<string, Uint8Array>();
  const puts: { revision: number; manifest: RemoteManifestEntry[] }[] = [];
  const teams = [{ id: TEAM, name: "Acme", slug: "acme" }];

  const json = (status: number, obj: unknown) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const bytesOf = (body: unknown): Uint8Array => {
    if (body == null) return new Uint8Array();
    if (typeof body === "string") return new TextEncoder().encode(body);
    return new Uint8Array(body as ArrayBuffer);
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const headers = new Headers(init?.headers ?? {});
    const body = bytesOf(init?.body);

    if (path === "/v1/me" && method === "GET") {
      return json(200, {
        account: { id: ACC, display_name: "Lucas" },
        identities: [{ kind: "email", subject: "owner@example.com", login: null }],
        profiles: [{ id: P1, kind: "personal", team_id: null, name: "Pessoal" }],
        teams,
      });
    }
    if (path === "/v1/teams" && method === "POST") {
      return json(201, { id: TEAM, name: "Acme", slug: "acme", created_by: ACC, created_at: "2026-10-05T00:00:00Z" });
    }
    if (/^\/v1\/teams\/[^/]+$/.test(path) && method === "GET") {
      return json(200, { team: teams[0], members: [{ team_id: TEAM, account_id: ACC, role: "owner", joined_at: null }] });
    }
    if (/^\/v1\/teams\/[^/]+\/invites$/.test(path) && method === "POST") {
      return json(201, {
        id: INVITE,
        team_id: TEAM,
        target: "membro@example.com",
        role: "member",
        invited_by: ACC,
        expires_at: null,
        accepted_at: null,
        revoked_at: null,
        created_at: null,
      });
    }
    if (/^\/v1\/invites\/[^/]+\/accept$/.test(path) && method === "POST") {
      if (opts.accept === "mismatch") {
        return json(403, { error: { code: "invite_target_mismatch", message: "this invite is for another account" } });
      }
      return json(200, { team: teams[0], membership: { team_id: TEAM, account_id: ACC, role: "member", joined_at: null } });
    }
    if (/^\/v1\/teams\/[^/]+\/members\/[^/]+$/.test(path) && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (/^\/v1\/teams\/[^/]+\/house$/.test(path)) {
      if (method === "GET") return json(200, { revision, manifest });
      if (method === "PUT") {
        const ifMatch = Number(headers.get("If-Match"));
        if (ifMatch !== revision) {
          return json(409, { error: { code: "revision_conflict", message: "conflict" }, current_revision: revision, current_manifest: manifest });
        }
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { manifest: RemoteManifestEntry[] };
        revision += 1;
        manifest = parsed.manifest;
        puts.push({ revision, manifest });
        return json(200, { revision, manifest });
      }
    }
    if (path === "/v1/blobs/check" && method === "POST") {
      const asked = (JSON.parse(new TextDecoder().decode(body)) as { sha256: string[] }).sha256;
      return json(200, { missing: asked.filter((s) => !blobs.has(s)) });
    }
    const blob = path.match(/^\/v1\/blobs\/([0-9a-f]{64})$/);
    if (blob && method === "PUT") {
      blobs.set(blob[1], body);
      return json(201, { sha256: blob[1], created: true });
    }
    if (blob && method === "GET") {
      const got = blobs.get(blob[1]);
      if (!got) return json(404, { error: { code: "not_found", message: "no blob" } });
      return new Response(got as unknown as BodyInit, { status: 200 });
    }
    return json(404, { error: { code: "not_found", message: path } });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    puts,
    blobs,
    setHouse: (next: RemoteManifestEntry[], rev: number) => {
      manifest = next;
      revision = rev;
    },
  };
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stellar-team-"));
  writeFileSync(
    join(base, "profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultProfileId: P1,
      profiles: [{ id: P1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }],
    }),
  );
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeFileAt(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

let idCounter = 0;
function makeCtx(api: CloudApi): TeamContext {
  return {
    api,
    token: "tok",
    baseUserDataDir: base,
    homeDir: join(base, "home"),
    installId: "inst-1",
    now: 1_700_000_000_000 + idCounter,
    generateId: () => `99999999-9999-4999-8999-${String(++idCounter).padStart(12, "0")}`,
    agentProviders: [{ id: "claude", supportsConfigHome: true }],
    activeProfile: { id: P1, dir: profileDirectory(base, P1), homeMode: "isolated" },
  };
}

function teamProfileOf(): ProfileEntry | null {
  const p = describeProfilesState(base, P1).profiles.find((v) => v.teamId === TEAM) ?? null;
  if (!p) return null;
  return { id: p.id, name: p.name, kind: "team", createdAt: p.createdAt, homeMode: p.homeMode, team: { id: TEAM, slug: "acme", name: "Acme" } };
}

describe("criar time cria o perfil local (kind=team, isolated)", () => {
  it("createAccountTeam", async () => {
    const backend = fakeBackend();
    const ctx = makeCtx(createCloudApi({ baseUrl: "http://x", fetchImpl: backend.fetchImpl }));
    const res = await createAccountTeam(ctx, { name: "Acme" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const profile = teamProfileOf();
    expect(profile).not.toBeNull();
    expect(profile!.kind).toBe("team");
    expect(profile!.homeMode).toBe("isolated");
    expect(profile!.team!.slug).toBe("acme");
  });
});

describe("aceite do convite", () => {
  it("cria o perfil local quando o backend aceita", async () => {
    const backend = fakeBackend({ accept: "ok" });
    const ctx = makeCtx(createCloudApi({ baseUrl: "http://x", fetchImpl: backend.fetchImpl }));
    const res = await acceptTeamInvite(ctx, "tok-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.profileCreated).toBe(true);
    expect(teamProfileOf()).not.toBeNull();
  });

  it("identidade ERRADA (403) não deixa rastro local", async () => {
    const backend = fakeBackend({ accept: "mismatch" });
    const ctx = makeCtx(createCloudApi({ baseUrl: "http://x", fetchImpl: backend.fetchImpl }));
    const res = await acceptTeamInvite(ctx, "tok-de-outro");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("identity-mismatch");
    expect(teamProfileOf()).toBeNull();
  });
});

describe("publicar a base (admin/owner)", () => {
  it("sobe a skill e NÃO sobe memória; materializa o manifesto sem memória", async () => {
    const backend = fakeBackend();
    const ctx = makeCtx(createCloudApi({ baseUrl: "http://x", fetchImpl: backend.fetchImpl }));
    const activeDir = ctx.activeProfile.dir;
    writeFileAt(activeDir, "homes/claude/skills/foo/SKILL.md", "---\nname: foo\n---\nconteudo\n");
    writeFileAt(activeDir, "homes/claude/settings.json", JSON.stringify({ model: "opus", env: { SECRET: "nope" } }));
    // project memory: it must NOT travel (the collector does not even include it without a clone).
    writeFileAt(activeDir, "homes/claude/projects/-home-u/memory/nota.md", "memoria");

    const preview = previewTeamPublish(ctx);
    expect(preview.entries.map((e) => e.path)).toContain("{claude}/skills/foo/SKILL.md");
    expect(preview.entries.some((e) => e.path.includes("memory"))).toBe(false);

    const out = await publishTeamHouse(ctx, TEAM);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.count).toBe(preview.entries.length);
    expect(backend.puts.length).toBe(1);
    const sent = backend.puts[0].manifest.map((e) => e.path);
    expect(sent).toContain("{claude}/skills/foo/SKILL.md");
    expect(sent.some((p) => p.includes("memory"))).toBe(false);
    // The memory is not in the manifest that was sent to the server.
    expect(sent).not.toContain("{project:github.com/o/r}/memory/nota.md");
  });
});

describe("materializar a base no membro (com prefixo)", () => {
  it("prefixa a skill e grava no perfil do time", async () => {
    const backend = fakeBackend();
    const ctx = makeCtx(createCloudApi({ baseUrl: "http://x", fetchImpl: backend.fetchImpl }));
    const created = await createAccountTeam(ctx, { name: "Acme" });
    expect(created.ok).toBe(true);
    const teamProfile = teamProfileOf();
    if (!teamProfile) throw new Error("perfil do time não criado");

    const content = "---\nname: foo\n---\nconteudo do time\n";
    const sha = SHA(content);
    backend.blobs.set(sha, new TextEncoder().encode(content));
    backend.setHouse([{ tool: "claude", path: "{claude}/skills/foo/SKILL.md", sha256: sha, size: content.length, mode: "100644" }], 1);

    const pull = await pullTeamHouse(ctx, TEAM);
    expect(pull.ok).toBe(true);
    if (!pull.ok) return;
    const paths = pull.value.plan.items.map((i) => i.path);
    expect(paths).toContain("{claude}/skills/team-acme-foo/SKILL.md");
    expect(pull.value.slug).toBe("acme");

    const applied = await applyTeamHouse(ctx, TEAM);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const teamDir = profileDirectory(base, teamProfile.id);
    const written = join(teamDir, "homes", "claude", "skills", "team-acme-foo", "SKILL.md");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf-8")).toBe(content);
  });
});

describe("sair do time desliga o perfil local sem apagar", () => {
  it("leaveTeam marca detached", async () => {
    const backend = fakeBackend();
    const ctx = makeCtx(createCloudApi({ baseUrl: "http://x", fetchImpl: backend.fetchImpl }));
    await createAccountTeam(ctx, { name: "Acme" });
    const before = describeProfilesState(base, P1).profiles.find((v) => v.teamId === TEAM);
    expect(before?.detached).toBe(false);

    const res = await leaveTeam(ctx, TEAM);
    expect(res.ok).toBe(true);
    const after = describeProfilesState(base, P1).profiles.find((v) => v.teamId === TEAM);
    expect(after).not.toBeUndefined();
    expect(after?.detached).toBe(true);
  });
});
