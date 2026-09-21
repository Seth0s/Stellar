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
  SD_RULES,
  checkAgainstBaseline,
  scanColorRule,
  scanColorSource,
  scanDesignTokens,
  scanMotionRule,
  scanMotionSource,
  scanRadiusRule,
  scanRadiusSource,
  scanSpacingRule,
  scanSpacingSource,
  scanTypographyRule,
  scanTypographySource,
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

  it("comentário de bloco nunca vira declaração (o parser blankeia o comentário; o marcador é lido do bruto)", () => {
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

describe("check-design-tokens typography rule (c8cd45fc) — a regra irmã, mesmo mecanismo", () => {
  const typography = SD_RULES.find((r: { id: string }) => r.id === "typography")!;

  it("marca font-size px LITERAL (um valor só) e honra a escapatória auditada", () => {
    const { violations, escapes } = scanTypographySource(
      [
        ".a {",
        "  font-size: 10.5px;",
        "  line-height: 1.4;",
        "}",
        ".b {",
        "  font-size: 11px; /* sd:allow: alinha com o glifo do chip */",
        "}",
      ].join("\n"),
    );
    expect(violations).toEqual([{ line: 2, property: "font-size", values: ["10.5"] }]);
    expect(escapes).toEqual([{ line: 6, property: "font-size", reason: "alinha com o glifo do chip" }]);
  });

  it("NÃO marca a fronteira por desenho: clamp/calc, var(), em, zero nem outra propriedade", () => {
    const { violations } = scanTypographySource(
      [
        ".a {",
        "  font-size: clamp(10px, 1.6cqw, 14px);",
        "  font-size: var(--sticky-font-size, 14px);",
        "  font-size: 0.9em;",
        "  font-size: 0;",
        "  padding: 7px;",
        "}",
      ].join("\n"),
    );
    expect(violations).toEqual([]);
  });

  it("motivo em branco é violação nesta regra também (mesmo invariante do marcador)", () => {
    const { violations, escapes } = scanTypographySource(".a {\n  font-size: 9px; /* sd:allow:  */\n}\n");
    expect(escapes).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("empty reason");
  });

  it("o tree REAL está dentro da baseline de tipografia e o arquivo migrado está PINADO em 0", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const baseline = JSON.parse(
      readFileSync(`${root}/scripts/verify/design-tokens-baseline.json`, "utf8"),
    );
    const { perFile } = scanTypographyRule(root);
    expect(checkAgainstBaseline(perFile, baseline.rules.typography, typography)).toEqual([]);
    // O pino: o arquivo da prova migrou e não pode voltar a ter px.
    expect(baseline.rules.typography["src/renderer/src/TaskCard.module.css"]).toBe(0);
    // E a seção da parte 1 segue viva, no valor dela.
    expect(baseline.rules.spacing["src/renderer/src/styles/layout.css"]).toBe(201); // ratchet da fatia de primitivas (e165651e), era 209
  });

  it("updateBaseline escreve a seção da SEGUNDA regra e preserva a da primeira", () => {
    const dir = makeTmpDir("sd-typography-write");
    mkdirSync(join(dir, "src", "renderer"), { recursive: true });
    mkdirSync(join(dir, "scripts", "verify"), { recursive: true });
    writeFileSync(join(dir, "src", "renderer", "Fake.module.css"), ".a {\n  font-size: 10.5px;\n  padding: 7px;\n}\n", "utf8");
    writeFileSync(
      join(dir, "scripts", "verify", "design-tokens-baseline.json"),
      `${JSON.stringify({ comment: "test baseline", rules: { spacing: { "src/renderer/Fake.module.css": 1 } } }, null, 2)}\n`,
      "utf8",
    );

    updateBaseline(dir);

    const written = JSON.parse(readFileSync(join(dir, "scripts", "verify", "design-tokens-baseline.json"), "utf8"));
    expect(written.rules.typography["src/renderer/Fake.module.css"]).toBe(1);
    expect(written.rules.spacing["src/renderer/Fake.module.css"]).toBe(1);
  });
});

describe("check-design-tokens radius rule (325d6c66) — a TERCEIRA regra, mesmo mecanismo", () => {
  const radius = SD_RULES.find((r: { id: string }) => r.id === "radius")!;

  it("marca px cru (inclusive vários numa declaração) e o `50%` sozinho, e honra a escapatória auditada", () => {
    const { violations, escapes } = scanRadiusSource(
      [
        ".a {",
        "  border-radius: 8px 8px 0 0;",
        "  border-radius: 50%;",
        "  border-radius: 24px; /* sd:allow: raio grande fixo, 999px vira elipse quando a caixa cresce */",
        "}",
      ].join("\n"),
    );
    expect(violations).toEqual([
      { line: 2, property: "border-radius", values: ["8", "8"] },
      { line: 3, property: "border-radius", values: ["50%"] },
    ]);
    expect(escapes).toEqual([
      {
        line: 4,
        property: "border-radius",
        reason: "raio grande fixo, 999px vira elipse quando a caixa cresce",
      },
    ]);
  });

  it("NÃO marca var(), zero, o `0` de um canto nem outra propriedade — mas VÊ os longhands lógicos", () => {
    const { violations } = scanRadiusSource(
      [
        ".a {",
        "  border-radius: var(--radius-3);",
        "  border-radius: var(--radius) var(--radius) 0 0;",
        "  border-radius: 0;",
        "  border-radius: 0 8px 8px 0;",
        "  border-start-start-radius: 4px;",
        "  padding: 7px;",
        "  font-size: 12px;",
        "  border-width: 1px;",
        "}",
      ].join("\n"),
    );
    expect(violations).toEqual([
      { line: 5, property: "border-radius", values: ["8", "8"] },
      { line: 6, property: "border-start-start-radius", values: ["4"] },
    ]);
  });

  it("motivo em branco é violação nesta regra também (mesmo invariante do marcador)", () => {
    const { violations, escapes } = scanRadiusSource(
      ".a {\n  border-radius: 20px; /* sd:allow: */\n}\n",
    );
    expect(escapes).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("empty reason");
  });

  it("as FORMAS têm token próprio no catálogo (pílula e círculo não são degraus da régua)", () => {
    const { catalog } = scanDesignTokens();
    // Os cinco degraus são os mesmos cinco primeiros do --space-*.
    expect(["1", "2", "3", "4", "5"].every((n) => catalog.has(`--radius-${n}`))).toBe(true);
    expect(catalog.has("--radius-6")).toBe(false);
    expect(catalog.has("--radius-pill")).toBe(true);
    expect(catalog.has("--radius-circle")).toBe(true);
    // `--radius` continua existindo (alias de --radius-5) — nenhuma referência pendurada.
    expect(catalog.has("--radius")).toBe(true);
  });

  it("o tree REAL está dentro da baseline de raio e o arquivo migrado está PINADO em 0", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const baseline = JSON.parse(
      readFileSync(`${root}/scripts/verify/design-tokens-baseline.json`, "utf8"),
    );
    const { perFile } = scanRadiusRule(root);
    expect(checkAgainstBaseline(perFile, baseline.rules.radius, radius)).toEqual([]);
    // O pino de raio, no MESMO arquivo que a parte 2 pinou para tipografia.
    expect(baseline.rules.radius["src/renderer/src/TaskCard.module.css"]).toBe(0);
    expect(baseline.rules.typography["src/renderer/src/TaskCard.module.css"]).toBe(0);
    // E as duas seções anteriores seguem vivas, nos valores delas — a terceira
    // regra não vazou entre elas.
    expect(baseline.rules.spacing["src/renderer/src/TaskCard.module.css"]).toBe(102);
    expect(baseline.rules.spacing["src/renderer/src/styles/layout.css"]).toBe(201); // ratchet da fatia de primitivas (e165651e), era 209
  });

  it("updateBaseline escreve a seção da TERCEIRA regra e preserva as das duas anteriores", () => {
    const dir = makeTmpDir("sd-radius-write");
    mkdirSync(join(dir, "src", "renderer"), { recursive: true });
    mkdirSync(join(dir, "scripts", "verify"), { recursive: true });
    writeFileSync(
      join(dir, "src", "renderer", "Fake.module.css"),
      ".a {\n  border-radius: 8px;\n  font-size: 10.5px;\n  padding: 7px;\n}\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "scripts", "verify", "design-tokens-baseline.json"),
      `${JSON.stringify(
        {
          comment: "test baseline",
          rules: {
            spacing: { "src/renderer/Fake.module.css": 1 },
            typography: { "src/renderer/Fake.module.css": 1 },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    updateBaseline(dir);

    const written = JSON.parse(
      readFileSync(join(dir, "scripts", "verify", "design-tokens-baseline.json"), "utf8"),
    );
    expect(written.rules.radius["src/renderer/Fake.module.css"]).toBe(1);
    expect(written.rules.spacing["src/renderer/Fake.module.css"]).toBe(1);
    expect(written.rules.typography["src/renderer/Fake.module.css"]).toBe(1);
  });

  it("seção NOVA também pina: arquivo listado ANTES de zerar volta como 0 explícito, e o px que reaparece morde", () => {
    // É o caminho que este card percorreu de verdade: a seção de raio nasce
    // listando o arquivo com a dívida, a migração zera, o --update-baseline
    // grava 0, e devolver o px cru falha contra o 0.
    const dir = makeTmpDir("sd-radius-new-section-pin");
    mkdirSync(join(dir, "src", "renderer"), { recursive: true });
    mkdirSync(join(dir, "scripts", "verify"), { recursive: true });
    const FAKE = "src/renderer/Fake.module.css";
    writeFileSync(
      join(dir, "scripts", "verify", "design-tokens-baseline.json"),
      `${JSON.stringify({ comment: "test baseline", rules: { radius: { [FAKE]: 2 } } }, null, 2)}\n`,
      "utf8",
    );
    // A migração: as duas declarações cruas viram a escala.
    writeFileSync(
      join(dir, "src", "renderer", "Fake.module.css"),
      ".a {\n  border-radius: var(--radius-4);\n}\n.b {\n  border-radius: var(--radius-pill); /* sd:allow: motivo de teste longo o bastante */\n}\n",
      "utf8",
    );

    updateBaseline(dir);

    const written = JSON.parse(
      readFileSync(join(dir, "scripts", "verify", "design-tokens-baseline.json"), "utf8"),
    );
    expect(written.rules.radius[FAKE]).toBe(0);

    // O pino morde: o px cru que voltar falha contra o 0 congelado.
    writeFileSync(
      join(dir, "src", "renderer", "Fake.module.css"),
      ".a {\n  border-radius: 8px;\n}\n",
      "utf8",
    );
    const { perFile } = scanRadiusRule(dir);
    const failures = checkAgainstBaseline(perFile, written.rules.radius, radius);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("grew by");
  });
});

describe("check-design-tokens motion rule (153ca424) — a QUARTA regra, mesmo mecanismo", () => {
  const motion = SD_RULES.find((r: { id: string }) => r.id === "motion")!;

  it("marca a DURAÇÃO de cada parte (o primeiro tempo) e honra a escapatória auditada", () => {
    const { violations, escapes } = scanMotionSource(
      [
        ".a {",
        "  transition: background-color 0.12s ease, color 0.15s ease;",
        "  animation: popout 0.16s ease-in forwards;",
        "  animation: mic-pulse 1.1s ease-out infinite; /* sd:allow: batida do indicador de gravação — 1.1s é a razão dele, não um degrau */",
        "}",
      ].join("\n"),
    );
    expect(violations).toEqual([
      { line: 2, property: "transition", values: ["0.12s", "0.15s"] },
      { line: 3, property: "animation", values: ["0.16s"] },
    ]);
    expect(escapes).toHaveLength(1);
    expect(escapes[0].line).toBe(4);
    expect(escapes[0].reason).toContain("1.1s é a razão dele");
  });

  it("o DELAY não é varrido (deslocamento de fase, muitas vezes aritmético: n×0.15)", () => {
    const { violations } = scanMotionSource(
      [
        ".dots span:nth-child(2) {",
        "  animation-delay: 0.15s;",
        "}",
        ".dots span:nth-child(3) {",
        "  animation-delay: 0.3s;",
        "}",
        ".a {",
        "  transition: width 0.3s ease;",
        "}",
      ].join("\n"),
    );
    // Os dois delays passam; a duração crua do terceiro bloco é que é violação.
    expect(violations).toEqual([{ line: 8, property: "transition", values: ["0.3s"] }]);
  });

  it("NÃO marca var(), zero, `none` nem a curva — e a curva não tem token por desenho", () => {
    const { violations } = scanMotionSource(
      [
        ".a {",
        "  transition: background-color var(--duration-1) ease;",
        "  transition: none;",
        "  animation: none !important;",
        "  transition: box-shadow 0s ease-out;",
        "  font-size: 12px;",
        "  padding: 7px;",
        "  border-radius: 8px;",
        "}",
      ].join("\n"),
    );
    expect(violations).toEqual([]);
  });

  it("motivo em branco é violação nesta regra também (mesmo invariante do marcador)", () => {
    const { violations, escapes } = scanMotionSource(".a {\n  animation: spin 0.7s linear infinite; /* sd:allow:  */\n}\n");
    expect(escapes).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("empty reason");
  });

  it("as duas formas de um valor: 120ms e 0.12s são a MESMA duração, e as duas contam", () => {
    const { violations } = scanMotionSource(".a {\n  transition: opacity 120ms ease;\n}\n");
    expect(violations).toEqual([{ line: 2, property: "transition", values: ["120ms"] }]);
  });

  it("o tree REAL está dentro da baseline de movimento e o arquivo migrado está PINADO em 0", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const baseline = JSON.parse(
      readFileSync(`${root}/scripts/verify/design-tokens-baseline.json`, "utf8"),
    );
    const { perFile } = scanMotionRule(root);
    expect(checkAgainstBaseline(perFile, baseline.rules.motion, motion)).toEqual([]);
    // O pino de movimento — a prova é o animations.css, o arquivo do domínio.
    expect(baseline.rules.motion["src/renderer/src/styles/animations.css"]).toBe(0);
    // E as TRÊS seções anteriores seguem vivas, nos valores delas.
    expect(baseline.rules.spacing["src/renderer/src/styles/layout.css"]).toBe(201); // ratchet da fatia de primitivas (e165651e), era 209
    expect(baseline.rules.typography["src/renderer/src/TaskCard.module.css"]).toBe(0);
    expect(baseline.rules.radius["src/renderer/src/TaskCard.module.css"]).toBe(0);
  });

  it("updateBaseline escreve a seção da QUARTA regra e preserva as das três anteriores", () => {
    const dir = makeTmpDir("sd-motion-write");
    mkdirSync(join(dir, "src", "renderer"), { recursive: true });
    mkdirSync(join(dir, "scripts", "verify"), { recursive: true });
    const FAKE = "src/renderer/Fake.module.css";
    writeFileSync(
      join(dir, "src", "renderer", "Fake.module.css"),
      ".a {\n  transition: color 0.12s ease;\n  border-radius: 8px;\n  font-size: 10.5px;\n  padding: 7px;\n}\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "scripts", "verify", "design-tokens-baseline.json"),
      `${JSON.stringify(
        {
          comment: "test baseline",
          rules: {
            spacing: { [FAKE]: 1 },
            typography: { [FAKE]: 1 },
            radius: { [FAKE]: 1 },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    updateBaseline(dir);

    const written = JSON.parse(
      readFileSync(join(dir, "scripts", "verify", "design-tokens-baseline.json"), "utf8"),
    );
    expect(written.rules.motion[FAKE]).toBe(1);
    expect(written.rules.spacing[FAKE]).toBe(1);
    expect(written.rules.typography[FAKE]).toBe(1);
    expect(written.rules.radius[FAKE]).toBe(1);
  });

  it("o mundo B (feedback contínuo) só passa com motivo declarado — e ele volta impresso", () => {
    // A linha real do mic-pulse, com e sem o marcador.
    const semMarcador = scanMotionSource(".iconBtn.recording::after {\n  animation: mic-pulse 1.1s ease-out infinite;\n}\n");
    expect(semMarcador.violations).toHaveLength(1);
    expect(semMarcador.escapes).toEqual([]);

    const comMarcador = scanMotionSource(
      ".iconBtn.recording::after {\n  animation: mic-pulse 1.1s ease-out infinite; /* sd:allow: respiração do indicador de gravação: 1.1s é a razão dele, não um degrau */\n}\n",
    );
    expect(comMarcador.violations).toEqual([]);
    expect(comMarcador.escapes).toHaveLength(1);
    expect(comMarcador.escapes[0].property).toBe("animation");
  });
});

describe("check-design-tokens — o scan lê a DECLARAÇÃO inteira (task 0f96fbda)", () => {
  it("enxerga valor quebrado em várias linhas — a forma que o PRETTIER produz", () => {
    // O shape real de layout.css:246 (o .rail-toggle), com os valores crus:
    // até esta task ele não era violação NEM congelado — não existia pro gate.
    const src = [
      ".rail-toggle {",
      "  transition: left 0.28s cubic-bezier(0.16, 1, 0.3, 1),",
      "              width 0.15s ease,",
      "              opacity 0.2s ease;",
      "}",
      "",
    ].join("\n");
    const { violations } = scanMotionSource(src);
    expect(violations).toEqual([
      { line: 2, property: "transition", values: ["0.28s", "0.15s", "0.2s"] },
    ]);
  });

  it("as QUATRO regras usam o MESMO parser — o multi-linha vale para todas", () => {
    expect(scanSpacingSource(".a {\n  padding:\n    7px\n    10px;\n}\n").violations).toEqual([
      { line: 2, property: "padding", values: ["7", "10"] },
    ]);
    expect(scanTypographySource(".a {\n  font-size:\n    12px;\n}\n").violations).toEqual([
      { line: 2, property: "font-size", values: ["12"] },
    ]);
    expect(scanRadiusSource(".a {\n  border-radius:\n    8px;\n}\n").violations).toEqual([
      { line: 2, property: "border-radius", values: ["8"] },
    ]);
    expect(
      scanMotionSource(".a {\n  animation:\n    spin 0.7s linear infinite;\n}\n").violations,
    ).toEqual([{ line: 2, property: "animation", values: ["0.7s"] }]);
  });

  it("atribui a SEGUNDA declaração da mesma linha (antes só a primeira `prop:` contava)", () => {
    const { violations } = scanSpacingSource(".a { padding: 7px; margin: 3px; }\n");
    expect(violations).toEqual([
      { line: 1, property: "padding", values: ["7"] },
      { line: 1, property: "margin", values: ["3"] },
    ]);
  });

  it("declaração DENTRO de comentário não é violação — mesmo sem `*` na frente da linha", () => {
    const { violations } = scanSpacingSource(
      [
        "/*",
        "padding: 99px;  (exemplo na doc, linha sem asterisco)",
        "*/",
        ".a { padding: var(--space-4); }",
      ].join("\n"),
    );
    expect(violations).toEqual([]);
  });

  it("escapatória em declaração multi-linha: o marcador vai na linha do `;`", () => {
    const src = [
      ".a {",
      "  transition:",
      "    color 0.12s ease,",
      "    background 0.2s ease; /* sd:allow: par de cores do mesmo hover, tempo próprio */",
      "}",
      "",
    ].join("\n");
    const { violations, escapes } = scanMotionSource(src);
    expect(violations).toEqual([]);
    expect(escapes).toHaveLength(1);
    expect(escapes[0].line).toBe(4);
  });

  it("o limite que FICA: declaração sem `;` continua fora do alcance", () => {
    expect(scanSpacingSource(".a {\n  padding: 7px\n}\n").violations).toEqual([]);
  });

  it("um valor cru MULTI-LINHA não se esconde atrás de um pino em 0", () => {
    const dir = makeTmpDir("sd-multiline-pin");
    mkdirSync(join(dir, "src", "renderer"), { recursive: true });
    mkdirSync(join(dir, "scripts", "verify"), { recursive: true });
    const FAKE = "src/renderer/Fake.module.css";
    writeFileSync(
      join(dir, "src", "renderer", "Fake.module.css"),
      ".a {\n  transition:\n    color 0.12s ease,\n    background 0.2s ease;\n}\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "scripts", "verify", "design-tokens-baseline.json"),
      `${JSON.stringify({ comment: "test baseline", rules: { motion: { [FAKE]: 0 } } }, null, 2)}\n`,
      "utf8",
    );
    const motion = SD_RULES.find((r: { id: string }) => r.id === "motion")!;
    const { perFile } = scanMotionRule(dir);
    expect(perFile[FAKE]).toBe(1);
    const failures = checkAgainstBaseline(perFile, { [FAKE]: 0 }, motion);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("grew by");
  });
});

describe("check-design-tokens color rule (16a6abb5) — a QUINTA regra, mesmo mecanismo", () => {
  const color = SD_RULES.find((r: { id: string }) => r.id === "color")!;

  it("marca literal de cor e NÃO marca derivação — o primeiro corte da parte 6", () => {
    const { violations } = scanColorSource(
      [
        ".a {",
        "  color: #fff;",
        "  background: color-mix(in srgb, var(--danger) 45%, transparent);",
        "  border-color: var(--border);",
        "  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);",
        "}",
      ].join("\n"),
    );
    expect(violations).toEqual([
      { line: 2, property: "color", values: ["#fff"] },
      { line: 5, property: "box-shadow", values: ["rgba(0, 0, 0, 0.4)"] },
    ]);
  });

  it("a lista de propriedades é RESTRITA: `white-space` não é cor (o falso positivo dos 61)", () => {
    const { violations } = scanColorSource(
      ".a {\n  white-space: nowrap;\n  background: var(--surface);\n}\n",
    );
    expect(violations).toEqual([]);
  });

  it("`transparent` e `currentColor` não são valor cru — são ausência de decisão", () => {
    const { violations } = scanColorSource(
      ".a {\n  color: currentColor;\n  background: transparent;\n}\n",
    );
    expect(violations).toEqual([]);
  });

  it("honra a escapatória auditada, e motivo em branco é violação nesta regra também", () => {
    const com = scanColorSource(
      ".a {\n  background: rgba(0, 0, 0, 0.5); /* sd:allow: backdrop do modal — overlay, não chrome */\n}\n",
    );
    expect(com.violations).toEqual([]);
    expect(com.escapes).toHaveLength(1);
    const sem = scanColorSource(".a {\n  color: #fff; /* sd:allow:   */\n}\n");
    expect(sem.escapes).toEqual([]);
    expect(sem.violations).toHaveLength(1);
  });

  it("o tree REAL está dentro da baseline de cor, com os DOIS arquivos migrados pinados em 0", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const baseline = JSON.parse(
      readFileSync(`${root}/scripts/verify/design-tokens-baseline.json`, "utf8"),
    );
    const { perFile } = scanColorRule(root);
    expect(checkAgainstBaseline(perFile, baseline.rules.color, color)).toEqual([]);
    expect(baseline.rules.color["src/renderer/src/GlobalComposer.module.css"]).toBe(0);
    expect(baseline.rules.color["src/renderer/src/TaskCard.module.css"]).toBe(0);
  });
});
