import { describe, expect, it } from "vitest";
import {
  decideGateIsolation,
  describeGateIsolation,
  normalizeDeclaredRepoPath,
  readDeclaredFilesFromReport,
} from "../../src/main/gate-isolation-decision";

/**
 * THE DECISION to isolate a task's gates in a worktree holding only its own
 * diff.
 *
 * What these tests lock, and it is the point of the measured defect:
 *   - with a RELIABLE declaration (one card, its files) → `isolated`, with the
 *     exact set;
 *   - a file declared by TWO cards → `shared`, with both ids (picking a side
 *     would be a guess);
 *   - NO attribution (no card, or empty filesChanged) → `shared`, because
 *     isolating to pure HEAD would give a false green;
 *   - an invalid path / one that escapes → `shared`;
 *   - the note SAYS in which tree the measurement happened.
 */

const REPO = "/repo";

describe("decideGateIsolation", () => {
  it("sem git root → shared (não há HEAD de onde isolar)", () => {
    const d = decideGateIsolation({ cardId: "A", declared: [{ cardId: "A", paths: ["a.ts"] }], gitRoot: null });
    expect(d.mode).toBe("shared");
    expect(d.reason).toMatch(/não é um repositório git/);
  });

  it("sem card implementer → shared (sem atribuição)", () => {
    const d = decideGateIsolation({ cardId: null, declared: [{ cardId: "A", paths: ["a.ts"] }], gitRoot: REPO });
    expect(d.mode).toBe("shared");
    expect(d.reason).toMatch(/card implementer/);
  });

  it("card sem nenhum arquivo declarado → shared (isolar mediria HEAD sem a task)", () => {
    const d = decideGateIsolation({ cardId: "A", declared: [], gitRoot: REPO });
    expect(d.mode).toBe("shared");
    expect(d.reason).toMatch(/não declarou nenhum arquivo/);
  });

  it("uma declaração só → isolated, com o conjunto normalizado/deduplicado", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [{ cardId: "A", paths: ["./src/a.ts", "src/a.ts", "src/b.ts:12", "src/c.ts (M, +2/-1)"] }],
      gitRoot: REPO,
    });
    expect(d.mode).toBe("isolated");
    expect(d.files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(d.disputed).toEqual([]);
    expect(d.reason).toBeNull();
  });

  it("arquivo declarado por DOIS cards → shared, com os DOIS ids no aviso", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [
        { cardId: "A", paths: ["shared.ts", "onlyA.ts"] },
        { cardId: "B", paths: ["shared.ts"] },
      ],
      gitRoot: REPO,
    });
    expect(d.mode).toBe("shared");
    expect(d.disputed).toEqual([{ path: "shared.ts", cardIds: ["A", "B"] }]);
    expect(d.reason).toMatch(/shared\.ts \(A, B\)/);
  });

  it("arquivo de OUTRO card (não o meu) não bloqueia: o meu conjunto segue isolável", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [
        { cardId: "A", paths: ["onlyA.ts"] },
        { cardId: "B", paths: ["onlyB.ts"] },
      ],
      gitRoot: REPO,
    });
    expect(d.mode).toBe("isolated");
    expect(d.files).toEqual(["onlyA.ts"]);
  });

  it("caminho do MEU card que escapa a raiz → shared (não copia o que pode escapar)", () => {
    for (const bad of ["../secrets", "/etc/passwd", "src/../../x"]) {
      const d = decideGateIsolation({ cardId: "A", declared: [{ cardId: "A", paths: [bad] }], gitRoot: REPO });
      expect(d.mode).toBe("shared");
      expect(d.reason).toMatch(/caminho inválido/);
    }
  });

  it("caminho inválido de OUTRO card não contamina o meu", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [
        { cardId: "A", paths: ["ok.ts"] },
        { cardId: "B", paths: ["../evil"] },
      ],
      gitRoot: REPO,
    });
    expect(d.mode).toBe("isolated");
    expect(d.files).toEqual(["ok.ts"]);
  });
});

describe("normalizeDeclaredRepoPath", () => {
  it("aceita caminho puro e sujeira de evidência/prosa", () => {
    expect(normalizeDeclaredRepoPath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeDeclaredRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeDeclaredRepoPath("src/a.ts:12-14")).toBe("src/a.ts");
    expect(normalizeDeclaredRepoPath("src/a.ts (M, +2/-1)")).toBe("src/a.ts");
    expect(normalizeDeclaredRepoPath("src//a/b.ts")).toBe("src/a/b.ts");
  });

  it("recusa absoluto, `..` e vazio", () => {
    expect(normalizeDeclaredRepoPath("/etc/passwd")).toBeNull();
    expect(normalizeDeclaredRepoPath("C:/Windows")).toBeNull();
    expect(normalizeDeclaredRepoPath("a/../b")).toBeNull();
    expect(normalizeDeclaredRepoPath("   ")).toBeNull();
    expect(normalizeDeclaredRepoPath(7)).toBeNull();
  });
});

describe("readDeclaredFilesFromReport", () => {
  it("extrai e normaliza filesChanged; forma inesperada vira AUSÊNCIA", () => {
    expect(readDeclaredFilesFromReport(JSON.stringify({ filesChanged: ["a.ts", "./b.ts"] }))).toEqual(["a.ts", "b.ts"]);
    expect(readDeclaredFilesFromReport(JSON.stringify({ filesChanged: "a.ts" }))).toEqual([]);
    expect(readDeclaredFilesFromReport("[]")).toEqual([]);
    expect(readDeclaredFilesFromReport("not json")).toEqual([]);
    expect(readDeclaredFilesFromReport(null)).toEqual([]);
  });
});

describe("describeGateIsolation", () => {
  it("isolated DIZ que a medição é limpa", () => {
    const note = describeGateIsolation({ mode: "isolated", appliedFiles: ["a.ts"], disputed: [], reason: null });
    expect(note).toMatch(/ISOLADA/);
    expect(note).toContain("a.ts");
    expect(note).toMatch(/outros cards NÃO/);
  });

  it("shared DIZ que pode incluir trabalho de outros cards, com o motivo", () => {
    const note = describeGateIsolation({
      mode: "shared",
      appliedFiles: [],
      disputed: [{ path: "x.ts", cardIds: ["A", "B"] }],
      reason: "sem atribuição",
    });
    expect(note).toMatch(/ÁRVORE COMPARTILHADA/);
    expect(note).toMatch(/pode incluir trabalho de outros cards/);
    expect(note).toContain("sem atribuição");
    expect(note).toContain("x.ts");
    expect(note).toContain("A e B");
  });
});
