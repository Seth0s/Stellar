/**
 * QUEM DECLAROU CADA ARQUIVO — os degraus de confiança, puros e testáveis
 * (task 56604aca, desenho aprovado).
 *
 * O QUE ESTE MÓDULO NÃO FAZ, e é a razão de existir: atribuir HUNK. Medido
 * antes de desenhar — a única evidência hunk-level que o app captura (o patch
 * do gate) era a cauda do diff e nunca continha `src/main/*` (zero cabeçalhos
 * em 29 patches), então hunk não é derivável e não vira rótulo aqui. O que
 * sobra é honesto: ARQUIVO + declaração + janela, cada um com a força dita.
 *
 * OS DEGRAUS, e o que sustenta cada um (a ordem é a de confiança):
 *
 *   1. DECLARADO — o card escreveu o caminho no `filesChanged` do relatório.
 *      UM card = "declarado por X". DOIS ou mais = DISPUTADO, e a lista sai
 *      inteira: escolher um seria palpite. A árvore é compartilhada; a
 *      declaração é do autor, nunca verificada pelo app.
 *   2. JANELA — o arquivo apareceu sujo entre dois snapshots do gate
 *      (`result_json.gateRun.diff.files`, que NÃO é truncado). Os candidatos
 *      são os cards com AÇÃO OBSERVADA na janela (relatório, transição ou o
 *      próprio snapshot). Medido no board do dono: a janela NUNCA estreita
 *      para um candidato (2, 5, 7 ou 8) — por isso ela é FUNIL e a tela diz
 *      "apareceu entre T1 e T2", nunca "é do card X".
 *   3. PISTA — menção em PROSA. Não vira caminho: medido, 78% dos caminhos
 *      citados em prosa NÃO foram declarados como mudados por aquele mesmo
 *      card (são leituras e referências). Nome curto (`sessions.tsx`) só
 *      resolve quando é ÚNICO entre os arquivos sujos — `index.ts` nunca
 *      resolve, porque há vários.
 *   4. NÃO SEI — sem declaração e sem janela. E dizer POR QUE muda o valor:
 *      "ninguém declarou (o card tinha o campo)" é diferente de "não dava
 *      para saber" — o primeiro tem nome (`silentCards`).
 *
 * TERRITÓRIO DECLARADO não entra em conta nenhuma aqui: medido, 75,5% dos
 * arquivos declarados caem FORA dele, então ele é intenção do começo, não
 * descrição do que houve.
 */

/** Um card que pode ter tocado o repositório (escopo por `cwd`, medido). */
export type AttributionCard = { cardId: string; label: string | null };

/** A task dá duas coisas: o vínculo com o card e o SCHEMA declarado — é dele
 * que sai o sinal de sub-declaração. */
export type AttributionTask = {
  taskId: string;
  cardId: string | null;
  /** O `reportSchema` da task. `filesChanged` presente = o card TINHA o campo. */
  reportSchema: readonly string[] | null;
};

export type AttributionReport = {
  cardId: string;
  /** O `report_json` cru — o módulo extrai `filesChanged` e as menções. */
  reportJson: string;
  updatedAt: number;
};

/** Um snapshot do gate: o que estava sujo no checkout naquele instante. */
export type AttributionSnapshot = {
  taskId: string;
  cardId: string | null;
  at: number;
  files: readonly string[];
};

/** Transição de task: a outra ação OBSERVADA que nomeia um card num instante. */
export type AttributionTransition = { cardId: string | null; at: number };

export type DiffAttributionInput = {
  /** A raiz do repositório — para relativizar caminho absoluto declarado. */
  repoRoot: string;
  /** Os caminhos sujos AGORA (do `git status`). */
  paths: readonly string[];
  cards: readonly AttributionCard[];
  tasks: readonly AttributionTask[];
  reports: readonly AttributionReport[];
  snapshots: readonly AttributionSnapshot[];
  transitions: readonly AttributionTransition[];
};

export type DeclaredCandidate = { cardId: string; label: string | null; updatedAt: number };

export type WindowEvidence = {
  from: number;
  to: number;
  /** Cards com AÇÃO OBSERVADA na janela. Vazio = a janela é larga demais para
   * apontar alguém (acontece: medido um buraco de 674 minutos sem snapshot). */
  cardIds: string[];
};

export type PathMention = { cardId: string; label: string | null; short: boolean };

export type FileAttribution = {
  path: string;
  declared: DeclaredCandidate[];
  /** `declared.length > 1` — o aviso é o produto: a tela lista, não escolhe. */
  disputed: boolean;
  window: WindowEvidence | null;
  /** Menções em prosa que o normalizador conseguiu ancorar neste caminho. */
  mentions: PathMention[];
  state: "declared" | "disputed" | "window" | "mention" | "unknown";
};

export type DiffAttribution = {
  files: FileAttribution[];
  /** Cards que TINHAM `filesChanged` no schema e não declararam arquivo nenhum:
   * o silêncio ganha nome, em vez de virar "não sei" genérico. */
  silentCards: AttributionCard[];
  /** Declarações que não puderam ser lidas (relatório que é ARRAY ou STRING em
   * vez de objeto): DECLARADO, nunca pulado em silêncio. */
  unreadableReports: { cardId: string; shape: string }[];
};

/** Tira o que a prosa cola no caminho: caminho absoluto do repo, sufixo entre
 * parênteses (`(M, +238/-11)`), `./` inicial e `:linha` do fim. */
export function normalizeDeclaredPath(entry: string, repoRoot: string): string {
  let s = entry.trim();
  if (repoRoot && s.startsWith(repoRoot)) s = s.slice(repoRoot.length);
  s = s.replace(/^\/+/, "");
  s = s.split(" (")[0];
  s = s.replace(/:\d+(-\d+)?$/, "");
  return s.replace(/^\.\//, "").trim();
}

/** `filesChanged` de UM relatório — lista de strings, ou nada. Nunca lança. */
function readDeclaredPaths(report: AttributionReport, repoRoot: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report.reportJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const raw = parsed.filesChanged;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeDeclaredPath(entry, repoRoot))
    .filter((entry) => entry.length > 0);
}

/** Menções em prosa que dão para ancorar: caminho COMPLETO, ou um nome de
 * arquivo que seja ÚNICO entre os sujos. O resto é ruído e fica de fora. */
function readMentions(
  report: AttributionReport,
  paths: readonly string[],
): { full: string[]; short: string[] } {
  const full: string[] = [];
  const short: string[] = [];
  const fullRe =
    /\b(?:src|tests|scripts|docs|resources|prototypes)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|json|md|css)\b/g;
  const shortRe = /\b([A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|css))\b/g;
  const found = report.reportJson.match(fullRe) ?? [];
  for (const hit of found) full.push(hit);
  const byBase = new Map<string, number>();
  for (const p of paths) {
    const base = p.split("/").pop() ?? "";
    byBase.set(base, (byBase.get(base) ?? 0) + 1);
  }
  const known = new Set(found);
  for (const hit of report.reportJson.match(shortRe) ?? []) {
    // Só ancorável se for ÚNICO entre os arquivos sujos e não for já um caminho
    // completo encontrado acima. `index.ts` cai fora: há vários.
    if (byBase.get(hit) === 1 && ![...known].some((k) => k.endsWith(`/${hit}`) || k === hit))
      short.push(hit);
  }
  return { full, short };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A decisão. Pura: recebe as linhas cruas (cards, tasks, reports, snapshots,
 * transições) e devolve, por arquivo, o que se sabe e com que força.
 */
export function decideDiffAttribution(input: DiffAttributionInput): DiffAttribution {
  const labelOf = new Map(input.cards.map((c) => [c.cardId, c.label]));
  const label = (cardId: string) => labelOf.get(cardId) ?? null;

  // (1) DECLARADO
  const declaredByPath = new Map<string, DeclaredCandidate[]>();
  const unreadableReports: { cardId: string; shape: string }[] = [];
  const hintsByPath = new Map<string, PathMention[]>();
  const declaredSomething = new Set<string>();
  for (const report of input.reports) {
    const declared = readDeclaredPaths(report, input.repoRoot);
    if (declared === null) {
      // Forma inesperada (relatório que é ARRAY/STRING, sem `filesChanged`):
      // declarado, nunca pulado — é o que o dono pediu.
      let shape = "sem filesChanged";
      try {
        const parsed: unknown = JSON.parse(report.reportJson);
        shape = Array.isArray(parsed) ? "array" : typeof parsed;
      } catch {
        shape = "json inválido";
      }
      unreadableReports.push({ cardId: report.cardId, shape });
      continue;
    }
    if (declared.length > 0) declaredSomething.add(report.cardId);
    for (const path of declared) {
      const list = declaredByPath.get(path) ?? [];
      if (!list.some((c) => c.cardId === report.cardId)) {
        list.push({
          cardId: report.cardId,
          label: label(report.cardId),
          updatedAt: report.updatedAt,
        });
      }
      declaredByPath.set(path, list);
    }
    const mentions = readMentions(report, input.paths);
    for (const hit of mentions.full) {
      const list = hintsByPath.get(hit) ?? [];
      if (!list.some((m) => m.cardId === report.cardId))
        list.push({ cardId: report.cardId, label: label(report.cardId), short: false });
      hintsByPath.set(hit, list);
    }
    for (const hit of mentions.short) {
      const target = input.paths.find((p) => (p.split("/").pop() ?? "") === hit);
      if (!target) continue;
      const list = hintsByPath.get(target) ?? [];
      if (!list.some((m) => m.cardId === report.cardId))
        list.push({ cardId: report.cardId, label: label(report.cardId), short: true });
      hintsByPath.set(target, list);
    }
  }

  // (3) JANELA: o primeiro snapshot em que o caminho aparece sujo, e os cards
  // com ação observada entre ele e o anterior.
  const snapshots = [...input.snapshots].sort((a, b) => a.at - b.at);
  const windowFor = (path: string): WindowEvidence | null => {
    const first = snapshots.find((s) => s.files.includes(path));
    if (!first) return null;
    const previous = [...snapshots].filter((s) => s.at < first.at).pop() ?? null;
    const from = previous ? previous.at : first.at;
    const actors = new Set<string>();
    for (const s of snapshots)
      if (s.at > from && s.at <= first.at && s.cardId) actors.add(s.cardId);
    for (const r of input.reports)
      if (r.updatedAt > from && r.updatedAt <= first.at) actors.add(r.cardId);
    for (const t of input.transitions)
      if (t.at > from && t.at <= first.at && t.cardId) actors.add(t.cardId);
    return { from, to: first.at, cardIds: [...actors] };
  };

  const files: FileAttribution[] = input.paths.map((path) => {
    const declared = declaredByPath.get(path) ?? [];
    const window = declared.length === 0 ? windowFor(path) : null;
    const mentions = declared.length === 0 && !window ? (hintsByPath.get(path) ?? []) : [];
    const state: FileAttribution["state"] =
      declared.length > 1
        ? "disputed"
        : declared.length === 1
          ? "declared"
          : window && window.cardIds.length > 0
            ? "window"
            : mentions.length > 0
              ? "mention"
              : "unknown";
    return { path, declared, disputed: declared.length > 1, window, mentions, state };
  });

  // (4) O SILÊNCIO TEM NOME: card cujo schema declarava `filesChanged` e que não
  // declarou arquivo nenhum. Antes de acusar, o card precisa existir e ter
  // alguma task com o campo.
  const cardsWithField = new Set<string>();
  for (const task of input.tasks) {
    if (task.cardId && task.reportSchema?.includes("filesChanged")) cardsWithField.add(task.cardId);
  }
  const silentCards = input.cards.filter(
    (c) => cardsWithField.has(c.cardId) && !declaredSomething.has(c.cardId),
  );

  return { files, silentCards, unreadableReports };
}
