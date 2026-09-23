import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STRUCTURAL_CODE_DIRS,
  decideArtifactCandidates,
  declaredFilesFromReport,
  describeArtifactPendencies,
  isCoveredRepoDir,
  isProbeName,
  isProjectCodeExt,
  type UntrackedArtifact,
} from "../../src/main/judgment-write-decision";

/**
 * ITEM 21 — o detector de artefato de trabalho na árvore. Ele é PURO: recebe
 * os untracked já coletados e decide o que é PENDÊNCIA. As três exclusões e o
 * formato são o contrato; o `git status` em si é do chamador (message-bus).
 */
describe("item 21 — decideArtifactCandidates", () => {
  const root = "/repo";
  const at = (path: string, modifiedAtMs = 2_000, bytes = 10): UntrackedArtifact => ({
    path,
    bytes,
    modifiedAtMs,
  });
  /** A task começou em 1000: qualquer coisa com mtime >= 1000 nasceu nela. */
  const base = { workspaceRoot: root, taskStartedAtMs: 1_000, declaredFiles: [] as string[] };

  it("lista untracked NÃO declarado criado durante a task — com bytes e mtime", () => {
    const got = decideArtifactCandidates({
      ...base,
      untracked: [at("scratch.php", 2_000, 42), at("diff.txt", 3_000, 520)],
    });
    expect(got).toEqual([
      { path: "diff.txt", bytes: 520, modifiedAtMs: 3_000 },
      { path: "scratch.php", bytes: 42, modifiedAtMs: 2_000 },
    ]);
  });

  it("o que o relatório DECLAROU não é pendência — é a entrega", () => {
    const got = decideArtifactCandidates({
      ...base,
      declaredFiles: ["src/main/message-bus.ts"],
      untracked: [at("src/main/message-bus.ts"), at("scratch.php")],
    });
    expect(got.map((c) => c.path)).toEqual(["scratch.php"]);
  });

  it("declaração ABSOLUTA cobre o untracked relativo (e vice-versa)", () => {
    const got = decideArtifactCandidates({
      ...base,
      declaredFiles: ["/repo/tests/unit/artifact-pendencies.test.ts"],
      untracked: [at("tests/unit/artifact-pendencies.test.ts")],
    });
    expect(got).toEqual([]);
  });

  it("arquivo ANTERIOR à task não é artefato DELA (a janela temporal)", () => {
    const got = decideArtifactCandidates({
      ...base,
      untracked: [at("velho.txt", 500), at("novo.txt", 1_500)],
    });
    expect(got.map((c) => c.path)).toEqual(["novo.txt"]);
  });

  it("node_modules, build e cache nunca são candidatos", () => {
    const got = decideArtifactCandidates({
      ...base,
      untracked: [
        at("node_modules/x/index.js"),
        at("dist/app.js"),
        at("build/out.o"),
        at(".vite/deps/x"),
        at("scratch.txt"), // o "normal" aqui é da RAIZ: `src/x.ts` já cai na 4ª exclusão
      ],
    });
    expect(got.map((c) => c.path)).toEqual(["scratch.txt"]);
  });

  it("mtime desconhecido (0) NÃO vira 'antigo': continua candidato", () => {
    const got = decideArtifactCandidates({ ...base, untracked: [at("sem-stat.bin", 0)] });
    expect(got.map((c) => c.path)).toEqual(["sem-stat.bin"]);
  });

  it("ordena por caminho", () => {
    const got = decideArtifactCandidates({
      ...base,
      untracked: [at("z.txt"), at("a.txt"), at("m.txt")],
    });
    expect(got.map((c) => c.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });
});

describe("item 21 — declaredFilesFromReport", () => {
  it("array `files` (o schema do board)", () => {
    expect(declaredFilesFromReport({ ok: true, files: ["a.ts", "b.ts"] })).toEqual(["a.ts", "b.ts"]);
  });

  it("`filesChanged` em prosa: crase, vírgula e quebra separam", () => {
    expect(declaredFilesFromReport({ filesChanged: "`a.ts`, src/b.ts\nsrc/c.ts" })).toEqual([
      "a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("payload que não declara nada devolve vazio — nunca inventa", () => {
    expect(declaredFilesFromReport({ ok: true, medicao: "5" })).toEqual([]);
    expect(declaredFilesFromReport("string solta")).toEqual([]);
    expect(declaredFilesFromReport(null)).toEqual([]);
  });
});

describe("item 21 — describeArtifactPendencies", () => {
  it("vazio não vira mensagem", () => {
    expect(describeArtifactPendencies([])).toBe("");
  });

  it("diz caminho, bytes e 'desde quando', e se declara SIGNAL (nothing was deleted)", () => {
    const msg = describeArtifactPendencies([
      { path: "scratch.php", bytes: 42, modifiedAtMs: 1_700_000_000_000 },
    ]);
    expect(msg).toContain("scratch.php");
    expect(msg).toContain("42 B");
    expect(msg).toContain("desde ");
    expect(msg).toContain("CLEANUP PENDING");
    expect(msg).toContain("nothing was deleted");
    expect(msg).toContain("SIGNAL");
  });
});

/**
 * A 4ª exclusão é a que separa os DOIS MUNDOS. Medido: sem ela, 7 de 7
 * falso-positivo nesta árvore (arquivos de código de outros cards). Com ela,
 * zero — e os dois casos REAIS (raiz) continuam pegos.
 */
describe("item 21 — a 4ª exclusão (estrutura) separa os dois mundos", () => {
  const base = { workspaceRoot: "/repo", taskStartedAtMs: 0, declaredFiles: [] as string[] };
  const at = (path: string): UntrackedArtifact => ({ path, bytes: 1, modifiedAtMs: 2_000 });

  it("código em caminho de código NÃO é candidato (a precisão)", () => {
    const got = decideArtifactCandidates({
      ...base,
      untracked: [
        at("src/main/session-store-spec.ts"),
        at("tests/unit/mcp-server-strict-shape.test.ts"),
        at("scripts/verify/smoke-x.mjs"),
      ],
    });
    expect(got).toEqual([]);
  });

  it("na RAIZ o mesmo arquivo de código É candidato (a raiz não é estrutura)", () => {
    const got = decideArtifactCandidates({ ...base, untracked: [at("probe.ts")] });
    expect(got.map((c) => c.path)).toEqual(["probe.ts"]);
  });

  it("extensão ESTRANHA dentro de dir de código É candidata (sonda em src)", () => {
    const got = decideArtifactCandidates({ ...base, untracked: [at("src/main/scratch.php")] });
    expect(got.map((c) => c.path)).toEqual(["src/main/scratch.php"]);
  });

  it("nome de SONDA vence a estrutura (o caso de uso: a sonda do próprio autor)", () => {
    const got = decideArtifactCandidates({
      ...base,
      untracked: [
        at("tests/unit/zz-measure2.test.ts"),
        at("src/main/zz-probe.ts"),
        at("src/main/probe.ts"),
      ],
    });
    expect(got.map((c) => c.path)).toEqual([
      "src/main/probe.ts",
      "src/main/zz-probe.ts",
      "tests/unit/zz-measure2.test.ts",
    ]);
  });

  it("os dois nomes VIVOS do repo NÃO casam (fronteira, não substring)", () => {
    // O repo usa `measure-*` e `-tmp-` de verdade; casar por substring os
    // acusaria. Aqui eles são estrutura (código em caminho de código).
    const got = decideArtifactCandidates({
      ...base,
      untracked: [at("scripts/measure-reach-gabarito.ts"), at("tests/unit/verify-tmp-sweep.test.ts")],
    });
    expect(got).toEqual([]);
  });

  it("INTEGRAÇÃO num repo git temporário: `scratch.php` (raiz) e `diff.txt` de 520 linhas (raiz) SÃO pegos; `src/*.ts` NÃO", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-pend-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "scratch.php"), "<?php echo contador();\n");
      writeFileSync(join(dir, "diff.txt"), "+ linha de diff\n".repeat(520));
      mkdirSync(join(dir, "src", "main"), { recursive: true });
      writeFileSync(join(dir, "src", "main", "ok.ts"), "export const x = 1;\n");
      // o falso-positivo de HOJE, recriado: outro card escrevendo código.
      writeFileSync(join(dir, "src", "main", "outro-card.ts"), "export const y = 2;\n");
      // O CASO DE USO (a sonda do próprio autor, em caminho de código): o
      // NOME vence a estrutura, então estes dois TÊM de ser pegos.
      writeFileSync(join(dir, "src", "main", "zz-probe.ts"), "// sonda\n");
      mkdirSync(join(dir, "tests", "unit"), { recursive: true });
      writeFileSync(join(dir, "tests", "unit", "zz-measure2.test.ts"), "// sonda\n");

      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
      const out = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
        cwd: dir,
        encoding: "utf8",
      });
      const untracked: UntrackedArtifact[] = [];
      for (const line of out.split("\n")) {
        if (!line.startsWith("?? ")) continue;
        const rel = line.slice(3).trim();
        const st = statSync(join(root, rel));
        untracked.push({ path: rel, bytes: st.size, modifiedAtMs: st.mtimeMs });
      }
      expect(untracked).toHaveLength(6);

      const got = decideArtifactCandidates({
        untracked,
        declaredFiles: [],
        workspaceRoot: root,
        taskStartedAtMs: 0,
      });
      // Os DOIS casos reais (raiz) + as DUAS sondas (nome vence estrutura),
      // e NADA de outro card (src/main/outro-card.ts fica de fora).
      expect(got.map((c) => c.path)).toEqual([
        "diff.txt",
        "scratch.php",
        "src/main/zz-probe.ts",
        "tests/unit/zz-measure2.test.ts",
      ]);
      const diff = got.find((c) => c.path === "diff.txt")!;
      expect(diff.bytes).toBeGreaterThan(500); // 520 linhas, não um toque
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * GATE ANTI-DRIFT — as listas não podem apodrecer. Em vez de repetir
 * `STRUCTURAL_CODE_DIRS`/`PROJECT_CODE_EXTS` (a mesma mão duas vezes), este
 * teste DERIVA do repo com `git ls-files`: um diretório de topo, ou uma
 * extensão sob diretório estrutural, que o repo USE e a lista não cubra
 * REPROVA — e aí quem adicionou decide conscientemente, em vez de um
 * falso-positivo silencioso. É o preço que o mapa de effort já cobrou uma vez.
 */
describe("item 21 — gate anti-drift (deriva do repo, não repete a lista)", () => {
  const extOf = (path: string): string => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot).toLowerCase() : ""; // dotfile não tem extensão
  };

  it("todo diretório de topo e toda extensão sob dir estrutural estão cobertos", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

    // Nenhum NOME rastreado (os 689) pode casar: alvo ZERO. Se um arquivo
    // legítimo nascer com nome de sonda, o gate reprova e a decisão vira
    // consciente em vez de falso-positivo silencioso.
    expect(files.filter((f) => isProbeName(f))).toEqual([]);

    const dirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!))].sort();
    expect(dirs.filter((d) => !isCoveredRepoDir(d))).toEqual([]);

    const structural = files.filter((f) => f.includes("/") && STRUCTURAL_CODE_DIRS.includes(f.split("/")[0]!));
    const exts = [...new Set(structural.map(extOf).filter((e) => e !== ""))].sort();
    expect(exts.filter((e) => !isProjectCodeExt(e))).toEqual([]);
  });
});
