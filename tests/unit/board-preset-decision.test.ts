import { describe, it, expect } from "vitest";
import {
  diffPreset,
  matchPreset,
  parsePresets,
  type BoardPresetSettings,
} from "../../src/main/board-preset-decision";
import presetsJson from "../../src/main/data/board-presets.json";

/**
 * BOARD PRESETS COMO CONFIGURAÇÃO (task 83f4cfa3, aprovada pelo dono).
 *
 * A página "Três jeitos de trabalhar" descreve três modos; hoje cada um é um
 * conjunto de ajustes que o usuário monta À MÃO (modo autônomo, cap de
 * concorrência, default de review, de reportSchema, de allowCommit, e o bloco de
 * contexto do board). Um preset aplica esse conjunto numa ação e DIZ o que
 * mudou.
 *
 * As três regras que estes testes travam, todas do enunciado:
 *   1. o preset é DADO (lista declarada de ajustes), não um caminho de código por
 *      preset;
 *   2. aplicar NUNCA toca card em execução nem task existente — só defaults do
 *      que vem a seguir;
 *   3. a UI mostra o preset que o board "casa", ou `custom` — NUNCA um preset que
 *      os ajustes já não satisfazem.
 */

const PRESETS = parsePresets(presetsJson);

const EFICIENTE: BoardPresetSettings = {
  autonomous: false,
  concurrencyCap: 1,
  defaultReview: null,
  defaultReportSchema: null,
  defaultAllowCommit: false,
};

function board(over: Partial<BoardPresetSettings> = {}): BoardPresetSettings {
  return { ...EFICIENTE, ...over };
}

describe("os presets são DADO (e ancorados na doc, não inventados)", () => {
  it("carrega os três modos, com os ajustes declarados", () => {
    expect(PRESETS.map((p) => p.id).sort()).toEqual(["eficiente", "maximo", "produtivo"]);
    for (const preset of PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      // Cada valor diz DE ONDE veio: a página dos três jeitos, ou um default do app.
      expect(preset.source).toMatch(/doc|DEFAULT_CONCURRENCY_CAP/);
      // O custo é dito com link da doc, não com número inventado.
      expect(preset.costNotice.length).toBeGreaterThan(0);
    }
  });

  it("'Máximo' é o ÚNICO que pede revisor por task, e o doc diz isso", () => {
    const maximo = PRESETS.find((p) => p.id === "maximo")!;
    const produtivo = PRESETS.find((p) => p.id === "produtivo")!;
    expect(maximo.settings.defaultReview).toBe("wanted");
    // A doc manda revisão PROPORCIONAL ao risco no Produtivo: um default
    // uniforme contradiria a própria doc.
    expect(produtivo.settings.defaultReview).toBeNull();
  });

  it("Eficiente não é autônomo e tem cap 1 (um agente, sem Fila)", () => {
    const eficiente = PRESETS.find((p) => p.id === "eficiente")!;
    expect(eficiente.settings.autonomous).toBe(false);
    expect(eficiente.settings.concurrencyCap).toBe(1);
  });
});

describe("diffPreset — aplicar DIZ o que mudou", () => {
  it("lista só o que muda, com o valor de antes e o de depois", () => {
    const changes = diffPreset(board({ autonomous: true, concurrencyCap: 4 }), EFICIENTE);
    expect(changes.map((c) => c.setting).sort()).toEqual(["autonomous", "concurrencyCap"]);
    expect(changes.find((c) => c.setting === "autonomous")).toMatchObject({ from: true, to: false });
    expect(changes.find((c) => c.setting === "concurrencyCap")).toMatchObject({ from: 4, to: 1 });
  });

  it("board que já está no preset não muda nada (sem lista de mudanças fantasma)", () => {
    expect(diffPreset(board(), EFICIENTE)).toEqual([]);
  });

  it("reportSchema é comparado por CONTEÚDO, não por identidade de array", () => {
    const a = board({ defaultReportSchema: ["ok", "files"] });
    expect(diffPreset(a, { ...EFICIENTE, defaultReportSchema: ["ok", "files"] })).toEqual([]);
    expect(diffPreset(a, { ...EFICIENTE, defaultReportSchema: ["ok"] }).map((c) => c.setting)).toEqual([
      "defaultReportSchema",
    ]);
  });
});

describe("matchPreset — nunca reivindica um preset que os ajustes não satisfazem", () => {
  it("ajustes iguais ao preset -> aquele preset", () => {
    expect(matchPreset(board(), PRESETS)).toMatchObject({ id: "eficiente" });
  });

  it("um ajuste fora do preset -> custom, mesmo parecendo", () => {
    // O caso que o enunciado proíbe: dizer "Produtivo" quando o cap foi mexido.
    const produtivo = PRESETS.find((p) => p.id === "produtivo")!;
    const current = { ...produtivo.settings, concurrencyCap: 9 };
    expect(matchPreset(current, PRESETS)).toEqual({ id: "custom" });
  });

  it("board sem ajustes definidos (defaults do app) casa com o preset que descreve um agente só", () => {
    expect(matchPreset(EFICIENTE, PRESETS).id).toBe("eficiente");
  });
});
