/**
 * work-home-remap.ts — remapeamento, remote git e projeto (A3a, §5.2). I/O só
 * na descoberta de clones, com diretórios temporários.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverProjectClones,
  encodeClaudeProjectDir,
  formatProjectId,
  matchClaudeProjectDir,
  normalizeRemote,
  parseGitConfigRemote,
  parseProjectId,
  projectLogicalPath,
  relWithin,
  remapPathToLogical,
  resolveProjectLocalDir,
  toPosix,
  type ProjectClone,
} from "../../src/main/work-home-remap";

describe("encodeClaudeProjectDir", () => {
  it("troca cada separador por '-'", () => {
    expect(encodeClaudeProjectDir("/home/u/x")).toBe("-home-u-x");
    expect(encodeClaudeProjectDir("/home/u/x/")).toBe("-home-u-x");
  });
});

describe("normalizeRemote", () => {
  it("aceita https, ssh, git:// e a forma scp", () => {
    expect(normalizeRemote("https://github.com/Seth0s/Stellar.git")).toBe("github.com/seth0s/stellar");
    expect(normalizeRemote("git@github.com:Seth0s/Stellar.git")).toBe("github.com/seth0s/stellar");
    expect(normalizeRemote("ssh://git@github.com:22/Seth0s/Stellar")).toBe("github.com/seth0s/stellar");
    expect(normalizeRemote("git://GitLab.com/group/proj.git")).toBe("gitlab.com/group/proj");
  });

  it("remote local (sem host) ou vazio → null", () => {
    expect(normalizeRemote("/home/u/repo")).toBeNull();
    expect(normalizeRemote("../other")).toBeNull();
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("   ")).toBeNull();
  });
});

describe("formatProjectId / parseProjectId", () => {
  it("round-trip com e sem subpasta", () => {
    expect(formatProjectId("github.com/o/r", "")).toBe("github.com/o/r");
    expect(formatProjectId("github.com/o/r", "packages/app")).toBe("github.com/o/r/packages/app");
    expect(parseProjectId("github.com/o/r")).toEqual({ remote: "github.com/o/r", subpath: "" });
    expect(parseProjectId("github.com/o/r/packages/app")).toEqual({
      remote: "github.com/o/r",
      subpath: "packages/app",
    });
  });

  it("menos de 3 segmentos não é id de projeto", () => {
    expect(parseProjectId("github.com/o")).toBeNull();
    expect(parseProjectId("")).toBeNull();
  });
});

describe("parseGitConfigRemote", () => {
  it("prefere origin", () => {
    const content = ['[remote "upstream"]', "\turl = https://gitlab.com/x/y.git", '[remote "origin"]', "\turl = git@github.com:o/r.git"].join("\n");
    expect(parseGitConfigRemote(content)).toBe("git@github.com:o/r.git");
  });

  it("sem origin, usa o primeiro remote declarado", () => {
    const content = ['[remote "up"]', "\turl = https://gitlab.com/x/y.git"].join("\n");
    expect(parseGitConfigRemote(content)).toBe("https://gitlab.com/x/y.git");
  });

  it("sem remote → null", () => {
    expect(parseGitConfigRemote('[core]\n\trepositoryformatversion = 0\n')).toBeNull();
  });
});

describe("relWithin / toPosix", () => {
  it("diz se está dentro e devolve relativo posix", () => {
    expect(relWithin("/a/b", "/a/b/c/d")).toBe("c/d");
    expect(relWithin("/a/b", "/a/b")).toBe("");
    expect(relWithin("/a/b", "/a/c")).toBeNull();
    expect(relWithin("/a/b", "/other")).toBeNull();
  });
  it("toPosix normaliza barra final", () => {
    expect(toPosix("/a/b/")).toBe("/a/b");
  });
});

describe("remapPathToLogical", () => {
  const ctx = { homeDir: "/home/u", toolRoots: { claude: "/home/u/.claude", codex: "/home/u/.codex" as string } };

  it("raiz de ferramenta → {tool}/rel", () => {
    expect(remapPathToLogical("/home/u/.claude/skills/a/SKILL.md", ctx)).toEqual({
      kind: "tool",
      tool: "claude",
      relPath: "skills/a/SKILL.md",
      logical: "{claude}/skills/a/SKILL.md",
    });
  });

  it("sob a home (fora de tool) → {home}/rel", () => {
    expect(remapPathToLogical("/home/u/docs/policy.md", ctx)).toEqual({
      kind: "home",
      relPath: "docs/policy.md",
      logical: "{home}/docs/policy.md",
    });
  });

  it("fora da home → absoluto (não portável)", () => {
    expect(remapPathToLogical("/etc/x", ctx)).toEqual({ kind: "absolute", logical: "/etc/x" });
  });

  it("a raiz mais longa vence", () => {
    const nested = { homeDir: "/home/u", toolRoots: { claude: "/home/u/.claude" as string } };
    expect(remapPathToLogical("/home/u/.claude/x", nested).kind).toBe("tool");
  });
});

describe("matchClaudeProjectDir", () => {
  const clone = (root: string, remote: string): ProjectClone => ({
    root,
    remote,
    normalizedRemote: normalizeRemote(remote),
  });

  it("casa o clone exato e devolve o id do remote", () => {
    const got = matchClaudeProjectDir("-home-u-proj", [clone("/home/u/proj", "git@github.com:o/r.git")]);
    expect(got).toEqual({ projectId: "github.com/o/r", cloneRoot: "/home/u/proj", subpath: "" });
  });

  it("decodifica a subpasta (melhor-esforço) e usa o clone MAIS LONGO", () => {
    const clones = [
      clone("/home/u/mono", "https://github.com/o/mono.git"),
      clone("/home/u/mono/packages/app", "https://github.com/o/mono.git"),
    ];
    const got = matchClaudeProjectDir("-home-u-mono-packages-app", clones);
    expect(got?.projectId).toBe("github.com/o/mono");
    expect(got?.cloneRoot).toBe("/home/u/mono/packages/app");
    expect(got?.subpath).toBe("");
  });

  it("sem casamento ou remote não portável → null", () => {
    expect(matchClaudeProjectDir("-home-u/outro", [clone("/home/u/proj", "git@github.com:o/r.git")])).toBeNull();
    expect(matchClaudeProjectDir("-home-u-proj", [clone("/home/u/proj", "/local/repo")])).toBeNull();
  });
});

describe("resolveProjectLocalDir / projectLogicalPath", () => {
  const clones = [
    { root: "/home/u/mono", remote: "https://github.com/o/mono.git", normalizedRemote: "github.com/o/mono" },
  ];
  it("acha o clone pelo remote e anexa a subpasta", () => {
    expect(resolveProjectLocalDir("github.com/o/mono", clones)).toBe("/home/u/mono");
    expect(resolveProjectLocalDir("github.com/o/mono/packages/app", clones)).toBe(
      join("/home/u/mono", "packages", "app"),
    );
    expect(resolveProjectLocalDir("github.com/o/outro", clones)).toBeNull();
  });
  it("monta o caminho lógico de projeto", () => {
    expect(projectLogicalPath("github.com/o/r", "memory/x.md")).toBe("{project:github.com/o/r}/memory/x.md");
    expect(projectLogicalPath("github.com/o/r", "")).toBe("{project:github.com/o/r}");
  });
});

describe("discoverProjectClones (I/O em tmp)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "stellar-work-home-clones-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function makeClone(rel: string, remote: string): void {
    const root = join(base, rel);
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  }

  it("encontra clones aninhados e ignora remote local", () => {
    makeClone("a/proj", "git@github.com:o/r.git");
    makeClone("b/other", "/local/path");
    const found = discoverProjectClones([base]);
    expect(found).toHaveLength(1);
    expect(found[0].normalizedRemote).toBe("github.com/o/r");
  });

  it("não desce dentro de um clone já achado", () => {
    makeClone("a/proj", "git@github.com:o/r.git");
    makeClone("a/proj/vendor/lib", "git@github.com:o/lib.git");
    const found = discoverProjectClones([base]);
    expect(found.map((c) => c.normalizedRemote)).toEqual(["github.com/o/r"]);
  });
});
