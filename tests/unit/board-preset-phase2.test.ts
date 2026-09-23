import { describe, it, expect } from "vitest";
import {
  EMPTY_BOARD_TASK_DEFAULTS,
  boardTaskDefaultsToSql,
  diffPreset,
  matchPreset,
  parseBoardTaskDefaultsInput,
  parsePresets,
  presetSettingsFromBoard,
  readBoardTaskDefaults,
  resolveTaskDefaultsFromBoard,
  type BoardPresetSettings,
} from "../../src/main/board-preset-decision";
import presetsJson from "../../src/main/data/board-presets.json";

/**
 * BOARD PRESETS — FASE 2 (task 83f4cfa3, continuação de 094332f).
 *
 * A fase 1 deixou o preset como DADO e a decisão pura de comparar/descrever.
 * A fase 2 é o que faltava para o preset ser utilizável:
 *   a) as três colunas que NÃO existiam por board — `default_review`,
 *      `default_report_schema_json`, `default_allow_commit` (medido: só
 *      existiam por TASK; grep de `default_review|boardDefaults` em src/main
 *      não devolvia nada antes desta fase);
 *   b) o board DE VERDADE virar `BoardPresetSettings` — sem inventar: um cap
 *      `null` significa "usa o default do app", então ele é RESOLVIDO para o
 *      preset poder ser comparado (senão um board recém-criado apareceria como
 *      `custom` para sempre);
 *   c) quando a chamada de `create_task` OMITE review/reportSchema/allowCommit,
 *      o default do board vale E A RESPOSTA DIZ ISSO (o pedido é honestidade
 *      com o agente, não mágica); valor explícito sempre ganha.
 *
 * O que estes testes travam:
 *   1. IDA E VOLTA da coluna (encode/decode) — é o que faz o default ser DADO
 *      persistido, e não um literal em código;
 *   2. DEFAULT NUNCA atropela EXPLÍCITO, e a lista `applied` diz exatamente
 *      quais campos vieram do board (um board sem defaults é a regressão: o
 *      comportamento de hoje não muda NEM UM BYTE);
 *   3. o custo do "Máximo" é dito SEM NÚMERO INVENTADO — a página dos três
 *      jeitos é o link, e nenhum número de token nasce aqui;
 *   4. `matchPreset` continua sem reivindicar preset que os ajustes não
 *      satisfazem (a fase 1 travou isso; aqui a fase 2 prova que a LEITURA do
 *      board real, com o cap resolvido, alimenta essa decisão).
 */

const PRESETS = parsePresets(presetsJson);
const APP_DEFAULT_CAP = 3;

function boardSettings(over: Partial<BoardPresetSettings> = {}): BoardPresetSettings {
  return {
    autonomous: false,
    concurrencyCap: APP_DEFAULT_CAP,
    defaultReview: null,
    defaultReportSchema: null,
    defaultAllowCommit: null,
    ...over,
  };
}

describe("o dado do preset, na fase 2", () => {
  it("'Máximo' carrega o cap PLACEHOLDER (8) e DIZ que é placeholder", () => {
    const maximo = PRESETS.find((p) => p.id === "maximo")!;
    // O dono ainda não decidiu; o valor de hoje (3, o default do app) era MENOR
    // que o do 'Produtivo' (5), o que contradizia o próprio nome do modo. O
    // valor está marcado como provisório NO DADO, não num comentário de código.
    expect(maximo.settings.concurrencyCap).toBe(8);
    expect(maximo.source).toMatch(/placeholder/i);
    expect(maximo.source).toMatch(/owner/i);
  });

  it("o link da doc é absoluto e aponta para a página dos três jeitos", () => {
    const maximo = PRESETS.find((p) => p.id === "maximo")!;
    expect(maximo.docsUrl).toBe("https://stellar.idyplatform.com/docs/tres-jeitos-de-trabalhar/");
  });

  it("o custo do 'Máximo' não inventa número: é texto + link da doc", () => {
    const maximo = PRESETS.find((p) => p.id === "maximo")!;
    // Nenhum número de token/dólar nasce aqui — o que o dono não decidiu, a UI
    // não afirma. (O 'Produtivo' cita "5 agentes" porque ESSE número vem da doc;
    // a regra é não inventar, não fingir que número nenhum existe.)
    expect(maximo.costNotice).not.toMatch(/[0-9]/);
    expect(maximo.docsUrl).toBeTruthy();
  });

  it("nenhum preset impõe reportSchema (a doc manda contrato proporcional ao risco)", () => {
    for (const preset of PRESETS) {
      expect(preset.settings.defaultReportSchema).toBeNull();
    }
  });
});

describe("as três colunas novas: ida e volta (encode/decode)", () => {
  it("ida e volta preserva os três campos", () => {
    const defaults = { review: "wanted" as const, reportSchema: ["filesChanged", "evidence"], allowCommit: false };
    const sql = boardTaskDefaultsToSql(defaults);
    expect(sql.default_review).toBe("wanted");
    expect(sql.default_report_schema_json).toBe('["filesChanged","evidence"]');
    // `false` é uma DECISÃO e precisa sobreviver como 0 — nunca como null
    // (o `null` significa "não declarado", que é outra coisa).
    expect(sql.default_allow_commit).toBe(0);
    expect(
      readBoardTaskDefaults({
        default_review: sql.default_review,
        default_report_schema_json: sql.default_report_schema_json,
        default_allow_commit: sql.default_allow_commit,
      }),
    ).toEqual(defaults);
  });

  it("um board que nunca teve defaults (colunas NULL) lê como vazio, sem backfill", () => {
    expect(readBoardTaskDefaults({})).toEqual(EMPTY_BOARD_TASK_DEFAULTS);
    expect(
      readBoardTaskDefaults({ default_review: null, default_report_schema_json: null, default_allow_commit: null }),
    ).toEqual(EMPTY_BOARD_TASK_DEFAULTS);
  });

  it("JSON corrompido não derruba nada: vira vazio (esta leitura roda no caminho do create_task)", () => {
    expect(readBoardTaskDefaults({ default_report_schema_json: "{isso não é json" }).reportSchema).toBeNull();
    // Escrita inválida também não passa: string vazia / item vazio não viram schema.
    expect(readBoardTaskDefaults({ default_report_schema_json: '["ok",""]' }).reportSchema).toBeNull();
    expect(readBoardTaskDefaults({ default_allow_commit: 7 }).allowCommit).toBeNull();
    expect(readBoardTaskDefaults({ default_review: "talvez" }).review).toBeNull();
  });

  it("a escrita valida a forma e RECUSA em vez de gravar lixo", () => {
    const ok = parseBoardTaskDefaultsInput({ review: "wanted", reportSchema: ["ok"], allowCommit: true });
    expect(ok).toEqual({ ok: true, defaults: { review: "wanted", reportSchema: ["ok"], allowCommit: true } });

    expect(parseBoardTaskDefaultsInput({ review: "sim" })).toMatchObject({ ok: false, field: "review" });
    expect(parseBoardTaskDefaultsInput({ reportSchema: [1] })).toMatchObject({ ok: false, field: "reportSchema" });
    expect(parseBoardTaskDefaultsInput({ allowCommit: "false" })).toMatchObject({ ok: false, field: "allowCommit" });
    // Ausente é NORMAL: limpar os três é escrita legítima.
    expect(parseBoardTaskDefaultsInput({})).toEqual({ ok: true, defaults: EMPTY_BOARD_TASK_DEFAULTS });
  });
});

describe("o board de verdade vira ajustes de preset (cap resolvido, nunca adivinhado)", () => {
  const emptyBoard = {
    autonomous: false,
    concurrency_cap: null,
    default_review: null,
    default_report_schema_json: null,
    default_allow_commit: null,
  };

  it("cap NULL é o default do app, não 'custom'", () => {
    expect(presetSettingsFromBoard(emptyBoard, APP_DEFAULT_CAP).concurrencyCap).toBe(APP_DEFAULT_CAP);
  });

  it("um board recém-criado (tudo vazio) não casa preset nenhum — é custom, honestamente", () => {
    expect(matchPreset(presetSettingsFromBoard(emptyBoard, APP_DEFAULT_CAP), PRESETS)).toEqual({ id: "custom" });
  });

  it("depois de aplicar um preset, o MESMO board lê como aquele preset", () => {
    const eficiente = PRESETS.find((p) => p.id === "eficiente")!;
    const settings = presetSettingsFromBoard(
      {
        autonomous: eficiente.settings.autonomous,
        concurrency_cap: eficiente.settings.concurrencyCap,
        default_review: eficiente.settings.defaultReview,
        default_report_schema_json: null,
        // Lido do BANCO: 0/1, não `false`/`true` (é o defeito clássico de ler a
        // coluna crua e concluir que o preset não casa).
        default_allow_commit: eficiente.settings.defaultAllowCommit ? 1 : 0,
      },
      APP_DEFAULT_CAP,
    );
    expect(matchPreset(settings, PRESETS).id).toBe("eficiente");
    // E mexer UM ajuste depois já é custom.
    expect(matchPreset({ ...settings, concurrencyCap: 7 }, PRESETS)).toEqual({ id: "custom" });
  });
});


describe("o default do board num create_task que OMITE os campos", () => {
  const board = { review: "wanted" as const, reportSchema: ["filesChanged", "evidence"], allowCommit: false };

  it("omissão recebe o default e a lista `applied` nomeia EXATAMENTE o que veio do board", () => {
    const out = resolveTaskDefaultsFromBoard({ request: {}, board, boardId: "118" });
    expect(out.review).toBe("wanted");
    expect(out.reportSchema).toEqual(["filesChanged", "evidence"]);
    expect(out.allowCommit).toBe(false);
    expect(out.applied).toEqual(["review", "reportSchema", "allowCommit"]);
    expect(out.values).toEqual({ review: "wanted", reportSchema: ["filesChanged", "evidence"], allowCommit: false });
  });

  it("a nota é AGENT-FACING: inglês, nomeia o board e o que foi aplicado", () => {
    const out = resolveTaskDefaultsFromBoard({ request: {}, board, boardId: "118" });
    expect(out.note).toMatch(/board "118"/);
    expect(out.note).toMatch(/default/i);
    expect(out.note).not.toMatch(/[ãõçáéíóú]/);
    expect(out.note).toMatch(/Existing tasks/i);
    expect(out.note).toMatch(/untouched/);
  });

  it("valor EXPLÍCITO sempre ganha — e não é anunciado como default do board", () => {
    const out = resolveTaskDefaultsFromBoard({
      request: { reportSchema: ["ok"], allowCommit: true },
      board,
      boardId: "118",
    });
    expect(out.reportSchema).toEqual(["ok"]);
    expect(out.allowCommit).toBe(true);
    expect(out.applied).toEqual(["review"]);
    expect(out.values).toEqual({ review: "wanted" });
    expect(out.note).toMatch(/review/);
    expect(out.note).not.toMatch(/reportSchema/);
  });

  it("`null` explícito também ganha: limpar não é omitir", () => {
    const out = resolveTaskDefaultsFromBoard({ request: { allowCommit: null }, board, boardId: "118" });
    expect(out.allowCommit).toBeNull();
    expect(out.applied).not.toContain("allowCommit");
  });

  it("board SEM defaults: comportamento de hoje, byte a byte (a regressão)", () => {
    const out = resolveTaskDefaultsFromBoard({ request: {}, board: EMPTY_BOARD_TASK_DEFAULTS, boardId: "118" });
    expect(out.review).toBeUndefined();
    expect(out.reportSchema).toBeUndefined();
    expect(out.allowCommit).toBeUndefined();
    expect(out.applied).toEqual([]);
    expect(out.note).toBeNull();

    // board inexistente/indefinido é a MESMA coisa que board vazio — nunca um
    // erro no caminho quente do create_task.
    expect(resolveTaskDefaultsFromBoard({ request: {}, board: undefined, boardId: null }).applied).toEqual([]);
  });
});

describe("a UI mostra o diff ANTES de aplicar", () => {
  it("aplicar 'Máximo' num board vazio lista as mudanças que a UI vai mostrar", () => {
    const maximo = PRESETS.find((p) => p.id === "maximo")!;
    const changes = diffPreset(boardSettings(), maximo.settings);
    expect(changes.map((c) => c.setting).sort()).toEqual([
      "autonomous",
      "concurrencyCap",
      "defaultAllowCommit",
      "defaultReview",
    ]);
    // Antes/depois declarados — é disso que o texto "isto vai mudar" é feito.
    expect(changes.find((c) => c.setting === "concurrencyCap")).toEqual({
      setting: "concurrencyCap",
      from: APP_DEFAULT_CAP,
      to: 8,
    });
  });

  it("board que já está no preset não tem nada a escrever (aplicar não mente)", () => {
    const eficiente = PRESETS.find((p) => p.id === "eficiente")!;
    expect(diffPreset(eficiente.settings, eficiente.settings)).toEqual([]);
  });
});
