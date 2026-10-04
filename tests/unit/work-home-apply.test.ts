/**
 * work-home-apply.ts — aplicador (A3a, §5.3). Diretórios temporários e
 * arquivos falsos; nunca a árvore real das CLIs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyWorkHomePlan, sha256FileSync, suffixedPath, type ApplyWorkHomeInput } from "../../src/main/work-home-apply";
import { planWorkHomeApply, type WorkHomeApplyPlan } from "../../src/main/work-home-apply-decision";
import { buildManifest, sha256Hex, type WorkHomeManifestEntry, type WorkHomePackage } from "../../src/main/work-home-manifest";

const NOW = 1_700_000_000_000;
const S = (text: string) => sha256Hex(Buffer.from(text));

let base: string;
let claudeRoot: string;
let homeDir: string;
let backupRoot: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stellar-work-home-apply-"));
  claudeRoot = join(base, ".claude");
  homeDir = join(base, "home");
  backupRoot = join(base, "backups");
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function pkgOf(files: { tool: WorkHomeManifestEntry["tool"]; path: string; content: string }[]): WorkHomePackage {
  const blobs = new Map<string, Uint8Array>();
  const entries: WorkHomeManifestEntry[] = files.map((f) => {
    const bytes = Buffer.from(f.content);
    const sha = sha256Hex(bytes);
    if (!blobs.has(sha)) blobs.set(sha, bytes);
    return { tool: f.tool, path: f.path, sha256: sha, size: bytes.byteLength, mode: 0o644 };
  });
  return { manifest: buildManifest(entries), blobs };
}

function writeClaude(rel: string, content: string): string {
  const abs = join(claudeRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function scenario(): { plan: WorkHomeApplyPlan; incoming: WorkHomePackage } {
  writeClaude("upd.md", "antigo");
  writeClaude("conf.md", "local");
  writeClaude("gone.md", "z");
  writeClaude("keep.md", "fica");

  const incoming = pkgOf([
    { tool: "claude", path: "{claude}/upd.md", content: "novo" },
    { tool: "claude", path: "{claude}/new.md", content: "novo-arquivo" },
    { tool: "claude", path: "{claude}/conf.md", content: "remoto" },
  ]);
  incoming.manifest.removals = ["{claude}/gone.md"];
  const baseManifest = buildManifest([
    { tool: "claude", path: "{claude}/upd.md", sha256: S("antigo"), size: 6, mode: 0o644 },
    { tool: "claude", path: "{claude}/conf.md", sha256: S("base"), size: 4, mode: 0o644 },
    { tool: "claude", path: "{claude}/gone.md", sha256: S("z"), size: 1, mode: 0o644 },
  ]);
  const plan = planWorkHomeApply({
    incoming,
    base: baseManifest,
    toolRoots: { claude: claudeRoot },
    homeDir,
    projectClones: [],
    shaOf: sha256FileSync,
  });
  return { plan, incoming };
}

function apply(input: Partial<ApplyWorkHomeInput> & { plan: WorkHomeApplyPlan }): ReturnType<typeof applyWorkHomePlan> {
  return applyWorkHomePlan({ blobs: new Map(), backupRoot, now: NOW, ...input });
}

describe("applyWorkHomePlan", () => {
  it("escreve add/update com backup datado e atômico, e nunca apaga sem marca", () => {
    const { plan, incoming } = scenario();
    const result = apply({ plan, blobs: incoming.blobs });

    expect(readFileSync(join(claudeRoot, "upd.md"), "utf-8")).toBe("novo");
    expect(readFileSync(join(claudeRoot, "new.md"), "utf-8")).toBe("novo-arquivo");
    expect(readFileSync(join(claudeRoot, "keep.md"), "utf-8")).toBe("fica");

    // Conflito sem escolha não é resolvido sozinho.
    expect(readFileSync(join(claudeRoot, "conf.md"), "utf-8")).toBe("local");
    expect(result.conflicts.map((c) => c.path)).toEqual(["{claude}/conf.md"]);

    // Remoção explícita: arquivo apagado, backup preservado.
    expect(existsSync(join(claudeRoot, "gone.md"))).toBe(false);
    expect(result.removed.map((r) => r.path)).toEqual(["{claude}/gone.md"]);

    // Backups datados.
    expect(result.backupDir).toBe(join(backupRoot, `work-home-backup-${NOW}`));
    expect(readFileSync(join(result.backupDir!, "claude", "upd.md"), "utf-8")).toBe("antigo");
    expect(readFileSync(join(result.backupDir!, "claude", "gone.md"), "utf-8")).toBe("z");
    // add não tem backup (não havia arquivo).
    expect(existsSync(join(result.backupDir!, "claude", "new.md"))).toBe(false);

    // Escrita atômica: nenhum tmp órfão.
    expect(readdirSync(claudeRoot).some((n) => n.includes("work-home-tmp"))).toBe(false);
  });

  it("conflito resolvido como 'remote' sobrescreve com backup", () => {
    const { plan, incoming } = scenario();
    const result = apply({ plan, blobs: incoming.blobs, choices: { "{claude}/conf.md": "remote" } });
    expect(readFileSync(join(claudeRoot, "conf.md"), "utf-8")).toBe("remoto");
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(join(result.backupDir!, "claude", "conf.md"), "utf-8")).toBe("local");
  });

  it("conflito resolvido como 'both' cria sufixo sem tocar no local", () => {
    const { plan, incoming } = scenario();
    const result = apply({ plan, blobs: incoming.blobs, choices: { "{claude}/conf.md": "both" } });
    expect(readFileSync(join(claudeRoot, "conf.md"), "utf-8")).toBe("local");
    const dest = suffixedPath(join(claudeRoot, "conf.md"), String(NOW));
    expect(readFileSync(dest, "utf-8")).toBe("remoto");
    expect(result.written.some((w) => w.targetPath === dest)).toBe(true);
  });

  it("conflito resolvido como 'local' não escreve nada", () => {
    const { plan, incoming } = scenario();
    const result = apply({ plan, blobs: incoming.blobs, choices: { "{claude}/conf.md": "local" } });
    expect(readFileSync(join(claudeRoot, "conf.md"), "utf-8")).toBe("local");
    expect(result.keptLocal).toEqual(["{claude}/conf.md"]);
    expect(result.conflicts).toEqual([]);
  });

  it("pendência (projeto sem clone) é reportada e não escreve no disco", () => {
    const incoming = pkgOf([{ tool: "claude", path: "{project:github.com/o/r}/memory/x.md", content: "mem" }]);
    const plan = planWorkHomeApply({
      incoming,
      base: null,
      toolRoots: { claude: claudeRoot },
      homeDir,
      projectClones: [],
      shaOf: sha256FileSync,
    });
    const result = apply({ plan, blobs: incoming.blobs });
    expect(result.pending.map((p) => p.path)).toEqual(["{project:github.com/o/r}/memory/x.md"]);
    expect(result.written).toEqual([]);
    expect(existsSync(join(claudeRoot, "projects"))).toBe(false);
  });
});

describe("suffixedPath", () => {
  it("insere o sufixo antes da extensão", () => {
    expect(suffixedPath("/a/foo.md", "123")).toBe("/a/foo.remote-123.md");
    expect(suffixedPath("/a/foo", "123")).toBe("/a/foo.remote-123");
  });
});
