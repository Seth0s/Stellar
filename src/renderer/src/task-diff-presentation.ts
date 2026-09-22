/**
 * O QUE A UI DEVE MOSTRAR DO DIFF ANEXADO À TASK — decidido a partir da
 * evidência, num lugar só (fatia 3 da task 7096e8af).
 *
 * PURO: sem I/O, sem `t()`, sem React e sem nenhum import de RUNTIME. O
 * único import é de TIPO (`DiffCaptureEvidence`, de `main/gate-runner.ts`),
 * apagado no build — mesmo precedente de `GlobalComposer.tsx` /
 * `ProviderUsageBadge.tsx`, que já importam tipos de `src/main`. É de
 * propósito: o shape da evidência tem UMA fonte, e uma segunda declaração
 * aqui divergiria em silêncio no dia em que a captura ganhasse um campo.
 *
 * POR QUE ESTE MÓDULO EXISTE ANTES DO ENCANAMENTO: medido em 2026-09-20, o
 * diff NÃO chega ao renderer hoje — ele mora em `tasks.result_json` sob o
 * envelope `gateRun`, e o push do board projeta `result_json` como NULL de
 * propósito (`store.ts`'s `TASK_SUMMARY_COLUMNS`, por tamanho; medido: o
 * push de `task:changed` custa 3,75 ms + 1,48 MB por evento). O caminho
 * certo é um canal SOB DEMANDA, aberto quando o modal de detalhe abre — e
 * ele depende de `main/index.ts` + `preload/index.ts`, que estão com duas
 * streams. Adiantando a DECISÃO aqui, quando o canal liberar sobra plugar:
 * canal, tipo e um componente que só renderiza o que este módulo decide.
 *
 * OS QUATRO INVARIANTES (o valor das fatias 1 e 2), e onde cada um mora:
 *
 *   1. TERRITÓRIO É RÓTULO, NUNCA FILTRO. `files` sai COMPLETO — arquivo
 *      fora do território APARECE e é CONTADO. Medição refeita por pareamento
 *      (taskId carimbado) contra a direcional do implementador: 44,4% dos
 *      arquivos declarados caem fora (67 de 151), não 75,5%. Filtrar
 *      apagaria justamente o desvio, que é o motivo número um de alguém
 *      querer ver o diff.
 *   2. O RÓTULO NÃO PODE SOAR COMO AUTORIA. O módulo NÃO escreve prosa
 *      própria: a ÚNICA frase que ele entrega é `note`, campo DA PRÓPRIA
 *      EVIDÊNCIA — o texto de lá é travado por teste no main ("o app observa
 *      MUDANÇA, nunca AUTORIA"; a árvore é compartilhada por vários cards).
 *      Uma segunda redação aqui divergiria em silêncio no dia em que alguém
 *      melhorasse uma das duas. Tudo o mais que o módulo devolve é ESTRUTURA
 *      (caminho, código de status, marcador) ou CHAVE de i18n.
 *   3. TRUNCAMENTO QUE NÃO SE ANUNCIA É MENTIRA — e são DOIS, com chaves
 *      próprias: `patchTruncated` (o patch perde o FIM desde o conserto do
 *      teto) e `filesTruncated` (a LISTA de caminhos perde os últimos, e a
 *      contagem vem de uma lista incompleta). Untracked não tem patch no
 *      `git diff` e ganha a sua leitura em vez de um vazio mudo.
 *   4. SEM TERRITÓRIO DECLARADO NÃO HÁ RÓTULO. Cada arquivo sai
 *      `territory: "unlabeled"` e o resumo troca para a leitura de "sem
 *      território" — nunca "0 de N fora", que seria uma leitura inventada
 *      (a captura zera `outsideTerritory` nesse caso de propósito).
 */
import type { DiffCaptureEvidence } from "../../main/gate-runner";

/**
 * As chaves de i18n que o componente vai usar — A DECISÃO está aqui, o TEXTO
 * vive em `catalogs.ts` (pt-BR é a fonte, `en` é tipado). Elas ainda NÃO
 * existem no catálogo: este módulo é puro de propósito e não importa `t()`
 * (importar exigiria as chaves tipadas antes de o componente existir).
 * Quando o componente chegar, estas chaves entram no catálogo e o `t()` as
 * aceita; até lá o mapa abaixo é o contrato da copy.
 */
export const TASK_DIFF_KEYS = {
  /** "Mudança observada no checkout (árvore compartilhada)" — NUNCA "o que
   * esta task mudou": a árvore é compartilhada e o app observa MUDANÇA. */
  sectionTitle: "task.diff.title",
  /** "{outside} de {total} arquivos fora do território declarado" */
  outsideSummary: "task.diff.outsideSummary",
  /** "sem território declarado nesta task — por isso não há rótulo de dentro/fora" */
  noTerritory: "task.diff.noTerritory",
  /** "nenhuma mudança observada no checkout nesta janela" */
  noFiles: "task.diff.noFiles",
  /** "patch truncado — mostrando o COMEÇO" (o texto era "mostrando o fim"
   * enquanto o coletor do git guardava a cauda; o conserto da task 56604aca
   * inverteu o lado retido, e a copy tinha ficado para trás — uma frase que
   * promete o que o código não faz, que é a classe que esta sessão conserta). */
  patchTruncated: "task.diff.patchTruncated",
  /** "a lista de arquivos está truncada — há mais mudanças do que as listadas"
   * (aviso PRÓPRIO, não o do patch: aqui o que falta são caminhos do FIM da
   * lista, e a contagem `total` também é a de uma lista incompleta). */
  filesTruncated: "task.diff.filesTruncated",
  /** "arquivo novo: o diff do git não tem patch dele" */
  untracked: "task.diff.untracked",
} as const;

export type TaskDiffFileView = {
  path: string;
  /** Código porcelain do `git status` (` M`, `??`, `A `…): é DADO, não copy —
   * não passa por i18n. */
  status: string;
  /** Rótulo de território por arquivo. `unlabeled` = a task não declarou
   * território nenhum (a evidência diz isso por arquivo). */
  territory: "inside" | "outside" | "unlabeled";
  /** Untracked: mudou, mas o `git diff` não tem patch dele. */
  untracked: boolean;
};

/**
 * O resumo decidido. `kind` escolhe a CHAVE (`TASK_DIFF_SUMMARY_KEYS`) e os
 * números vão como params — o componente não escolhe entre "N de M fora" e
 * "sem território": essa decisão (invariante 4) vem daqui.
 */
export type TaskDiffSummary =
  | { kind: "outside"; outside: number; total: number }
  | { kind: "no-territory"; total: number }
  | { kind: "no-files" };

export const TASK_DIFF_SUMMARY_KEYS: Record<TaskDiffSummary["kind"], string> = {
  outside: TASK_DIFF_KEYS.outsideSummary,
  "no-territory": TASK_DIFF_KEYS.noTerritory,
  "no-files": TASK_DIFF_KEYS.noFiles,
};

export type TaskDiffView = {
  /** `false` = a task nunca teve evidência de gate: o bloco NÃO existe na
   * tela (nada a decidir, nada a mostrar). */
  present: boolean;
  /** A frase anti-autoria DA EVIDÊNCIA (invariante 2) — repassada como veio,
   * nunca reescrita aqui. Vazia só quando `present` é `false`. */
  note: string;
  /** Contagens como o MAIN as mediu (fonte única; o módulo não recomputa). */
  total: number;
  outside: number;
  /** `null` = não dá para saber (nenhum arquivo na janela): a UI não afirma
   * nem "declarado" nem "não declarado". */
  territoryDeclared: boolean | null;
  /** TODOS os arquivos, na ordem do `git status` (invariante 1). */
  files: TaskDiffFileView[];
  patch: string;
  patchTruncated: boolean;
  /** A LISTA pode estar incompleta (teto de captura): quem exibe `total` ou
   * conta arquivos precisa olhar isto antes de afirmar um número. */
  filesTruncated: boolean;
  summary: TaskDiffSummary;
};

/** O formato do bloco ausente — devolvido por cópia para ninguém mutar o
 * compartilhado entre renders. */
function absent(): TaskDiffView {
  return {
    present: false,
    note: "",
    total: 0,
    outside: 0,
    territoryDeclared: null,
    files: [],
    patch: "",
    patchTruncated: false,
    filesTruncated: false,
    summary: { kind: "no-files" },
  };
}

/**
 * A decisão. `null`/`undefined` = sem evidência (bloco ausente). Com
 * evidência, TODOS os arquivos entram, o rótulo de território sai por
 * arquivo e o resumo é escolhido aqui — inclusive o caso "sem território
 * declarado", que NÃO é o mesmo que "zero arquivos fora".
 */
export function decideTaskDiffPresentation(evidence: DiffCaptureEvidence | null | undefined): TaskDiffView {
  if (!evidence) return absent();

  const files: TaskDiffFileView[] = evidence.files.map((file) => ({
    path: file.path,
    status: file.status,
    territory: file.territoryDeclared ? (file.inTerritory ? "inside" : "outside") : "unlabeled",
    untracked: file.status === "??",
  }));

  // A captura usa UM valor de `territoryDeclared` para todos os arquivos; a
  // leitura aqui é por PRESENÇA, e com zero arquivos não há o que afirmar.
  const territoryDeclared = files.length === 0 ? null : files.some((file) => file.territory !== "unlabeled");

  const summary: TaskDiffSummary =
    files.length === 0
      ? { kind: "no-files" }
      : territoryDeclared === true
        ? { kind: "outside", outside: evidence.outsideTerritory, total: evidence.total }
        : { kind: "no-territory", total: evidence.total };

  return {
    present: true,
    note: evidence.note,
    total: evidence.total,
    outside: evidence.outsideTerritory,
    territoryDeclared,
    files,
    patch: evidence.patch,
    patchTruncated: evidence.patchTruncated,
    filesTruncated: evidence.filesTruncated,
    summary,
  };
}
