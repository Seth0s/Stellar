/**
 * Wraps scripts/verify/check-design-tokens.mjs so the cheap
 * SYSTEM_DESIGN §1 scan rides with `npm run test:unit` (and CI).
 *
 * The spacing tests (d200c269) pin the TEETH of the scale, not the
 * snapshot: the pure scanner decides violation vs escape per line, and
 * the real tree must sit at or below its frozen baseline — the same
 * ArchitectureBoundaries-style counter the gate runs.
 */

import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkAgainstBaseline,
  scanDesignTokens,
  scanSpacingRule,
  scanSpacingSource,
  updateBaseline,
} from "../../scripts/verify/check-design-tokens.mjs";

describe("check-design-tokens", () => {
  const result = scanDesignTokens();

  it("loads the tokens.css catalog", () => {
    expect(result.catalog.has("--text")).toBe(true);
    expect(result.catalog.has("--foam")).toBe(true);
    expect(result.catalog.size).toBeGreaterThan(20);
  });

  it("does not invent a silent theme fallback", () => {
    expect(result.missing).toEqual([]);
  });

  it("documents the one known TaskCard --bg gap instead of hiding it", () => {
    expect(result.known.map((g: { name: string }) => g.name)).toEqual(["--bg"]);
  });
});

describe("check-design-tokens spacing rule (d200c269) — o scanner puro", () => {
  it("marca px solto em propriedade de RITMO (padding/margin/gap), uma violação por declaração", () => {
    const { violations } = scanSpacingSource(`
.a {
  padding: 7px 10px;
  margin-top: -2.5px;
  gap: var(--space-2);
}
`);
    expect(violations).toEqual([
      { line: 3, property: "padding", values: ["7", "10"] },
      { line: 4, property: "margin-top", values: ["-2.5"] },
    ]);
  });

  it("NÃO marca zero, coordenada, raio, font-size, border nem var() — a escala é de ritmo", () => {
    const { violations } = scanSpacingSource(`
.a {
  padding: 0;
  margin: 0px;
  top: 8px;
  left: -7px;
  border-radius: 8px;
  border: 1px solid var(--border);
  font-size: 12px;
  width: 7.5rem;
  padding: var(--space-4) 0;
  gap: calc(var(--space-2) * 2);
}
`);
    expect(violations).toEqual([]);
  });

  it("escapatória declarada com motivo não é violação — e volta impressa, nunca invisível", () => {
    const { violations, escapes } = scanSpacingSource(
      `.badge {\n  padding: 1px 7px; /* sd:allow: 1px offsets the badge's own 1px border */\n}\n`,
    );
    expect(violations).toEqual([]);
    expect(escapes).toEqual([
      { line: 2, property: "padding", reason: "1px offsets the badge's own 1px border" },
    ]);
  });

  it("sd:allow SEM motivo é violação própria — escapatória sem razão é porta dos fundos", () => {
    const { violations, escapes } = scanSpacingSource(
      `.x {\n  margin: 4px; /* sd:allow */\n}\n`,
    );
    expect(escapes).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("without a reason");
  });

  it("comentário de bloco nunca vira declaração (o scan roda no bruto pra ver o marcador)", () => {
    const { violations } = scanSpacingSource(
      `/*\n * padding: 999px; (exemplo na doc)\n */\n.a { padding: var(--space-4); }\n`,
    );
    expect(violations).toEqual([]);
  });
});

describe("check-design-tokens spacing rule (d200c269) — a baseline congelada", () => {
  it("arquivo FORA da baseline com px solto falha (código novo nasce na escala)", () => {
    const failures = checkAgainstBaseline({ "new-thing.module.css": 3 }, {});
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("no frozen baseline");
  });

  it("arquivo listado não pode CRESCER, pode DIMINUIR, e zero-listado é protegido", () => {
    const frozen = { "layout.css": 10 };
    expect(checkAgainstBaseline({ "layout.css": 11 }, frozen)).toHaveLength(1);
    expect(checkAgainstBaseline({ "layout.css": 9 }, frozen)).toEqual([]);
    expect(checkAgainstBaseline({ "layout.css": 0 }, frozen)).toEqual([]);
    // Arquivo listado que desapareceu do tree não vira falha fantasma.
    expect(checkAgainstBaseline({}, frozen)).toEqual([]);
  });

  it("o tree REAL está dentro da baseline congelada (o mesmo que o gate roda)", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const baseline = JSON.parse(
      readFileSync(`${root}/scripts/verify/design-tokens-baseline.json`, "utf8"),
    );
    const { perFile, escapesByFile } = scanSpacingRule(root);
    const failures = checkAgainstBaseline(perFile, baseline.rules.spacing);
    expect(failures).toEqual([]);
    // Toda escapatória do tree tem motivo — o invariante do marcador.
    for (const escapes of Object.values(escapesByFile)) {
      for (const escape of escapes) {
        expect(escape.reason.trim().length).toBeGreaterThan(3);
      }
    }
  });

  it("escapatória com motivo EM BRANCO (`/* sd:allow: */`, espaço ou tab) é violação — a porta dos fundos não abre com um espaço", () => {
    const { violations, escapes } = scanSpacingSource(
      [
        ".a {",
        "  padding: 4px; /* sd:allow: */",
        "  margin: 2px; /* sd:allow:   */",
        "}",
      ].join("\n"),
    );
    expect(escapes).toEqual([]);
    expect(violations).toHaveLength(2);
    for (const v of violations) {
      expect(v.reason).toContain("empty reason");
    }
  });
});

describe("check-design-tokens spacing rule (d200c269) — o CAMINHO DE ESCRITA (updateBaseline)", () => {
  // Árvore descartável com o formato que o scan espera: <root>/src/renderer
  // + <root>/scripts/verify/design-tokens-baseline.json. É o cenário que o
  // revisor reproduziu à mão no StrokeCard: migra o arquivo, roda
  // --update-baseline, e a entrada congelada tem que ir a 0 — senão o
  // arquivo fica com folga permanente do tamanho da dívida pré-migração.
  function makeTree(dir: string, css: string, baselineSection: Record<string, number>): void {
    mkdirSync(join(dir, "src", "renderer"), { recursive: true });
    mkdirSync(join(dir, "scripts", "verify"), { recursive: true });
    writeFileSync(join(dir, "src", "renderer", "Fake.module.css"), css, "utf8");
    writeFileSync(
      join(dir, "scripts", "verify", "design-tokens-baseline.json"),
      `${JSON.stringify({ comment: "test baseline", rules: { spacing: baselineSection } }, null, 2)}\n`,
      "utf8",
    );
  }
  const FAKE = "src/renderer/Fake.module.css";

  it("migração até zero PINA o arquivo: --update-baseline grava 0 explícito, não congela a dívida velha", () => {
    const dir = makeTmpDir("sd-pin-zero");
    makeTree(dir, ".a {\n  padding: 7px;\n}\n", { [FAKE]: 1 });

    // A migração: a única declaração de ritmo vai pra escala.
    writeFileSync(join(dir, "src", "renderer", "Fake.module.css"), ".a {\n  padding: var(--space-4);\n}\n", "utf8");
    updateBaseline(dir);

    const written = JSON.parse(readFileSync(join(dir, "scripts", "verify", "design-tokens-baseline.json"), "utf8"));
    expect(written.rules.spacing[FAKE]).toBe(0);

    // E o pino morde: o px solto VOLTAR falha contra o 0 congelado.
    writeFileSync(join(dir, "src", "renderer", "Fake.module.css"), ".a {\n  padding: 7px;\n}\n", "utf8");
    const { perFile } = scanSpacingRule(dir);
    expect(checkAgainstBaseline(perFile, written.rules.spacing)).toHaveLength(1);
  });

  it("entrada de arquivo que saiu da árvore é PODADA (não há dívida pra congelar)", () => {
    const dir = makeTmpDir("sd-prune");
    makeTree(dir, ".a {\n  padding: 7px;\n}\n", {
      [FAKE]: 1,
      "src/renderer/Gone.module.css": 5,
    });

    updateBaseline(dir);

    const written = JSON.parse(readFileSync(join(dir, "scripts", "verify", "design-tokens-baseline.json"), "utf8"));
    expect(Object.keys(written.rules.spacing)).toEqual([FAKE]);
  });

  it("dívida que NÃO mudou continua congelada (o ratchet não inventa zero)", () => {
    const dir = makeTmpDir("sd-unchanged");
    makeTree(dir, ".a {\n  padding: 7px;\n}\n", { [FAKE]: 1 });

    updateBaseline(dir);

    const written = JSON.parse(readFileSync(join(dir, "scripts", "verify", "design-tokens-baseline.json"), "utf8"));
    expect(written.rules.spacing[FAKE]).toBe(1);
  });
});

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `stellar-${prefix}-`));
}
