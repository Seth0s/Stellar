import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorktreePath,
  decideSpawnIsolation,
  parseWorktreeConfig,
  sanitizeRepoName,
  WORKTREE_PATH_MAX_BYTES,
} from "../../src/main/worktree-isolation-decision";
import { prepareIsolatedWorktree, removeIsolatedWorktree } from "../../src/main/worktree-prep";

// Feature descoberta por tentativa e erro (2026-09-19): uma worktree do
// backend precisa de `.env`, `vendor/` COPIADO, `storage/jwt`, etc. — tudo
// escondido pelo `.gitignore` — e o caminho precisa ser CURTO (socket Unix,
// 108 bytes, docs/ORCHESTRATION.md §15). A decisão é pura e testada aqui; o
// preparo roda contra um repo git REAL temporário.

describe("decideSpawnIsolation", () => {
  it("ausente/vazio = árvore compartilhada, sem erro", () => {
    expect(decideSpawnIsolation(undefined)).toEqual({ ok: true, isolation: null });
    expect(decideSpawnIsolation(null)).toEqual({ ok: true, isolation: null });
    expect(decideSpawnIsolation("")).toEqual({ ok: true, isolation: null });
  });

  it('"worktree" é aceito', () => {
    expect(decideSpawnIsolation("worktree")).toEqual({ ok: true, isolation: "worktree" });
  });

  it("valor desconhecido é RECUSADO nomeando o valor — nunca remapeia em silêncio", () => {
    const d = decideSpawnIsolation("shallow");
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/"shallow"/);
    expect(!d.ok && d.error).toMatch(/worktree/);
  });
});

describe("parseWorktreeConfig", () => {
  it("ausente/vazio = copia nada (ausência é dado)", () => {
    expect(parseWorktreeConfig(null)).toEqual({ ok: true, config: { copy: [] } });
    expect(parseWorktreeConfig("   ")).toEqual({ ok: true, config: { copy: [] } });
  });

  it("lê a lista declarada e normaliza/deduplica", () => {
    const parsed = parseWorktreeConfig(
      JSON.stringify({ copy: ["vendor", "./storage/jwt", ".env", "vendor", "a//b"] }),
    );
    expect(parsed).toEqual({
      ok: true,
      config: { copy: ["vendor", "storage/jwt", ".env", "a/b"] },
    });
  });

  it("objeto sem `copy` = copia nada", () => {
    expect(parseWorktreeConfig("{}")).toEqual({ ok: true, config: { copy: [] } });
  });

  it("lê `worktreeRoot` absoluto e recusa não-absoluto/vazio", () => {
    expect(
      parseWorktreeConfig(JSON.stringify({ copy: ["vendor"], worktreeRoot: "/short/root" })),
    ).toEqual({
      ok: true,
      config: { copy: ["vendor"], worktreeRoot: "/short/root" },
    });
    expect(parseWorktreeConfig(JSON.stringify({ worktreeRoot: "relative/root" })).ok).toBe(false);
    expect(parseWorktreeConfig(JSON.stringify({ worktreeRoot: "" })).ok).toBe(false);
  });

  it("JSON quebrado é recusado", () => {
    const d = parseWorktreeConfig("{not json");
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/not valid JSON/);
  });

  it("não-objeto é recusado", () => {
    expect(parseWorktreeConfig("[]").ok).toBe(false);
    expect(parseWorktreeConfig('"x"').ok).toBe(false);
  });

  it("`copy` não-array ou entrada não-string é recusado", () => {
    expect(parseWorktreeConfig(JSON.stringify({ copy: "vendor" })).ok).toBe(false);
    expect(parseWorktreeConfig(JSON.stringify({ copy: ["ok", 3] })).ok).toBe(false);
  });

  it("caminho absoluto é recusado", () => {
    const d = parseWorktreeConfig(JSON.stringify({ copy: ["/etc/passwd"] }));
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/relative/);
  });

  it("caminho que escapa a raiz (`..`) é recusado", () => {
    const d = parseWorktreeConfig(JSON.stringify({ copy: ["../secrets"] }));
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/escapes/);
  });
});

describe("buildWorktreePath", () => {
  it("monta sob a raiz curta com nome sanitizado e teto de bytes", () => {
    const built = buildWorktreePath({
      root: "/tmp/stellar-wt",
      repoName: "IdyPlatform",
      uniqueId: "a1b2c3d4",
    });
    expect(built).toEqual({ ok: true, path: "/tmp/stellar-wt/IdyPlatform-a1b2c3d4" });
    expect(Buffer.byteLength(built.ok ? built.path : "", "utf8")).toBeLessThan(
      WORKTREE_PATH_MAX_BYTES,
    );
  });

  it("raiz longa demais é RECUSADA (o socket Unix não cabe)", () => {
    const built = buildWorktreePath({
      root: "/" + "x".repeat(120),
      repoName: "IdyPlatform",
      uniqueId: "a1b2c3d4",
    });
    expect(built.ok).toBe(false);
    expect(!built.ok && built.error).toMatch(/108 bytes/);
  });

  it("sanitiza o nome do repo (nunca vazio, nunca com separador)", () => {
    expect(sanitizeRepoName("Project Conecta")).toBe("Project-Conecta");
    expect(sanitizeRepoName("../../etc")).toBe("etc");
    expect(sanitizeRepoName("")).toBe("repo");
  });
});

// --- preparo real ---------------------------------------------------------

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

describe.skipIf(!GIT_AVAILABLE)("prepareIsolatedWorktree — repo git real", () => {
  const cleanups: string[] = [];

  function makeRepo(files: {
    tracked: Record<string, string>;
    ignored: Record<string, string>;
    config?: unknown;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), "stellar-wt-src-"));
    cleanups.push(dir);
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    writeFileSync(join(dir, ".gitignore"), ".env\nvendor/\nstorage/jwt\n");
    for (const [rel, body] of Object.entries(files.tracked)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
      execFileSync("git", ["-C", dir, "add", rel]);
    }
    writeFileSync(join(dir, ".gitignore"), ".env\nvendor/\nstorage/jwt\n");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
    for (const [rel, body] of Object.entries(files.ignored)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    if (files.config !== undefined) {
      mkdirSync(join(dir, ".stellar"), { recursive: true });
      writeFileSync(join(dir, ".stellar", "worktree.json"), JSON.stringify(files.config));
    }
    return dir;
  }

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "stellar-wt-root-"));
    cleanups.push(dir);
    return dir;
  }

  afterEach(() => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it("cria a worktree, traz o rastreado e COPIA o declarado (vendor sem symlink)", async () => {
    const src = makeRepo({
      tracked: { "app.txt": "hello\n" },
      ignored: {
        ".env": "APP_KEY=x\n",
        "vendor/autoload.php": "<?php\n",
        "storage/jwt/key.pem": "K\n",
      },
      config: { copy: [".env", "vendor", "storage/jwt"] },
    });
    const root = makeRoot();
    const prep = await prepareIsolatedWorktree({ sourceCwd: src, root });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    // Separada da árvore de origem, mas com o que o git rastreia.
    expect(prep.path).not.toBe(src);
    expect(prep.path.startsWith(root)).toBe(true);
    expect(readFileSync(join(prep.path, "app.txt"), "utf8")).toBe("hello\n");
    // O que o .gitignore esconde veio por cópia — conteúdo REAL, não symlink.
    expect(readFileSync(join(prep.path, ".env"), "utf8")).toBe("APP_KEY=x\n");
    expect(readFileSync(join(prep.path, "vendor", "autoload.php"), "utf8")).toBe("<?php\n");
    expect(readFileSync(join(prep.path, "storage", "jwt", "key.pem"), "utf8")).toBe("K\n");
    expect(prep.copied.sort()).toEqual([".env", "storage/jwt", "vendor"]);
    expect(prep.missing).toEqual([]);

    await removeIsolatedWorktree({ sourceRoot: prep.sourceRoot, path: prep.path });
    expect(existsSync(prep.path)).toBe(false);
  });

  it("`worktreeRoot` declarado pelo projeto é usado como raiz", async () => {
    const declaredRoot = mkdtempSync(join(tmpdir(), "stellar-wt-declared-"));
    cleanups.push(declaredRoot);
    const src = makeRepo({
      tracked: { "app.txt": "hi\n" },
      ignored: {},
      config: { copy: [], worktreeRoot: declaredRoot },
    });
    const prep = await prepareIsolatedWorktree({ sourceCwd: src });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.path.startsWith(declaredRoot)).toBe(true);
    await removeIsolatedWorktree({ sourceRoot: prep.sourceRoot, path: prep.path });
  });

  it("sem declaração = worktree crua, sem cópias", async () => {
    const src = makeRepo({ tracked: { "app.txt": "hi\n" }, ignored: { ".env": "A=1\n" } });
    const root = makeRoot();
    const prep = await prepareIsolatedWorktree({ sourceCwd: src, root });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.copied).toEqual([]);
    expect(existsSync(join(prep.path, ".env"))).toBe(false);
    await removeIsolatedWorktree({ sourceRoot: prep.sourceRoot, path: prep.path });
  });

  it("declarado e ausente é registrado em `missing`, sem falhar", async () => {
    const src = makeRepo({
      tracked: { "app.txt": "hi\n" },
      ignored: {},
      config: { copy: [".env", "vendor"] },
    });
    const root = makeRoot();
    const prep = await prepareIsolatedWorktree({ sourceCwd: src, root });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.missing.sort()).toEqual([".env", "vendor"]);
    expect(prep.copied).toEqual([]);
    await removeIsolatedWorktree({ sourceRoot: prep.sourceRoot, path: prep.path });
  });

  it("declaração malformada RECUSA antes de criar worktree nenhuma", async () => {
    const src = makeRepo({ tracked: { "app.txt": "hi\n" }, ignored: {} });
    mkdirSync(join(src, ".stellar"), { recursive: true });
    writeFileSync(join(src, ".stellar", "worktree.json"), "{broken");
    const root = makeRoot();
    const prep = await prepareIsolatedWorktree({ sourceCwd: src, root });
    expect(prep.ok).toBe(false);
    expect(!prep.ok && prep.error).toMatch(/not valid JSON/);
  });

  it("cwd que não é repo git é recusado com o motivo", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "stellar-wt-plain-"));
    cleanups.push(notRepo);
    const prep = await prepareIsolatedWorktree({ sourceCwd: notRepo, root: makeRoot() });
    expect(prep.ok).toBe(false);
    expect(!prep.ok && prep.error).toMatch(/git repository/);
  });

  it("cwd vazio é recusado", async () => {
    const prep = await prepareIsolatedWorktree({ sourceCwd: "  " });
    expect(prep.ok).toBe(false);
    expect(!prep.ok && prep.error).toMatch(/source checkout/);
  });
});
