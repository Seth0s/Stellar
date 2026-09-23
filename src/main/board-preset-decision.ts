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
  docsPath?: string;
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
      ...(typeof p.docsPath === "string" ? { docsPath: p.docsPath } : {}),
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
