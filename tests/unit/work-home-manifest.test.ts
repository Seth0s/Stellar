/**
 * work-home-manifest.ts — manifesto/pacote (A3a, §5.2). Puro.
 */
import { describe, expect, it } from "vitest";
import {
  HOME_MARKER,
  buildManifest,
  isWorkHomeTool,
  manifestByPath,
  markerTool,
  packageByteSize,
  parseManifest,
  projectIdOf,
  relPathOf,
  serializeManifest,
  sha256Hex,
  toolMarker,
  type WorkHomeManifestEntry,
  type WorkHomePackage,
} from "../../src/main/work-home-manifest";

const entry = (path: string, sha = "a".repeat(64)): WorkHomeManifestEntry => ({
  tool: "claude",
  path,
  sha256: sha,
  size: 1,
  mode: 0o644,
});

describe("sha256Hex", () => {
  it("bate com o vetor conhecido de 'abc'", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("buildManifest", () => {
  it("ordena por (tool, path) e remove duplicata de path", () => {
    const manifest = buildManifest([
      entry("{claude}/b.md"),
      { ...entry("{codex}/a.md"), tool: "codex" },
      entry("{claude}/a.md", "b".repeat(64)),
      entry("{claude}/a.md", "c".repeat(64)),
    ]);
    expect(manifest.entries.map((e) => `${e.tool}:${e.path}`)).toEqual([
      "claude:{claude}/a.md",
      "claude:{claude}/b.md",
      "codex:{codex}/a.md",
    ]);
    // A última entrada do mesmo path vence.
    expect(manifest.entries[0].sha256).toBe("c".repeat(64));
  });

  it("remove remoções duplicadas e ordena", () => {
    expect(buildManifest([], ["b", "a", "b"]).removals).toEqual(["a", "b"]);
  });
});

describe("parseManifest", () => {
  it("faz round-trip do serializado", () => {
    const manifest = buildManifest([entry("{claude}/a.md")], ["{claude}/z.md"]);
    expect(parseManifest(JSON.parse(serializeManifest(manifest)))).toEqual(manifest);
  });

  it("recusa versão desconhecida e não-objeto", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest([])).toBeNull();
    expect(parseManifest({ version: 999, entries: [] })).toBeNull();
  });

  it("descarta entradas inválidas, mantém as boas (nunca conserta)", () => {
    const parsed = parseManifest({
      version: 1,
      entries: [
        { tool: "chute", path: "x", sha256: "a".repeat(64), size: 1, mode: 0o644 },
        { tool: "claude", path: "{claude}/ok.md", sha256: "a".repeat(64), size: 1, mode: 0o644 },
        { tool: "claude", path: "{claude}/sha-ruim.md", sha256: "xyz", size: 1, mode: 0o644 },
      ],
      removals: ["ok", 7, ""],
    });
    expect(parsed?.entries.map((e) => e.path)).toEqual(["{claude}/ok.md"]);
    expect(parsed?.removals).toEqual(["ok"]);
  });
});

describe("marcadores de caminho lógico", () => {
  it("toolMarker e markerTool", () => {
    expect(toolMarker("codex")).toBe("{codex}");
    expect(markerTool("{codex}/AGENTS.md")).toBe("codex");
    expect(markerTool("{claude}")).toBe("claude");
    expect(markerTool("{home}/x")).toBeNull();
    expect(markerTool("{project:github.com/o/r}/memory/x")).toBeNull();
  });

  it("projectIdOf e relPathOf", () => {
    expect(projectIdOf("{project:github.com/o/r}/memory/x.md")).toBe("github.com/o/r");
    expect(projectIdOf("{project:github.com/o/r}")).toBe("github.com/o/r");
    expect(projectIdOf("{claude}/x")).toBeNull();
    expect(relPathOf("{project:github.com/o/r}/memory/x.md")).toBe("memory/x.md");
    expect(relPathOf("{claude}")).toBe("");
    expect(HOME_MARKER).toBe("{home}");
  });

  it("isWorkHomeTool", () => {
    expect(isWorkHomeTool("claude")).toBe(true);
    expect(isWorkHomeTool("nope")).toBe(false);
  });
});

describe("packageByteSize / manifestByPath", () => {
  it("conta bytes únicos e indexa por path", () => {
    const blobs = new Map<string, Uint8Array>([
      ["a", new Uint8Array(3)],
      ["b", new Uint8Array(5)],
    ]);
    const pkg: WorkHomePackage = { manifest: buildManifest([]), blobs };
    expect(packageByteSize(pkg)).toBe(8);
    expect(manifestByPath(buildManifest([entry("{claude}/a.md")])).get("{claude}/a.md")?.tool).toBe("claude");
    expect(manifestByPath(null).size).toBe(0);
  });
});
