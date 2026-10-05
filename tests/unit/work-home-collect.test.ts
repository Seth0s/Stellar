/**
 * work-home-collect.ts — coletor (A3a, §5.1/§5.2). Só diretórios temporários
 * e arquivos FALSOS; nunca a home real.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWorkHome, extractClaudeIncludes, mergeWorkHomePackages } from "../../src/main/work-home-collect";
import type { ProjectClone } from "../../src/main/work-home-remap";
import type { WorkHomePackage } from "../../src/main/work-home-manifest";

let base: string;
let home: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stellar-work-home-collect-"));
  home = join(base, "home");
  root = join(base, ".claude");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function writeHome(rel: string, content: string): string {
  const abs = join(home, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function paths(pkg: WorkHomePackage): string[] {
  return pkg.manifest.entries.map((e) => e.path).sort();
}

function blobText(pkg: WorkHomePackage, path: string): string {
  const entry = pkg.manifest.entries.find((e) => e.path === path);
  if (!entry) throw new Error(`sem entrada ${path}`);
  const bytes = pkg.blobs.get(entry.sha256);
  if (!bytes) throw new Error(`sem blob ${path}`);
  return Buffer.from(bytes).toString("utf-8");
}

describe("extractClaudeIncludes", () => {
  it("lê @caminho em linha e inline, sem duplicar", () => {
    expect(extractClaudeIncludes("veja @a/b.md e @~/c.md\n@a/b.md @x")).toEqual(["a/b.md", "~/c.md", "x"]);
  });
});

describe("collectWorkHome — claude (allowlist + filtro + includes + projeto)", () => {
  const clone: ProjectClone = {
    root: "/home/u/proj",
    remote: "git@github.com:o/r.git",
    normalizedRemote: "github.com/o/r",
  };

  function collect() {
    return collectWorkHome({ tool: "claude", rootDir: root, homeDir: home, projectClones: [clone] });
  }

  it("coleta as raízes declaradas e remapeia os marcadores", () => {
    write("CLAUDE.md", "regras\n@extra/notes.md\n@~/shared/policy.md\n");
    write("extra/notes.md", "nota incluída");
    writeHome("shared/policy.md", "política da home");
    write("skills/a/SKILL.md", "skill");
    write("agents/rev.md", "agente");
    write("commands/c.md", "comando");
    write("projects/-home-u-proj/memory/notes.md", "memória");
    write("projects/-home-u-proj/session.jsonl", '{"sessao":true}');
    write("projects/-home-u-proj/memory/outra.jsonl", '{"x":1}');
    write("settings.json", JSON.stringify({ model: "opus", env: { TOKEN: "FAKE_SECRET" }, permissions: {} }));

    const { package: pkg } = collect();
    expect(paths(pkg)).toEqual([
      "{claude}/CLAUDE.md",
      "{claude}/agents/rev.md",
      "{claude}/commands/c.md",
      "{claude}/extra/notes.md",
      "{claude}/settings.json",
      "{claude}/skills/a/SKILL.md",
      "{home}/shared/policy.md",
      "{project:github.com/o/r}/memory/notes.md",
    ]);
    expect(pkg.manifest.entries.every((e) => e.size === pkg.blobs.get(e.sha256)!.byteLength)).toBe(true);
  });

  it("NUNCA deixa entrar credencial/sessão/histórico — nem sob uma árvore permitida", () => {
    write(".credentials.json", '{"claudeAiOauth":{"token":"FAKE_SECRET"}}');
    write("history.jsonl", '{"linha":"FAKE_SECRET"}');
    write("skills/creds/.credentials.json", '{"claudeAiOauth":{"token":"FAKE_SECRET"}}');
    write("skills/a/SKILL.md", "ok");

    const { package: pkg } = collect();
    expect(paths(pkg)).toEqual(["{claude}/skills/a/SKILL.md"]);
    for (const bytes of pkg.blobs.values()) {
      expect(Buffer.from(bytes).toString("utf-8")).not.toContain("FAKE_SECRET");
    }
  });

  it("filtra settings.json: chave fora da tabela não sai", () => {
    write("settings.json", JSON.stringify({ model: "opus", env: { TOKEN: "FAKE_SECRET" }, statusLine: { type: "x" } }));
    const { package: pkg } = collect();
    const text = blobText(pkg, "{claude}/settings.json");
    expect(JSON.parse(text)).toEqual({ model: "opus", statusLine: { type: "x" } });
    expect(text).not.toContain("FAKE_SECRET");
  });

  it("settings que não é objeto não vira 'inclui tudo'", () => {
    write("settings.json", "não é json");
    const { package: pkg, warnings } = collect();
    expect(paths(pkg)).toEqual([]);
    expect(warnings.some((w) => w.includes("settings.json"))).toBe(true);
  });

  it("include que aponta fora da home/raiz não entra (aviso)", () => {
    write("CLAUDE.md", "@~/../etc/x.md\n");
    const { package: pkg, warnings } = collect();
    expect(paths(pkg)).toEqual(["{claude}/CLAUDE.md"]);
    expect(warnings.some((w) => w.includes("não é portável"))).toBe(true);
  });

  it("sem clone, memória de projeto fica de fora com aviso (nunca id inventado)", () => {
    write("projects/-home-u-proj/memory/notes.md", "memória");
    const { package: pkg, warnings } = collectWorkHome({ tool: "claude", rootDir: root, homeDir: home, projectClones: [] });
    expect(paths(pkg)).toEqual([]);
    expect(warnings.some((w) => w.includes("nenhum clone"))).toBe(true);
  });

  it("não segue symlink", () => {
    write("skills/ok.md", "ok");
    const secret = join(base, "fora.md");
    writeFileSync(secret, "FAKE_SECRET");
    symlinkSync(secret, join(root, "skills", "link.md"));

    const { package: pkg } = collect();
    expect(paths(pkg)).toEqual(["{claude}/skills/ok.md"]);
    expect(pkg.blobs.size).toBe(1);
  });

  it("arquivo acima do limite fica de fora e avisa", () => {
    write("skills/grande.md", "x".repeat(50));
    const { package: pkg, warnings } = collectWorkHome({
      tool: "claude",
      rootDir: root,
      homeDir: home,
      projectClones: [],
      maxFileSize: 10,
    });
    expect(paths(pkg)).toEqual([]);
    expect(warnings.some((w) => w.includes("limite"))).toBe(true);
  });
});

describe("collectWorkHome — codex", () => {
  it("coleta AGENTS.md, skills e filtra config.toml", () => {
    const codexRoot = join(base, ".codex");
    mkdirSync(join(codexRoot, "skills", "s"), { recursive: true });
    writeFileSync(join(codexRoot, "AGENTS.md"), "regras");
    writeFileSync(join(codexRoot, "skills", "s", "SKILL.md"), "skill");
    writeFileSync(join(codexRoot, "config.toml"), 'model = "gpt-5"\n[auth]\ntoken = "FAKE_SECRET"\n');
    writeFileSync(join(codexRoot, "auth.json"), '{"token":"FAKE_SECRET"}');

    const { package: pkg } = collectWorkHome({ tool: "codex", rootDir: codexRoot, homeDir: home });
    expect(pkg.manifest.entries.map((e) => e.path).sort()).toEqual([
      "{codex}/AGENTS.md",
      "{codex}/config.toml",
      "{codex}/skills/s/SKILL.md",
    ]);
    const config = blobText(pkg, "{codex}/config.toml");
    expect(config).toContain('model = "gpt-5"');
    expect(config).not.toContain("FAKE_SECRET");
    for (const bytes of pkg.blobs.values()) {
      expect(Buffer.from(bytes).toString("utf-8")).not.toContain("FAKE_SECRET");
    }
  });

  it("reescreve caminho absoluto DENTRO do config.toml (adendo A3b)", () => {
    const codexRoot = join(base, ".codex");
    const projRoot = join(base, "mono");
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(join(projRoot, ".git"), { recursive: true });
    writeFileSync(join(projRoot, ".git", "config"), `[remote "origin"]\n\turl = git@github.com:o/mono.git\n`);
    writeFileSync(join(codexRoot, "config.toml"), `model = "gpt-5"\n[projects."${projRoot}"]\ntrust = true\n`);

    const clone = { root: projRoot, remote: "git@github.com:o/mono.git", normalizedRemote: "github.com/o/mono" };
    const { package: pkg } = collectWorkHome({
      tool: "codex",
      rootDir: codexRoot,
      homeDir: home,
      projectClones: [clone],
    });
    const config = blobText(pkg, "{codex}/config.toml");
    expect(config).toContain('[projects."{project:github.com/o/mono}"]');
    expect(config).not.toContain(projRoot);
  });
});

describe("collectWorkHome — stellar (bundle existente)", () => {
  it("usa o PortableProviderBundle e templatiza a home; credencial só o nome", () => {
    const { package: pkg } = collectWorkHome({
      tool: "stellar",
      rootDir: join(base, "unused"),
      homeDir: home,
      stellar: {
        config: { schemaVersion: 1, providers: [{ id: "p", cwd: join(home, "x") }] },
        credentialNames: ["anthropic", "anthropic"],
      },
    });
    expect(paths(pkg)).toEqual(["{stellar}/provider-bundle.json"]);
    const bundle = JSON.parse(blobText(pkg, "{stellar}/provider-bundle.json"));
    expect(bundle.kind).toBe("stellar-provider-config");
    expect(bundle.providers[0].cwd).toBe("{home}/x");
    // §5: segredo não é assunto do sync — nem os NOMES de credencial saem.
    expect(bundle.credentialsRequired).toBeUndefined();
    expect(blobText(pkg, "{stellar}/provider-bundle.json")).not.toContain("credentialsRequired");
    expect(blobText(pkg, "{stellar}/provider-bundle.json")).not.toContain("sk-");
  });
});

describe("mergeWorkHomePackages", () => {
  it("junta manifestos e compartilha blob de mesmo sha", () => {
    const a = collectWorkHome({ tool: "claude", rootDir: root, homeDir: home });
    write("skills/x.md", "mesmo");
    const b = collectWorkHome({ tool: "claude", rootDir: root, homeDir: home });
    const merged = mergeWorkHomePackages([a.package, b.package]);
    expect(merged.manifest.entries).toHaveLength(1);
    expect(merged.blobs.size).toBe(1);
  });
});
