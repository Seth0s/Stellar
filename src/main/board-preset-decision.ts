/**
 * BOARD PRESETS COMO CONFIGURAÇÃO (task 83f4cfa3, aprovada pelo dono).
 *
 * A página "Três jeitos de trabalhar" descreve três modos de operação. Hoje cada
 * um é um conjunto de ajustes que o usuário monta À MÃO: modo autônomo, cap de
 * concorrência, default de `review`, de `reportSchema`, de `allowCommit` — e o
 * bloco de contexto do board (`board-context.ts`). Um preset aplica o conjunto
 * numa ação DIZENDO o que mudou.
 *
 * As regras que o módulo encarna, todas do enunciado:
 *   1. preset é DADO (`data/board-presets.json`), não um caminho de código por
 *      preset — este arquivo não conhece "eficiente" nem "máximo"; ele sabe
 *      comparar e descrever diferenças;
 *   2. aplicar escreve os MESMOS ajustes que o usuário poderia escrever à mão:
 *      por isso `diffPreset` devolve a lista de mudanças (a UI diz o que mudou,
 *      não um "pronto!"), e nada aqui toca card em execução ou task existente —
 *      o efeito é só sobre o que vem a seguir, e quem escreve é o chamador;
 *   3. `matchPreset` NUNCA reivindica um preset que os ajustes já não satisfazem:
 *      um único campo divergente devolve `custom`.
 *
 * O que este módulo NÃO faz: ler/escrever storage, IPC, UI. Ele é a decisão pura
 * que a UI e o store vão usar.
 */

// O formato de `default_report_schema_json` / `default_allow_commit` é o MESMO
// do contrato da task (`task-contract-decision.ts`), e de propósito: um default
// de board e um contrato declarado na mão precisam ser lidos pela mesma função,
// senão a coluna vira um dialeto. Aquele módulo não importa nada (nem `node:*`),
// então trazer três funções de lá não arrasta nada para o bundle do renderer —
// que importa ESTE arquivo para desenhar o diff.
import { allowCommitFromSql, allowCommitToSql, normalizeAllowCommit, normalizeStringList, reportSchemaFromSql, reportSchemaToSql } from "./task-contract-decision";

export type BoardPresetSettings = {
  autonomous: boolean;
  concurrencyCap: number;
  defaultReview: "wanted" | null;
  /** Forma do relatório por default do board. `null` = "o contrato decide" —
   *  nenhum preset impõe forma, porque a doc manda revisão e contrato
   *  proporcionais ao risco. */
  defaultReportSchema: string[] | null;
  defaultAllowCommit: boolean | null;
};

export type BoardPreset = {
  id: string;
  label: string;
  summary: string;
  settings: BoardPresetSettings;
  /** De onde cada valor veio (a doc, ou um default do próprio app). */
  source: string;
  costNotice: string;
  /** Página dos três jeitos (URL ABSOLUTA desde a fase 2 — a UI precisa abrir
   *  o link; o custo é dito com link, nunca com um número inventado aqui). */
  docsUrl?: string;
};

export type PresetChange = {
  setting: keyof BoardPresetSettings;
  from: BoardPresetSettings[keyof BoardPresetSettings];
  to: BoardPresetSettings[keyof BoardPresetSettings];
};

const KEYS: Array<keyof BoardPresetSettings> = [
  "autonomous",
  "concurrencyCap",
  "defaultReview",
  "defaultReportSchema",
  "defaultAllowCommit",
];

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

function asSettings(raw: unknown): BoardPresetSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.autonomous !== "boolean") return null;
  if (typeof s.concurrencyCap !== "number") return null;
  const review = s.defaultReview === "wanted" ? "wanted" : null;
  const schema = Array.isArray(s.defaultReportSchema)
    ? s.defaultReportSchema.filter((item): item is string => typeof item === "string")
    : null;
  const allowCommit = typeof s.defaultAllowCommit === "boolean" ? s.defaultAllowCommit : null;
  return {
    autonomous: s.autonomous,
    concurrencyCap: s.concurrencyCap,
    defaultReview: review,
    defaultReportSchema: schema,
    defaultAllowCommit: allowCommit,
  };
}

/** Tolerante por contrato: um preset malformado é DESCARTADO, não quebra a lista. */
export function parsePresets(raw: unknown): BoardPreset[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { presets?: unknown }).presets;
  if (!Array.isArray(list)) return [];
  const out: BoardPreset[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    const settings = asSettings(p.settings);
    if (typeof p.id !== "string" || typeof p.label !== "string" || settings === null) continue;
    out.push({
      id: p.id,
      label: p.label,
      summary: typeof p.summary === "string" ? p.summary : "",
      settings,
      source: typeof p.source === "string" ? p.source : "",
      costNotice: typeof p.costNotice === "string" ? p.costNotice : "",
      ...(typeof p.docsUrl === "string" ? { docsUrl: p.docsUrl } : {}),
    });
  }
  return out;
}

/**
 * O que MUDARIA ao aplicar o preset — a lista que a UI mostra. Vazio significa
 * "o board já está assim" (e aí aplicar não escreve nada, em vez de escrever os
 * mesmos valores e dizer que mexeu).
 */
export function diffPreset(
  current: BoardPresetSettings,
  preset: BoardPresetSettings,
): PresetChange[] {
  const changes: PresetChange[] = [];
  for (const key of KEYS) {
    if (!sameValue(current[key], preset[key])) {
      changes.push({ setting: key, from: current[key], to: preset[key] });
    }
  }
  return changes;
}

/**
 * O preset que o board "casa", ou `custom`. Comparação exata em TODOS os
 * ajustes: um campo divergente já é `custom` — a UI não pode dizer "Produtivo"
 * para um board cujo cap foi mexido depois.
 */
export function matchPreset(
  current: BoardPresetSettings,
  presets: readonly BoardPreset[],
): BoardPreset | { id: "custom" } {
  for (const preset of presets) {
    if (diffPreset(current, preset.settings).length === 0) return preset;
  }
  return { id: "custom" };
}

/* ================== FASE 2: os defaults DO BOARD ==================
 *
 * A fase 1 deixou o preset como dado e a comparação pura. O que faltava — e o
 * que a medição de 2026-09-23 achou — era o LUGAR onde três desses ajustes
 * moram: modo autônomo e cap já eram colunas de `boards`, mas `review`,
 * `reportSchema` e `allowCommit` só existiam por TASK. Sem isso, um preset não
 * tinha onde ser aplicado e o "default do board" era uma frase vazia.
 *
 * As três colunas nascem NULAS e sem backfill: `null` aqui significa NÃO
 * DECLARADO, nunca "decidido: não". É a mesma convenção de
 * `tasks.allow_commit` e `boards.concurrency_cap`, e a razão é prática: um
 * board que já existia não pode receber um contrato que ninguém escolheu.
 */

/** Os três defaults de TASK que um board pode declarar. */
export type BoardTaskDefaults = {
  /** `"wanted"` = toda task nova pede revisor; `null` = não declarado. */
  review: "wanted" | null;
  /** Chaves exigidas no relatório de toda task nova; `null` = o contrato decide. */
  reportSchema: string[] | null;
  /** `false` = não commitar; `true` = permitido; `null` = não declarado. */
  allowCommit: boolean | null;
};

export const EMPTY_BOARD_TASK_DEFAULTS: BoardTaskDefaults = {
  review: null,
  reportSchema: null,
  allowCommit: null,
};

/** Colunas cruas de `boards` (`default_*`) → forma de domínio. Tolerante de
 *  propósito: isto é lido no caminho QUENTE do `create_task`, e um JSON
 *  corrompido ali derrubaria a criação de task em vez de só não ter default. */
export function readBoardTaskDefaults(row: {
  default_review?: unknown;
  default_report_schema_json?: unknown;
  default_allow_commit?: unknown;
}): BoardTaskDefaults {
  return {
    review: row.default_review === "wanted" ? "wanted" : null,
    reportSchema: reportSchemaFromSql(
      typeof row.default_report_schema_json === "string" ? row.default_report_schema_json : null,
    ),
    allowCommit: allowCommitFromSql(typeof row.default_allow_commit === "number" ? row.default_allow_commit : null),
  };
}

/** Domínio → colunas. `false` vira 0 e sobrevive como DECISÃO; `null` continua
 *  sendo "não declarado" (é a diferença que o `allowCommit` do contrato já
 *  declara: `false` = não commitar, `null` = não é uma permissão). */
export function boardTaskDefaultsToSql(defaults: BoardTaskDefaults): {
  default_review: string | null;
  default_report_schema_json: string | null;
  default_allow_commit: number | null;
} {
  return {
    default_review: defaults.review,
    default_report_schema_json: reportSchemaToSql(defaults.reportSchema),
    default_allow_commit: allowCommitToSql(defaults.allowCommit),
  };
}

export type BoardTaskDefaultsParse =
  | { ok: true; defaults: BoardTaskDefaults }
  | { ok: false; field: "review" | "reportSchema" | "allowCommit"; error: string };

/**
 * Valida a ESCRITA (a UI, e só ela, escreve isto). Mesma postura do contrato da
 * task: forma desconhecida é RECUSADA, nunca coagida para `null` — gravar lixo
 * num default que passa a valer para toda task nova é pior que recusar.
 * Ausente é normal: `{}` limpa os três.
 */
export function parseBoardTaskDefaultsInput(raw: {
  review?: unknown;
  reportSchema?: unknown;
  allowCommit?: unknown;
}): BoardTaskDefaultsParse {
  const defaults: BoardTaskDefaults = { ...EMPTY_BOARD_TASK_DEFAULTS };

  if (raw.review !== undefined && raw.review !== null) {
    if (raw.review !== "wanted") {
      return {
        ok: false,
        field: "review",
        error: `review must be "wanted" (or null/omitted to clear), got ${JSON.stringify(raw.review)}`,
      };
    }
    defaults.review = "wanted";
  }

  if (raw.reportSchema !== undefined && raw.reportSchema !== null) {
    const list = normalizeStringList(raw.reportSchema);
    if (list === null) {
      return {
        ok: false,
        field: "reportSchema",
        error: "reportSchema must be an array of non-empty strings (or null/omitted to clear)",
      };
    }
    defaults.reportSchema = list;
  }

  if (raw.allowCommit !== undefined && raw.allowCommit !== null) {
    const flag = normalizeAllowCommit(raw.allowCommit);
    if (flag === null) {
      return { ok: false, field: "allowCommit", error: "allowCommit must be a boolean (or null/omitted to clear)" };
    }
    defaults.allowCommit = flag;
  }

  return { ok: true, defaults };
}

/**
 * O board REAL como ajustes de preset — o que a UI compara.
 *
 * `concurrency_cap` nulo é resolvido para o default do APP, e não deixado nulo:
 * `null` significa literalmente "usa o default" (o comentário da coluna diz
 * isso desde que ela nasceu), então um board recém-criado JÁ está em 3 agentes.
 * Tratá-lo como valor próprio faria a UI dizer "custom" para sempre num board
 * que nunca foi mexido — a mentira que a fase 1 proibiu.
 *
 * O default do app entra por PARÂMETRO (não como constante aqui): quem chama é
 * que sabe qual é (main: o mesmo de `message-bus.ts`; renderer: o mesmo que a
 * Fila já usa para desenhar o WIP).
 */
export function presetSettingsFromBoard(
  board: {
    autonomous: boolean | number;
    concurrency_cap: number | null;
    default_review?: unknown;
    default_report_schema_json?: unknown;
    default_allow_commit?: unknown;
  },
  appDefaultConcurrencyCap: number,
): BoardPresetSettings {
  const defaults = readBoardTaskDefaults(board);
  return {
    autonomous: board.autonomous === true || board.autonomous === 1,
    concurrencyCap: board.concurrency_cap ?? appDefaultConcurrencyCap,
    defaultReview: defaults.review,
    defaultReportSchema: defaults.reportSchema,
    defaultAllowCommit: defaults.allowCommit,
  };
}

export type TaskDefaultsField = "review" | "reportSchema" | "allowCommit";

export type TaskDefaultsResolution = {
  /** Valor efetivo para cada campo: o que a chamada mandou, ou o default do
   *  board. `undefined` significa "nem um nem outro" — ausente, como hoje. */
  review: unknown;
  reportSchema: unknown;
  allowCommit: unknown;
  /** QUAIS campos vieram do board — é o que a resposta anuncia. */
  applied: TaskDefaultsField[];
  values: Partial<BoardTaskDefaults>;
  /** Texto AGENT-FACING (inglês) quando algo veio do board; `null` quando nada
   *  veio (a resposta de hoje, sem chave nova). */
  note: string | null;
};

/**
 * O fallback do `create_task`: campo OMITIDO recebe o default do board; campo
 * presente — inclusive `null` explícito — ganha sempre.
 *
 * `undefined` é a única ausência. Isto não é detalhe: `allowCommit: null` numa
 * chamada é uma DECISÃO ("não declaro permissão de commit"), e trocá-la pelo
 * default do board seria o app respondendo por quem falou. Omitir é o que não
 * fala nada — e é só aí que o board responde.
 *
 * Nada aqui toca task existente nem card em execução: a resolução desemboca na
 * linha que está NASCENDO (o `create_task` inteiro é uma criação).
 */
export function resolveTaskDefaultsFromBoard(input: {
  request: { review?: unknown; reportSchema?: unknown; allowCommit?: unknown };
  board: BoardTaskDefaults | null | undefined;
  boardId?: string | null;
}): TaskDefaultsResolution {
  const board = input.board ?? EMPTY_BOARD_TASK_DEFAULTS;
  const applied: TaskDefaultsField[] = [];
  const values: Partial<BoardTaskDefaults> = {};

  /** Presente (mesmo `null`) ganha; ausente cai no default, se houver. */
  function effective<T>(requested: unknown, fallback: T | null): unknown {
    if (requested !== undefined) return requested;
    return fallback === null ? undefined : fallback;
  }

  const review = effective(input.request.review, board.review);
  if (input.request.review === undefined && board.review !== null) {
    applied.push("review");
    values.review = board.review;
  }
  const reportSchema = effective(input.request.reportSchema, board.reportSchema);
  if (input.request.reportSchema === undefined && board.reportSchema !== null) {
    applied.push("reportSchema");
    values.reportSchema = board.reportSchema;
  }
  const allowCommit = effective(input.request.allowCommit, board.allowCommit);
  if (input.request.allowCommit === undefined && board.allowCommit !== null) {
    applied.push("allowCommit");
    values.allowCommit = board.allowCommit;
  }

  return {
    review,
    reportSchema,
    allowCommit,
    applied,
    values,
    note: applied.length > 0 ? describeBoardDefaultsApplied(applied, input.boardId ?? null) : null,
  };
}

/**
 * A frase que o AGENTE lê na resposta. Inglês de propósito (ver
 * `shared/i18n/agent-facing.ts`): traduzir mudaria o comportamento de quem lê.
 *
 * Ela diz três coisas e não quatro: o que foi aplicado, de ONDE veio, e como
 * sobrepor. O "vale só para o que vem depois" é dito porque é a promessa que a
 * UI faz ao humano — o agente precisa da mesma, senão supõe que mexeu em algo
 * que já existe.
 */
export function describeBoardDefaultsApplied(applied: readonly TaskDefaultsField[], boardId: string | null): string {
  const where = boardId ? `board "${boardId}"'s defaults` : "the board's defaults";
  return (
    `${applied.join(", ")} were omitted from this create_task and taken from ${where} (set in the board's settings, not by this call). ` +
    `Pass an explicit value to override it. Existing tasks and running cards are untouched — a board default only applies to what is created after it.`
  );
}
