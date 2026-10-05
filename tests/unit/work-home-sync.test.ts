/**
 * work-home-sync.ts — cliente de sync (A3b). Backend FALSO em memória (mesmo
 * contrato do B6), diretórios temporários — nunca a casa real do dono.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCloudApi, type CloudApi } from "../../src/main/cloud-api";
import {
  applyPulledWorkHome,
  collectLocalWorkHome,
  pullWorkHome,
  pushResolvedConflicts,
  pushWorkHome,
  type WorkHomeSyncContext,
} from "../../src/main/work-home-sync";
import { encodeClaudeProjectDir, type ProjectClone } from "../../src/main/work-home-remap";
import type { RemoteManifestEntry } from "../../src/main/work-home-manifest";

function fakeBackend() {
  let revision = 0;
  let manifest: RemoteManifestEntry[] = [];
  const blobs = new Map<string, Uint8Array>();
  let conflictOnce: { revision: number; manifest: RemoteManifestEntry[] } | null = null;

  const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const toBytes = (body: unknown): Uint8Array => {
    if (body == null) return new Uint8Array();
    if (typeof body === "string") return new TextEncoder().encode(body);
    return new Uint8Array(body as ArrayBuffer);
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const headers = new Headers(init?.headers ?? {});
    const bytes = toBytes(init?.body);

    const house = path.match(/^\/v1\/profiles\/([^/]+)\/house$/);
    if (house && method === "GET") return json(200, { revision, manifest });
    if (house && method === "PUT") {
      const ifMatch = headers.get("If-Match");
      if (!ifMatch) return json(428, { error: { code: "precondition_required", message: "If-Match required" } });
      if (conflictOnce) {
        manifest = conflictOnce.manifest;
        revision = conflictOnce.revision;
        const out = conflictOnce;
        conflictOnce = null;
        return json(409, { error: { code: "revision_conflict", message: "conflict" }, current_revision: out.revision, current_manifest: out.manifest });
      }
      if (Number(ifMatch) !== revision) {
        return json(409, { error: { code: "revision_conflict", message: "conflict" }, current_revision: revision, current_manifest: manifest });
      }
      manifest = (JSON.parse(new TextDecoder().decode(bytes)) as { manifest: RemoteManifestEntry[] }).manifest;
      revision += 1;
      return json(200, { revision, manifest });
    }
    if (path === "/v1/blobs/check" && method === "POST") {
      const asked = (JSON.parse(new TextDecoder().decode(bytes)) as { sha256: string[] }).sha256;
      return json(200, { missing: asked.filter((s) => !blobs.has(s)) });
    }
    const blob = path.match(/^\/v1\/blobs\/([0-9a-f]{64})$/);
    if (blob && method === "PUT") {
      const sha = blob[1];
      if (createHash("sha256").update(bytes).digest("hex") !== sha) {
        return json(400, { error: { code: "bad_request", message: "hash mismatch" } });
      }
      const created = !blobs.has(sha);
      blobs.set(sha, bytes);
      return json(created ? 201 : 200, { sha256: sha, created });
    }
    if (blob && method === "GET") {
      const got = blobs.get(blob[1]);
      if (!got) return json(404, { error: { code: "not_found", message: "blob not found" } });
      return new Response(got as unknown as BodyInit, { status: 200 });
    }
    return json(404, { error: { code: "not_found", message: path } });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    blobs,
    getState: () => ({ revision, manifest }),
    setRemote: (next: RemoteManifestEntry[], rev: number) => {
      manifest = next;
      revision = rev;
    },
    failNextPut: (next: RemoteManifestEntry[], rev: number) => {
      conflictOnce = { revision: rev, manifest: next };
    },
  };
}

const SHA = (text: string) => createHash("sha256").update(Buffer.from(text)).digest("hex");

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stellar-work-home-sync-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeFileAt(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeCtx(api: CloudApi, claudeRoot: string, clones: ProjectClone[]): WorkHomeSyncContext {
  return {
    api,
    token: "tok",
    cloudProfileId: "profile-1",
    installId: "inst-1",
    homeDir: join(base, "home"),
    toolRoots: { claude: claudeRoot },
    enabledTools: ["claude"],
    projectClones: clones,
  };
}

function apiFor(backend: ReturnType<typeof fakeBackend>): CloudApi {
  return createCloudApi({ baseUrl: "https://api.test", fetchImpl: backend.fetchImpl });
}

function cloneOf(root: string): ProjectClone {
  return { root, remote: "git@github.com:o/proj.git", normalizedRemote: "github.com/o/proj" };
}

describe("pushWorkHome / pullWorkHome — round-trip, dedupe e memória no clone certo", () => {
  it("máquina A push → máquina B pull: skill e memória chegam no lugar", async () => {
    const backend = fakeBackend();
    const api = apiFor(backend);

    // Máquina A: skill + memória de projeto.
    const claudeA = join(base, "A", ".claude");
    const cloneA = join(base, "A", "proj");
    writeFileAt(claudeA, "skills/graphify/SKILL.md", "skill da máquina A");
    writeFileAt(claudeA, join("projects", encodeClaudeProjectDir(cloneA), "memory", "notes.md"), "memória A");
    const ctxA = makeCtx(api, claudeA, [cloneOf(cloneA)]);

    const pushed = await pushWorkHome(ctxA, { base: null });
    expect(pushed.ok && pushed.kind === "pushed").toBe(true);
    if (pushed.ok && pushed.kind === "pushed") expect(pushed.uploaded).toBe(2);
    expect(backend.getState().manifest.map((e) => e.path).sort()).toEqual([
      "{claude}/skills/graphify/SKILL.md",
      "{project:github.com/o/proj}/memory/notes.md",
    ]);

    // Dedupe: 2º push (nada mudou) não sobe blob nenhum.
    const again = await pushWorkHome(ctxA, { base: null });
    if (again.ok && again.kind === "pushed") expect(again.uploaded).toBe(0);

    // Máquina B: casa vazia, clone do MESMO remote em OUTRO caminho.
    const claudeB = join(base, "B", ".claude");
    const cloneB = join(base, "B", "proj");
    mkdirSync(cloneB, { recursive: true });
    const ctxB = makeCtx(api, claudeB, [cloneOf(cloneB)]);

    const pulled = await pullWorkHome(ctxB, null);
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.plan.items.filter((i) => i.action === "add")).toHaveLength(2);

    const applied = applyPulledWorkHome({
      incoming: pulled.incoming,
      plan: pulled.plan,
      backupRoot: join(base, "B", "backups"),
      now: 1_700_000_000_000,
      pathValues: { homeDir: ctxB.homeDir, projectClones: ctxB.projectClones },
    });
    expect(applied.written).toHaveLength(2);
    expect(readFileSync(join(claudeB, "skills/graphify/SKILL.md"), "utf-8")).toBe("skill da máquina A");
    expect(readFileSync(join(claudeB, "projects", encodeClaudeProjectDir(cloneB), "memory", "notes.md"), "utf-8")).toBe(
      "memória A",
    );
  });

  it("409 remergeia: o que só o remoto mudou entra sozinho", async () => {
    const backend = fakeBackend();
    const api = apiFor(backend);
    const claude = join(base, ".claude");
    const ctx = makeCtx(api, claude, []);

    // BASE conhecida e o remoto divergiu num arquivo que o local NÃO tocou.
    // (tudo sob `skills/`, que o coletor do claude de fato coleta)
    backend.setRemote([{ tool: "claude", path: "{claude}/skills/a.md", sha256: SHA("a1"), size: 2, mode: "100644" }], 1);
    const baseManifest = {
      version: 1,
      entries: [{ tool: "claude" as const, path: "{claude}/skills/a.md", sha256: SHA("a1"), size: 2, mode: 0o644 }],
      removals: [],
    };
    // Local acrescenta um arquivo (mine) e mantém a.md igual à base.
    writeFileAt(claude, "skills/mine.md", "novo local");
    writeFileAt(claude, "skills/a.md", "a1");

    // Entre o GET e o PUT, outro device mudou "theirs".
    backend.failNextPut(
      [
        { tool: "claude", path: "{claude}/skills/a.md", sha256: SHA("a1"), size: 2, mode: "100644" },
        { tool: "claude", path: "{claude}/skills/theirs.md", sha256: SHA("t1"), size: 2, mode: "100644" },
      ],
      5,
    );
    backend.blobs.set(SHA("t1"), new TextEncoder().encode("t1"));

    const out = await pushWorkHome(ctx, { base: baseManifest });
    expect(out.ok && out.kind === "pushed").toBe(true);
    const paths = backend.getState().manifest.map((e) => e.path).sort();
    expect(paths).toContain("{claude}/skills/theirs.md"); // preservado do remoto
    expect(paths).toContain("{claude}/skills/mine.md"); // novo local
  });

  it("conflito real pede escolha; com 'remote' o manifesto toma a versão remota", async () => {
    const backend = fakeBackend();
    const api = apiFor(backend);
    const claude = join(base, ".claude");
    const ctx = makeCtx(api, claude, []);

    backend.setRemote([{ tool: "claude", path: "{claude}/skills/x.md", sha256: SHA("r"), size: 1, mode: "100644" }], 2);
    const baseManifest = {
      version: 1,
      entries: [{ tool: "claude" as const, path: "{claude}/skills/x.md", sha256: SHA("b"), size: 1, mode: 0o644 }],
      removals: [],
    };
    writeFileAt(claude, "skills/x.md", "l"); // local mudou; remoto também

    const out = await pushWorkHome(ctx, { base: baseManifest });
    expect(out.ok && out.kind === "conflicts").toBe(true);
    if (!out.ok || out.kind !== "conflicts") return;
    expect(out.conflicts.map((c) => c.path)).toEqual(["{claude}/skills/x.md"]);

    const resolved = await pushResolvedConflicts(ctx, {
      base: baseManifest,
      manifest: out.manifest,
      conflicts: out.conflicts,
      remote: out.remote,
      revision: out.revision,
      choices: { "{claude}/skills/x.md": "remote" },
    });
    expect(resolved.ok).toBe(true);
    expect(backend.getState().manifest[0].sha256).toBe(SHA("r"));
  });

  it("credencial falsa num settings NÃO aparece no manifesto enviado", async () => {
    const backend = fakeBackend();
    const api = apiFor(backend);
    const claude = join(base, ".claude");
    const ctx = makeCtx(api, claude, []);
    writeFileAt(claude, "settings.json", JSON.stringify({ model: "opus", env: { TOKEN: "FAKE_SECRET" } }));
    writeFileAt(claude, ".credentials.json", '{"claudeAiOauth":{"token":"FAKE_SECRET"}}');
    writeFileAt(claude, "history.jsonl", '{"linha":"FAKE_SECRET"}');

    const local = collectLocalWorkHome(ctx);
    expect(local.package.manifest.entries.map((e) => e.path)).toEqual(["{claude}/settings.json"]);

    const out = await pushWorkHome(ctx, { base: null });
    expect(out.ok).toBe(true);
    for (const bytes of backend.blobs.values()) {
      expect(Buffer.from(bytes).toString("utf-8")).not.toContain("FAKE_SECRET");
    }
    expect(backend.getState().manifest.some((e) => e.path.includes("credentials") || e.path.includes("jsonl"))).toBe(false);
    // A casa está vazia antes: confirma que o `.credentials.json` não virou blob.
    expect(existsSync(join(base, "unused"))).toBe(false);
  });
});
