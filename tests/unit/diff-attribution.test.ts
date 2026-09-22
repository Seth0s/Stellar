import { describe, it, expect } from "vitest";
import {
  decideDiffAttribution,
  normalizeDeclaredPath,
  type AttributionReport,
  type DiffAttributionInput,
} from "../../src/main/diff-attribution";

/**
 * OS DEGRAUS DE ATRIBUIÇÃO (task 56604aca) — o que o card de diffs pode
 * afirmar, e com que força.
 *
 * O que estes testes travam: um arquivo com UM declarante diz "declarado por
 * X"; com DOIS diz DISPUTADO e lista — nunca escolhe; sem declaração, a
 * JANELA dá o intervalo e os candidatos, nunca um nome; sem nada, "não sei" —
 * e o silêncio de quem TINHA o campo ganha nome em vez de virar "não sei"
 * genérico. A árvore é compartilhada: o app observa, o autor declara.
 */

const REPO = "/repo";

function report(
  cardId: string,
  filesChanged: unknown,
  extra: Record<string, unknown> = {},
): AttributionReport {
  return {
    cardId,
    reportJson: JSON.stringify({ ok: true, filesChanged, ...extra }),
    updatedAt: 100,
  };
}

function input(over: Partial<DiffAttributionInput> = {}): DiffAttributionInput {
  return {
    repoRoot: REPO,
    paths: ["src/main/index.ts"],
    cards: [
      { cardId: "1111", label: "Spawn limpo" },
      { cardId: "2222", label: "Revisor A" },
    ],
    tasks: [],
    reports: [],
    snapshots: [],
    transitions: [],
    ...over,
  };
}

describe("normalizeDeclaredPath — o que a prosa cola no caminho", () => {
  it("aceita caminho absoluto do repo, o sufixo em prosa, ./ e :linha", () => {
    // As quatro formas medidas no banco real.
    expect(normalizeDeclaredPath("/repo/src/main/index.ts", REPO)).toBe("src/main/index.ts");
    expect(normalizeDeclaredPath("src/main/providers.ts (M, +238/-11)", REPO)).toBe(
      "src/main/providers.ts",
    );
    expect(normalizeDeclaredPath("./src/main/index.ts", REPO)).toBe("src/main/index.ts");
    expect(normalizeDeclaredPath("sessions.tsx:44", REPO)).toBe("sessions.tsx");
  });
});

describe("degrau 1 — DECLARADO, e DISPUTADO quando há mais de um", () => {
  it("um declarante: 'declarado por X'", () => {
    const out = decideDiffAttribution(input({ reports: [report("1111", ["src/main/index.ts"])] }));

    expect(out.files).toHaveLength(1);
    expect(out.files[0].state).toBe("declared");
    expect(out.files[0].disputed).toBe(false);
    expect(out.files[0].declared.map((c) => c.cardId)).toEqual(["1111"]);
    expect(out.files[0].declared[0].label).toBe("Spawn limpo");
  });

  it("dois declarantes: DISPUTADO, com a lista — nunca escolher um", () => {
    const out = decideDiffAttribution(
      input({
        reports: [
          report("1111", ["src/main/index.ts"]),
          { ...report("2222", ["src/main/index.ts"]), updatedAt: 200 },
        ],
      }),
    );

    expect(out.files[0].state).toBe("disputed");
    expect(out.files[0].disputed).toBe(true);
    // A ordem é a da declaração mais recente primeiro: quem falou por último
    // sobre o arquivo é a informação que o humano usa primeiro.
    expect(out.files[0].declared.map((c) => c.cardId).sort()).toEqual(["1111", "2222"]);
  });

  it("o MESMO card declarando em dois relatórios não vira disputa consigo mesmo", () => {
    const out = decideDiffAttribution(
      input({
        reports: [
          report("1111", ["src/main/index.ts"]),
          { ...report("1111", ["src/main/index.ts"]), updatedAt: 300 },
        ],
      }),
    );

    expect(out.files[0].disputed).toBe(false);
    expect(out.files[0].declared).toHaveLength(1);
  });
});

describe("degrau 2 — a JANELA, que é funil e nunca atribuição", () => {
  it("sem declaração: diz o intervalo e os cards com ação observada nele", () => {
    const out = decideDiffAttribution(
      input({
        reports: [report("1111", [])],
        snapshots: [
          { taskId: "t0", cardId: "2222", at: 1000, files: [] },
          { taskId: "t1", cardId: "1111", at: 1500, files: ["src/main/index.ts"] },
        ],
      }),
    );

    const file = out.files[0];
    expect(file.state).toBe("window");
    expect(file.window).toEqual({ from: 1000, to: 1500, cardIds: ["1111"] });
    // A janela nunca diz "é do card X": ela diz QUANDO apareceu e QUEM agiu.
    expect(file.declared).toEqual([]);
  });

  it("janela com vários atores devolve todos — o número de candidatos é dado", () => {
    const out = decideDiffAttribution(
      input({
        snapshots: [
          { taskId: "t0", cardId: "2222", at: 1000, files: [] },
          { taskId: "t1", cardId: "1111", at: 2000, files: ["src/main/index.ts"] },
        ],
        // O relatório DENTRO da janela (1000, 2000] conta como ação observada;
        // fora dela, não — é o que separa "agiu na janela" de "existe".
        reports: [{ ...report("2222", []), updatedAt: 1200 }],
        transitions: [{ cardId: "3333", at: 1500 }],
      }),
    );

    expect(out.files[0].window?.cardIds.sort()).toEqual(["1111", "2222", "3333"]);
  });
});

describe("degrau 3 — PISTA de prosa, que nunca vira caminho", () => {
  it("nome curto ÚNICO entre os sujos é ancorado como pista", () => {
    const out = decideDiffAttribution(
      input({
        paths: ["src/renderer/src/sessions.tsx"],
        reports: [report("1111", [], { resumo: "mexi em sessions.tsx:44" })],
      }),
    );

    expect(out.files[0].state).toBe("mention");
    expect(out.files[0].mentions).toEqual([{ cardId: "1111", label: "Spawn limpo", short: true }]);
    expect(out.files[0].declared).toEqual([]);
  });

  it("nome curto AMBÍGUO (index.ts, que existe em vários lugares) NÃO é ancorado", () => {
    const out = decideDiffAttribution(
      input({
        paths: ["src/main/index.ts", "src/preload/index.ts"],
        reports: [report("1111", [], { resumo: "mexi em index.ts" })],
      }),
    );

    expect(out.files.map((f) => f.state)).toEqual(["unknown", "unknown"]);
    expect(out.files.every((f) => f.mentions.length === 0)).toBe(true);
  });
});

describe("degrau 4 — 'não sei', e o silêncio que tem nome", () => {
  it("sem declaração, sem janela e sem menção: não sei", () => {
    const out = decideDiffAttribution(input());
    expect(out.files[0].state).toBe("unknown");
    expect(out.files[0].declared).toEqual([]);
    expect(out.files[0].window).toBeNull();
  });

  it("o card que TINHA o campo no schema e não declarou nada vira aviso, não 'não sei' genérico", () => {
    const out = decideDiffAttribution(
      input({
        reports: [report("2222", [])],
        tasks: [
          { taskId: "t1", cardId: "1111", reportSchema: ["ok", "filesChanged", "gatesOutput"] },
          { taskId: "t2", cardId: "2222", reportSchema: ["ok", "medicao"] },
        ],
      }),
    );

    // Só o card cujo schema declarava o campo: o outro não tinha como declarar.
    expect(out.silentCards.map((c) => c.cardId)).toEqual(["1111"]);
  });

  it("relatório com forma inesperada é DECLARADO, nunca pulado em silêncio", () => {
    const out = decideDiffAttribution(
      input({
        reports: [
          {
            cardId: "1111",
            reportJson: JSON.stringify(["array", "em vez de objeto"]),
            updatedAt: 1,
          },
          { cardId: "2222", reportJson: "{quebrado", updatedAt: 2 },
        ],
      }),
    );

    expect(out.unreadableReports).toEqual([
      { cardId: "1111", shape: "array" },
      { cardId: "2222", shape: "json inválido" },
    ]);
  });
});
