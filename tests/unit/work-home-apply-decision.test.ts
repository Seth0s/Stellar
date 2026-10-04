/**
 * work-home-apply-decision.ts — prévia e conflito (A3a, §5.3/§5.4). Puro.
 */
import { describe, expect, it } from "vitest";
import {
  decideWorkHomeFileAction,
  decideWorkHomeRemoval,
  planWorkHomeApply,
  resolveWorkHomeConflict,
  resolveWorkHomeTarget,
  unresolvedConflicts,
} from "../../src/main/work-home-apply-decision";
import {
  buildManifest,
  sha256Hex,
  type WorkHomeManifestEntry,
  type WorkHomePackage,
} from "../../src/main/work-home-manifest";
import type { ProjectClone } from "../../src/main/work-home-remap";

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

const S = (text: string) => sha256Hex(Buffer.from(text));

describe("decideWorkHomeFileAction — tabela de conflito por arquivo (§5.4)", () => {
  it("nunca sincronizado: ausente → add; igual → unchanged; diferente → conflict", () => {
    expect(decideWorkHomeFileAction({ baseSha: null, localSha: null, remoteSha: "r" })).toBe("add");
    expect(decideWorkHomeFileAction({ baseSha: null, localSha: "r", remoteSha: "r" })).toBe("unchanged");
    expect(decideWorkHomeFileAction({ baseSha: null, localSha: "l", remoteSha: "r" })).toBe("conflict");
  });

  it("com base: só o remoto mudou → update", () => {
    expect(decideWorkHomeFileAction({ baseSha: "b", localSha: "b", remoteSha: "r" })).toBe("update");
  });

  it("com base: só o local mudou → keep-local", () => {
    expect(decideWorkHomeFileAction({ baseSha: "b", localSha: "l", remoteSha: "b" })).toBe("keep-local");
  });

  it("com base: os dois mudaram → conflict; apagado local + mudado remoto → conflict", () => {
    expect(decideWorkHomeFileAction({ baseSha: "b", localSha: "l", remoteSha: "r" })).toBe("conflict");
    expect(decideWorkHomeFileAction({ baseSha: "b", localSha: null, remoteSha: "r" })).toBe("conflict");
  });

  it("igual ao remoto sempre é unchanged (mesmo com base diferente)", () => {
    expect(decideWorkHomeFileAction({ baseSha: "b", localSha: "r", remoteSha: "r" })).toBe("unchanged");
  });
});

describe("decideWorkHomeRemoval — sem base, não apaga", () => {
  it("ausente → noop; igual à base → remove; mudado → conflict; sem base → keep-local", () => {
    expect(decideWorkHomeRemoval({ baseSha: "b", localSha: null })).toBe("noop");
    expect(decideWorkHomeRemoval({ baseSha: "b", localSha: "b" })).toBe("remove");
    expect(decideWorkHomeRemoval({ baseSha: "b", localSha: "l" })).toBe("conflict");
    expect(decideWorkHomeRemoval({ baseSha: null, localSha: "l" })).toBe("keep-local");
  });
});

describe("resolveWorkHomeConflict", () => {
  it("local / remote / both com sufixo", () => {
    expect(resolveWorkHomeConflict("local", { suffix: "1" })).toEqual({ action: "keep-local" });
    expect(resolveWorkHomeConflict("remote", { suffix: "1" })).toEqual({ action: "write-remote" });
    expect(resolveWorkHomeConflict("both", { suffix: "1" })).toEqual({ action: "write-remote-suffixed", suffix: "1" });
  });
});

describe("resolveWorkHomeTarget", () => {
  const ctx = {
    toolRoots: { claude: "/R/.claude" as string },
    homeDir: "/R/home",
    projectClones: [] as ProjectClone[],
  };

  it("marcador de ferramenta, home, projeto resolvido e pendências", () => {
    expect(resolveWorkHomeTarget("{claude}/skills/a", ctx)).toEqual({ kind: "resolved", absPath: "/R/.claude/skills/a" });
    expect(resolveWorkHomeTarget("{home}/docs/x.md", ctx)).toEqual({ kind: "resolved", absPath: "/R/home/docs/x.md" });
    expect(resolveWorkHomeTarget("{project:github.com/o/r}/memory/x.md", ctx)).toEqual({
      kind: "pending",
      reason: "unresolved-project",
    });
    expect(resolveWorkHomeTarget("/etc/x", ctx)).toEqual({ kind: "pending", reason: "non-portable" });
    expect(resolveWorkHomeTarget("{codex}/AGENTS.md", ctx)).toEqual({ kind: "pending", reason: "unknown-tool-root" });
  });

  it("projeto resolvido volta para o diretório de projetos do Claude", () => {
    const clone: ProjectClone = {
      root: "/home/u/mono",
      remote: "git@github.com:o/mono.git",
      normalizedRemote: "github.com/o/mono",
    };
    expect(
      resolveWorkHomeTarget("{project:github.com/o/mono}/memory/x.md", { ...ctx, projectClones: [clone] }),
    ).toEqual({ kind: "resolved", absPath: "/R/.claude/projects/-home-u-mono/memory/x.md" });
  });
});

describe("planWorkHomeApply", () => {
  const incoming = pkgOf([
    { tool: "claude", path: "{claude}/new.md", content: "new" },
    { tool: "claude", path: "{claude}/upd.md", content: "novo-remoto" },
    { tool: "claude", path: "{claude}/local.md", content: "base" },
    { tool: "claude", path: "{claude}/conf.md", content: "remoto" },
    { tool: "claude", path: "{project:github.com/o/r}/memory/x.md", content: "mem" },
  ]);
  incoming.manifest.removals = ["{claude}/gone.md"];
  const base = buildManifest([
    { tool: "claude", path: "{claude}/upd.md", sha256: S("antigo"), size: 6, mode: 0o644 },
    { tool: "claude", path: "{claude}/local.md", sha256: S("base"), size: 4, mode: 0o644 },
    { tool: "claude", path: "{claude}/conf.md", sha256: S("base"), size: 4, mode: 0o644 },
    { tool: "claude", path: "{claude}/gone.md", sha256: S("z"), size: 1, mode: 0o644 },
  ]);

  const localShas: Record<string, string> = {
    "/R/.claude/upd.md": S("antigo"),
    "/R/.claude/local.md": S("mudei-local"),
    "/R/.claude/conf.md": S("mudou-local"),
    "/R/.claude/gone.md": S("z"),
  };

  const plan = planWorkHomeApply({
    incoming,
    base,
    toolRoots: { claude: "/R/.claude" },
    homeDir: "/R/home",
    projectClones: [],
    shaOf: (p) => localShas[p] ?? null,
  });

  it("classifica cada arquivo e resume", () => {
    const byPath = Object.fromEntries(plan.items.map((i) => [i.path, i.action]));
    expect(byPath).toEqual({
      "{claude}/new.md": "add",
      "{claude}/upd.md": "update",
      "{claude}/local.md": "keep-local",
      "{claude}/conf.md": "conflict",
      "{project:github.com/o/r}/memory/x.md": "pending",
      "{claude}/gone.md": "remove",
    });
    expect(plan.summary).toEqual({ add: 1, update: 1, unchanged: 0, keepLocal: 1, conflict: 1, pending: 1, remove: 1 });
  });

  it("conflitos sem escolha aparecem como pendentes de decisão", () => {
    expect(unresolvedConflicts(plan, {}).map((i) => i.path)).toEqual(["{claude}/conf.md"]);
    expect(unresolvedConflicts(plan, { "{claude}/conf.md": "remote" })).toEqual([]);
  });

  it("arquivo ausente do pacote não vira remoção implícita", () => {
    // `{claude}/local.md` existe na base e no pacote; nenhum item de remoção
    // para ele, e nenhum arquivo local é apagado por estar ausente.
    expect(plan.items.some((i) => i.action === "remove" && i.path !== "{claude}/gone.md")).toBe(false);
  });
});
