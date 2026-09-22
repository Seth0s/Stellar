/**
 * CAMADA 4 — integrante da task não julga a própria task.
 *
 * Product rule (owner, 2026-09-14): who PARTICIPATES as implementer may
 * only ASK (`request_task_status`); who is OUTSIDE the task, or linked as
 * reviewer, may WRITE judgment (`done`/`failed`). The criterion is
 * membership of THIS task — not the word "implementer" alone, and not
 * "member of any task".
 *
 * Reviewer tension: a reviewer IS a participant AND may judge — judging
 * is the role. So the gate is not "every row in task_cards is barred";
 * only the implementer link is barred from writing judgment.
 *
 * Board-orchestrator delegation (same day): the marked card may sign
 * judgment in the human's place with actor `orchestrator`, BUT
 * participation still wins — if that card is implementer on THIS task,
 * it only asks. No exception.
 *
 * Lives next to the `update_task` handler (message-bus), not inside
 * `decideStatusWrite`: human/app writers never pass through this gate,
 * and the store choke point has no writer card id today. Agents reach
 * judgment only via `update_task`.
 *
 * `deriveCompletionProposal` (renderer) is PRESENTATION of readiness for
 * the human click — not a second write authority. One rule decides who
 * may conclude; the bar only shows signals.
 *
 * SAME RULE, SECOND DOOR (2026-09-19): `report` carries a typed `verdict`
 * (aprovado/reprovado) — judgment written without `update_task`. Measured
 * on one real day: a card linked as implementer sent its own `aprovado`
 * three times and the reviewer reproved all three. The gate below is
 * `decideJudgmentWrite`'s sibling: same criterion (role on THIS task),
 * same posture (implementer refused; `review="wanted"` refuses every
 * non-reviewer; unknown/outsider allowed — barring them would invent
 * policy), plus the reviewer's own requirement — a verdict with no real
 * evidence is worth less than no review at all, so a reviewer's verdict
 * must fill the task's declared `reportSchema` keys with actual content.
 */

import { isJudgmentStatus } from "../task-status-derive";
import { TASK_CARD_IMPLEMENTER_ROLE, TASK_CARD_REVIEWER_ROLE } from "../task-purpose";
import type { TaskVerdictReadRule } from "./task-verdict-read-decision";
import { isRoundAttributableToTask } from "./task-verdict-read-decision";

export type JudgmentRequesterRole = typeof TASK_CARD_IMPLEMENTER_ROLE | typeof TASK_CARD_REVIEWER_ROLE | string | null;

export type JudgmentWriteDecision =
  | { action: "allow" }
  | { action: "refuse"; error: string };

/**
 * AGENT-FACING — DO NOT TRANSLATE. Names the tool the implementer must
 * use, same teaching style as `report-retry-decision.ts`.
 */
export function describeImplementerJudgmentRefusal(proposedStatus: string): string {
  return (
    `[de: stellar] update_task status "${proposedStatus}" recusado: ` +
    `integrante implementer desta task não grava julgamento (done/failed). ` +
    `Use request_task_status para pedir a mudança — orquestrador, reviewer ou humano julgam.`
  );
}

/**
 * AGENT-FACING — DO NOT TRANSLATE. Names the contract field the same
 * way `report-retry-decision.ts` names a missing schema key — refusal
 * that teaches, not silence.
 */
export function describeReviewWantedJudgmentRefusal(proposedStatus: string): string {
  return (
    `[de: stellar] update_task status "${proposedStatus}" recusado: ` +
    `review="wanted" nesta task — só um card com role=reviewer grava julgamento (done/failed). ` +
    `Implementer, outsider e orquestrador (assinatura delegada) são recusados. ` +
    `Vincule um reviewer (spawn_agent/link_task_card com role=reviewer) e deixe-o julgar, ` +
    `ou use request_task_status para pedir ao humano.`
  );
}

/**
 * Decide whether an agent `update_task` may write a judgment status.
 *
 * @param proposedStatus status field from the request, or null when omitted
 * @param requesterRoleOnTask role from `task_cards` for (taskId, requesterId);
 *   `null` when the caller has no link on this task OR no requesterId
 *   (anonymous / external orchestrator — treated as outsider).
 * @param reviewWanted when true (`tasks.review = "wanted"`), only a linked
 *   reviewer may write judgment — board-orchestrator delegation loses.
 */
export function decideJudgmentWrite(input: {
  proposedStatus: string | null;
  requesterRoleOnTask: JudgmentRequesterRole;
  reviewWanted?: boolean;
}): JudgmentWriteDecision {
  if (input.proposedStatus === null) return { action: "allow" };
  if (!isJudgmentStatus(input.proposedStatus)) return { action: "allow" };
  // `review: wanted` beats delegated signature AND outsider write.
  if (input.reviewWanted && input.requesterRoleOnTask !== TASK_CARD_REVIEWER_ROLE) {
    return { action: "refuse", error: describeReviewWantedJudgmentRefusal(input.proposedStatus) };
  }
  if (input.requesterRoleOnTask === TASK_CARD_IMPLEMENTER_ROLE) {
    return { action: "refuse", error: describeImplementerJudgmentRefusal(input.proposedStatus) };
  }
  // reviewer (may judge), outsider (null), or unknown role → allow write.
  // Unknown roles are not implementer; barring them would invent policy.
  // Board-orchestrator mark does NOT widen this gate — the marked card
  // is simply an outsider (or reviewer) whose actor stamp becomes
  // `orchestrator` at the write site when it is allowed.
  return { action: "allow" };
}

/** Look up the caller's role on one task from a `task_cards` dump. */
export function roleOnTask(
  cards: readonly { card_id: string; role: string }[],
  cardId: string | null | undefined,
): JudgmentRequesterRole {
  if (!cardId) return null;
  const row = cards.find((c) => c.card_id === cardId);
  return row ? row.role : null;
}

/**
 * Words that look like an answer but carry no evidence. Kept deliberately
 * short: each entry is a refusal that a human would agree with, not a
 * style opinion. Compared lowercased and trimmed.
 *
 * A PALAVRA INTEIRA, NUNCA SUBSTRING (task 8dd43b2c): um revisor entregou
 * `"achados": "placeholder"` com verdict de REPROVAÇÃO e o servidor aceitou
 * em silêncio — quem recusou foi o orquestrador, lendo o texto na mão.
 * Medição que decide a FORMA (banco real, `reports` × `reportSchema`
 * declarado da task, 2073 valores de evidência ACEITOS):
 *   - comparar o valor INTEIRO (trim + lowercase) contra esta lista: 0 falso
 *     positivo;
 *   - se fosse SUBSTRING: 288 dos 2073 (14%) seriam acusados — incluindo
 *     frases que DESCREVEM um placeholder deixado no código, que é
 *     exatamente o que uma revisão desta própria task escreve;
 *   - se fosse LIMIAR DE TAMANHO (≤25 chars): 0 falso positivo HOJE (o menor
 *     aceito tem 27), mas o contrato pede evidência curta e real — "1884
 *     passed" (12), um hash de commit, um caminho de arquivo — e recusaria
 *     justamente o que a mensagem de recusa manda escrever. Guard que recusa
 *     relatório legítimo é pior que o furo.
 * Tamanho NÃO entrou como critério; vocabulário entrou só como valor inteiro.
 */
const PLACEHOLDER_REPORT_VALUES = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "todo",
  "tbd",
  "-",
  "--",
  "—",
  "…",
  "...",
  "?",
  // Adições da 8dd43b2c — todas medidas contra os 2073 valores aceitos com
  // 0 falso positivo como valor inteiro.
  "placeholder",
  "lorem ipsum",
  "lorem",
  "xxx",
  "xxxx",
  "xxxxx",
  "wip",
  "fixme",
  "changeme",
  "filler",
  "a preencher",
  "preencher",
  "a definir",
  "to be defined",
  "to be done",
  "sample",
  "exemplo",
  "foo",
  "bar",
  "baz",
  "asdf",
]);

function isRealReportValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 && !PLACEHOLDER_REPORT_VALUES.has(trimmed);
  }
  // A number or boolean is real content on its own: a gate's count
  // ("373 passed") is exactly the evidence this gate exists to demand,
  // and `false` is an answer, not an absence.
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

/**
 * Which of the task's declared `reportSchema` keys are absent OR present
 * with nothing real in them. Presence alone is what the bus checks today
 * (`missingReportSchemaField`) — a reviewer answering `"gatesOutput": ""`
 * satisfies presence and still says nothing, which is the hole this
 * closes. A non-object report cannot satisfy any declared key.
 */
export function emptyReportSchemaFields(report: unknown, schema: readonly string[] | null | undefined): string[] {
  if (!schema || schema.length === 0) return [];
  if (report === null || typeof report !== "object" || Array.isArray(report)) return [...schema];
  const payload = report as Record<string, unknown>;
  return schema.filter((key) => !isRealReportValue(payload[key]));
}

/**
 * AGENT-FACING — DO NOT TRANSLATE. Same teaching style as the two
 * refusals above: name the rule, name the way out.
 */
export function describeImplementerVerdictRefusal(verdict: string): string {
  return (
    `[de: stellar] report verdict "${verdict}" recusado: ` +
    `este card está vinculado como implementer nesta task — implementer não emite veredito sobre o próprio trabalho ` +
    `(autoaprovação não é revisão). ` +
    `Quem julga é um card com role=reviewer (spawn_agent/link_task_card com role=reviewer), ` +
    `ou use request_task_status para pedir a mudança ao humano. Nada foi gravado.`
  );
}

/**
 * AGENT-FACING — DO NOT TRANSLATE. `review="wanted"` beats delegated
 * signature here too: the requirement was declared, so only the linked
 * reviewer may write the veredito.
 */
export function describeNonReviewerVerdictRefusal(verdict: string): string {
  return (
    `[de: stellar] report verdict "${verdict}" recusado: ` +
    `review="wanted" nesta task — só um card com role=reviewer emite veredito. ` +
    `Implementer, outsider e orquestrador (assinatura delegada) são recusados. ` +
    `Vincule um reviewer (spawn_agent/link_task_card com role=reviewer) e deixe-o julgar, ` +
    `ou use request_task_status para pedir ao humano. Nada foi gravado.`
  );
}

/**
 * AGENT-FACING — DO NOT TRANSLATE. Names the exact keys so the correction
 * is mechanical, like `describeMissingReportField` does for a plain
 * missing key.
 */
export function describeVerdictEvidenceRefusal(verdict: string, emptyKeys: readonly string[]): string {
  return (
    `[de: stellar] report verdict "${verdict}" recusado: ` +
    `um veredito de reviewer precisa das chaves do reportSchema com conteúdo real — ` +
    `sem isso o veredito vale menos que nenhuma revisão. ` +
    `Vazias/placeholder (vazio, [], {}, "N/A", "TBD", "placeholder", "lorem ipsum", "WIP"): ${emptyKeys.join(", ")}. ` +
    `Preencha com a evidência MEDIDA (o que foi verificado, a saída real, o número do gate) e reenvie. Nada foi gravado.`
  );
}

export type ReportVerdictDecision = { action: "allow" } | { action: "refuse"; error: string };

/**
 * Decide whether an agent `report` may carry a typed `verdict`.
 *
 * Sibling of `decideJudgmentWrite`, reached through the other door
 * (`report` instead of `update_task`), with the same criterion and the
 * same posture:
 *
 * - no verdict → allow (this gate only guards judgment; a plain report is
 *   untouched);
 * - `review="wanted"` → only a linked reviewer may verdict, so every
 *   other role (implementer, outsider, unknown, delegated orchestrator)
 *   is refused;
 * - implementer → refused: judging your own work is not review;
 * - reviewer → allowed, but only with the task's declared `reportSchema`
 *   keys filled with real content;
 * - unknown role / outsider / no task link → allowed, exactly as
 *   `decideJudgmentWrite` allows them. Unknown is not implementer, and
 *   barring it here would invent policy the store does not have.
 *
 * A reviewer verdict is held to the schema regardless of `ok`: the
 * declared contract for a FAILURE report (`ok:false` skips the keys) was
 * written for the implementer saying it could not deliver. A reviewer is
 * not delivering — it is judging, and a judgment owes its evidence.
 */
export function decideReportVerdictWrite(input: {
  /** Typed verdict on the report (explicit `verdict` field or embedded in the payload), or null/undefined. */
  verdict: string | null | undefined;
  /** Requester's role on the task the report belongs to; null = no link / unknown. */
  requesterRoleOnTask: JudgmentRequesterRole;
  /** True when the task declares `review="wanted"`. */
  reviewWanted?: boolean;
  /** Decoded report payload — the evidence the schema keys are read from. */
  report: unknown;
  /** Task's declared required keys (`tasks.report_schema_json`), or null/empty. */
  reportSchema?: readonly string[] | null;
}): ReportVerdictDecision {
  if (!input.verdict) return { action: "allow" };
  if (input.reviewWanted && input.requesterRoleOnTask !== TASK_CARD_REVIEWER_ROLE) {
    return { action: "refuse", error: describeNonReviewerVerdictRefusal(input.verdict) };
  }
  if (input.requesterRoleOnTask === TASK_CARD_IMPLEMENTER_ROLE) {
    return { action: "refuse", error: describeImplementerVerdictRefusal(input.verdict) };
  }
  if (input.requesterRoleOnTask === TASK_CARD_REVIEWER_ROLE) {
    const empty = emptyReportSchemaFields(input.report, input.reportSchema);
    if (empty.length > 0) return { action: "refuse", error: describeVerdictEvidenceRefusal(input.verdict, empty) };
  }
  return { action: "allow" };
}

/**
 * FECHAR O CARD É A ÚLTIMA PORTA — e até 2026-09-19 era a porta MUDA.
 *
 * Um card linkado a uma task aberta fechava sem fechar a task e sem
 * avisar nada. MEDIDO no banco real (2026-09-19): 38 tasks abertas, 28 já
 * sem card principal, e 7 delas com `review="wanted"`, sem card e SEM
 * NENHUM reviewer linkado — os 7 órfãos. Em nenhum dos sete sobreviveu um
 * único round de veredito (6 não têm `task_cards` nenhum; 1 tem 1 linha em
 * `task_cards` mas ZERO linhas em `task_verdicts` — não é um veredito
 * `null` gravado, é ausência de veredito).
 *
 * MEDIÇÃO QUE DECIDE `recusar` vs `auto-fechar` (a pergunta da task):
 * auto-fechar pelo "último report ok:true" NÃO teria salvado NENHUM dos
 * sete — nenhum deles tinha evidência de sucesso. Quem realmente fecha a
 * porta é (a) RECUSAR quando o fechamento deixaria a task sem ninguém
 * capaz de assiná-la, e (b) CONCLUIR quando a assinatura JÁ está no store:
 * há 23 `aprovado` de reviewer gravados em `task_verdicts`, e 5 tasks
 * abertas com `review="wanted"` e card vivo (4 delas sem reviewer
 * nenhum) que virariam órfãs na próxima vez que o implementer fechasse.
 *
 * Mesmo critério de CAMADA 4, sem porta nova: a decisão reusa
 * `decideJudgmentWrite` para o caso sem review, então nada aqui amplia
 * quem pode julgar.
 */
export type CloseCardLinkedTask = {
  taskId: string;
  /** Card being closed (used only to name it in the refusal). */
  targetCardId: string;
  reviewWanted: boolean;
  /** Role of the card being CLOSED on this task (`null` = principal sem role row / não linkado). */
  targetRole: JudgmentRequesterRole;
  /** Role of whoever ASKED for the close on this task (may be another card). */
  requesterRoleOnTask: JudgmentRequesterRole;
  /** Reviewer links OTHER than the card being closed whose PTY is alive right now. */
  otherLiveReviewers: number;
  /** The target card's last ACCEPTED report declared `ok: true`. */
  lastReportOk: boolean;
  /** Rodadas gravadas NESTA task para o card que está fechando, cronológicas.
   *
   * `verdict` já chega LIDO (`task-verdict-read-decision.ts`, task 156e6d08):
   * `null` quando o veredito não é atribuível a esta task. `rule` diz por quê,
   * e é o que permite esta decisão não tratar um CARIMBO DE FAN-OUT como
   * assinatura deste card nesta task. Ausente (chamador/teste antigo) = a
   * rodada é desta task, que é o comportamento de antes da fatia. */
  targetVerdicts: readonly { role: string; verdict: string | null; rule?: TaskVerdictReadRule }[];
};

export type CloseCardTaskEffect =
  | { action: "allow-close" }
  | { action: "conclude-task"; taskId: string; reason: "reviewer-signature" | "success-report" }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. `review="wanted"` sem reviewer vivo:
 * fechar este card é exatamente o gerador medido dos 7 órfãos. */
export function describeStrandedReviewTaskCloseRefusal(taskId: string, targetCardId: string): string {
  return (
    `[de: stellar] close_card de "${targetCardId}" recusado: o card é o implementer da task "${taskId}", ` +
    `que exige review ("wanted") e NÃO tem nenhum reviewer VIVO linkado. ` +
    `Fechar agora deixa a task sem quem possa assinar done — foi assim que 7 tasks ficaram órfãs. ` +
    `Vincule/spawne um reviewer (link_task_card ou spawn_agent com role=reviewer), ` +
    `ou use update_task review:null se a exigência não vale mais, ou request_task_status para o humano decidir. ` +
    `Nada foi fechado.`
  );
}

/** AGENT-FACING — DO NOT TRANSLATE. O ÚNICO revisor vivo saindo sem
 * veredito: a task fica presa (mesmo dano, pela outra ponta). */
export function describeReviewerLeavingUnsignedRefusal(taskId: string, targetCardId: string): string {
  return (
    `[de: stellar] close_card de "${targetCardId}" recusado: o card é o ÚNICO reviewer vivo da task "${taskId}" ` +
    `(review="wanted") e não tem veredito registrado nesta task. ` +
    `Fechar agora prende a task sem quem assine. ` +
    `Registre o veredito primeiro (report com verdict aprovado/reprovado) e feche em seguida — ` +
    `um aprovado de reviewer conclui a task JUNTO com o fechamento. Nada foi fechado.`
  );
}

/** AGENT-FACING — DO NOT TRANSLATE. Sem review exigido, mas sem evidência
 * de sucesso: o fechamento tem que ser explícito, não silencioso. */
export function describeCloseWithoutSuccessRefusal(taskId: string, targetCardId: string): string {
  return (
    `[de: stellar] close_card de "${targetCardId}" recusado: o card está linkado à task aberta "${taskId}", ` +
    `e o último report ACEITO dele não declara sucesso (ok:true). ` +
    `Fechar agora deixaria a task aberta e órfã (28 das 38 tasks abertas hoje estão assim). ` +
    `Conclua a task antes: update_task com status done/failed, ou request_task_status para o humano — ` +
    `ou, se quem fecha NÃO for o implementer desta task (reviewer, outsider ou humano), ` +
    `deixe o card reportar ok:true, que aí o próprio close conclui a task junto (CAMADA 4 ainda vale: ` +
    `o implementer fechando o próprio card continua sem julgar). Nada foi fechado.`
  );
}

/**
 * ITEM 21 — O AGENTE DEIXA ARTEFATO DE TRABALHO NA ÁRVORE.
 *
 * Território cobre ONDE escrever, não o que limpar ao sair: um `scratch.php` na
 * raiz do Backend (sonda de contagem de queries de um N+1) e um `diff.txt` de
 * 520 linhas na raiz do Admin quase entraram num `git add` largo. Nenhum dos
 * dois violava território.
 *
 * A regra é um SINAL, nunca uma acusação, e por isso ela é pura aqui: o
 * chamador coleta os fatos (git + stat) e só o que sobra é listado. Nunca
 * apagar — o app não sabe o que era sonda e o que era entrega esquecida, e a
 * árvore é compartilhada (outro card pode ter escrito no mesmo intervalo).
 *
 * As três exclusões, cada uma medida:
 *   - DECLARADO no relatório (`files`/`filesChanged`) não é pendência: é a
 *     entrega. A comparação é por sufixo de caminho para tolerar declaração
 *     absoluta (`/repo/src/x.ts`) contra o untracked relativo (`src/x.ts`).
 *   - ANTERIOR à task não é artefato DELA (`modifiedAtMs < taskStartedAtMs`):
 *     sem a janela temporal, todo untracked pré-existente vira ruído.
 *   - DEPENDÊNCIA/BUILD/CACHE nunca entra (`node_modules`, `dist`, …). O
 *     `git status` já esconde o que o `.gitignore` cobre — esta é a segunda
 *     linha, para repo que não ignora. Medido neste repo: `--ignored` traria
 *     31.439 entradas; `--porcelain` puro, 4.
 *   - ESTRUTURA não é artefato (4ª exclusão, `isStructuralSourceFile`): dir de
 *     código + extensão de código = entregável em andamento, mesmo novíssimo.
 *     A RAIZ nunca é estrutural — é onde os dois casos reais estavam.
 */
export type UntrackedArtifact = {
  /** Caminho relativo à raiz do repositório, como `git status` reporta. */
  path: string;
  /** Bytes no disco; 0 quando o stat falhou. */
  bytes: number;
  /** Última modificação em ms epoch; 0 quando desconhecida. */
  modifiedAtMs: number;
};

export type ArtifactPendency = UntrackedArtifact;

/**
 * Diretórios que NUNCA são artefato: dependência, build, cache e as áreas de
 * rascunho/config do próprio ambiente. O `git status` já esconde o que o
 * `.gitignore` cobre — esta lista é a segunda linha, e é EXPORTADA para o gate
 * anti-drift (`artifact-pendencies.test.ts`) medir contra o repo REAL em vez
 * de confiar nesta mão.
 */
export const NON_ARTIFACT_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "coverage",
  ".vite",
  ".cache",
  ".turbo",
  ".next",
  "__pycache__",
  "tmp",
  ".claude",
];
const NON_ARTIFACT_SEGMENTS = new Set(NON_ARTIFACT_DIRS);

/**
 * A QUARTA EXCLUSÃO — e é a que dá PRECISÃO (medido: sem ela, 7 de 7
 * falso-positivo nesta árvore). Os dois casos REAIS (`scratch.php` e um
 * `diff.txt` de 520 linhas, ambos na RAIZ) têm o que os 7 falsos não têm: não
 * pertencem à ESTRUTURA. Um untracked que vive num diretório de código do
 * projeto E tem extensão de código do projeto é entregável em andamento (de
 * outro card ou deste) — não artefato. Artefato é o que cai FORA da estrutura:
 * a RAIZ do repo (onde os dois casos estavam), extensão estranha, nome de
 * sonda.
 *
 * A raiz é deliberadamente NUNCA estrutural: um `.ts` solto na raiz não
 * pertence ao projeto e É candidato, por mais que a extensão seja de código —
 * o que desqualifica é o PAR (diretório de código + extensão de código).
 *
 * NOME DE SONDA VENCE A ESTRUTURA (4ª exclusão, parte 2): a sonda que MEDIU
 * esta task (`tests/unit/zz-measure2.test.ts`) era invisível ao próprio
 * detector — o caso de uso, não uma ressalva. Uma sonda chamada `zz-probe.ts`
 * em `src/` é artefato mesmo estando no par estrutural; a precisão vinha da
 * EXTENSÃO, e o nome agora desempata. As listas abaixo são exportadas: o gate
 * anti-drift as confronta com `git ls-files`.
 */
export const STRUCTURAL_CODE_DIRS: readonly string[] = [
  "src",
  "tests",
  "scripts",
  "resources",
  "prototypes",
  "docs",
  ".github",
];
const STRUCTURAL_CODE_DIR_SET = new Set(STRUCTURAL_CODE_DIRS);

export const PROJECT_CODE_EXTS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".md",
  ".astro",
  ".png",
  ".html",
  ".yml",
  ".sh",
  ".py",
];
const PROJECT_CODE_EXT_SET = new Set(PROJECT_CODE_EXTS);

/**
 * Marcadores de sonda no NOME — ANCORADOS EM FRONTEIRA, nunca substring.
 *
 * MEDIDO sobre os 689 basenames de `git ls-files`: o casamento por SUBSTRING
 * acusava 2 arquivos VIVOS e legítimos — `scripts/measure-reach-gabarito.ts`
 * (casava `measure`) e `tests/unit/verify-tmp-sweep.test.ts` (casava `tmp`).
 * O repo usa `measure-*` e `-tmp-` de verdade, então um `scripts/measure-foo.ts`
 * novo nasceria falso-positivo — e gritar em arquivo legítimo é o modo de
 * falha que reprovou o desenho original (7/7). Com a âncora — começa-por
 * (`zz-`, `scratch`, `probe`, `debug`, `tmp-`), TOKEN pontuado (`.bak`,
 * `.orig`, `.tmp`) ou delimitado (`-measure-`) — os dois vivos deixam de casar
 * e as sondas seguem pegas: **0 de 689**.
 *
 * LIMITE DECLARADO (não coberto de propósito): uma sonda de nome ARBITRÁRIO
 * dentro de diretório de código (`src/main/helper.ts`) segue invisível — o
 * nome não a denuncia. Cobrir isso exigiria outra classe de evidência
 * (autoria, janela), fora do escopo deste detector.
 */
const PROBE_NAME_PREFIXES: readonly string[] = ["zz-", "scratch", "probe", "debug", "tmp-"];
const PROBE_NAME_TOKENS: readonly string[] = [".bak", ".orig", ".tmp"];
const PROBE_NAME_DELIMITED: readonly string[] = ["-measure-"];

/** Exportado para o gate anti-drift: nenhum nome RASTREADO pode casar. */
export function isProbeName(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  if (PROBE_NAME_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  // Token PONTUADO: `.tmp` casa `x.tmp` e `x.tmp.ts`, mas NUNCA `verify-tmp-sweep`.
  if (PROBE_NAME_TOKENS.some((token) => base.endsWith(token) || base.includes(`${token}.`))) return true;
  return PROBE_NAME_DELIMITED.some((marker) => base.includes(marker));
}

function isStructuralSourceFile(rel: string): boolean {
  const segments = rel.split("/");
  if (segments.length < 2) return false; // RAIZ: onde scratch.php/diff.txt vivem.
  // Sonda: É candidato mesmo em diretório de código — é o caso de uso.
  if (isProbeName(rel)) return false;
  if (!STRUCTURAL_CODE_DIR_SET.has(segments[0]!)) return false;
  const dot = rel.lastIndexOf(".");
  const ext = dot > rel.lastIndexOf("/") ? rel.slice(dot).toLowerCase() : "";
  return PROJECT_CODE_EXT_SET.has(ext);
}

/** Gate anti-drift: o repo REAL decide se as listas estão completas. */
export function isCoveredRepoDir(segment: string): boolean {
  return STRUCTURAL_CODE_DIR_SET.has(segment) || NON_ARTIFACT_SEGMENTS.has(segment);
}

export function isProjectCodeExt(ext: string): boolean {
  return PROJECT_CODE_EXT_SET.has(ext.toLowerCase());
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function declaredCovers(path: string, declared: readonly string[], root: string): boolean {
  const norm = normalizeRel(path);
  if (!norm) return false;
  const rootNorm = normalizeRel(root);
  for (const raw of declared) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const d = normalizeRel(raw);
    const rel = rootNorm && d.startsWith(`${rootNorm}/`) ? d.slice(rootNorm.length + 1) : d;
    if (!rel) continue;
    if (norm === rel || norm.endsWith(`/${rel}`) || rel.endsWith(`/${norm}`)) return true;
  }
  return false;
}

/**
 * Os arquivos que o relatório DECLAROU, pelas convenções que o board já usa:
 * um array `files` (schema `["ok","files","evidence"]`) ou `filesChanged`
 * (array ou prosa — separada por crase, vírgula ou quebra). Uma prosa que cita
 * um caminho a mais só REDUZ candidatos, que é a direção segura para um sinal.
 */
export function declaredFilesFromReport(report: unknown): string[] {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return [];
  const payload = report as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["files", "filesChanged", "arquivos"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      for (const part of value.split(/[`\n,]/)) if (part.trim()) out.push(part.trim());
    }
  }
  return out;
}

/** Só o que sobra das três exclusões é pendência — e sai ordenado por caminho. */
export function decideArtifactCandidates(input: {
  untracked: readonly UntrackedArtifact[];
  declaredFiles: readonly string[];
  workspaceRoot: string;
  /** `tasks.created_at`: arquivo mais velho que isto não nasceu desta task. */
  taskStartedAtMs: number;
}): ArtifactPendency[] {
  const out: ArtifactPendency[] = [];
  for (const file of input.untracked) {
    const norm = normalizeRel(file.path);
    if (!norm) continue;
    if (norm.split("/").some((segment) => NON_ARTIFACT_SEGMENTS.has(segment))) continue;
    // Pertencer à ESTRUTURA (dir de código + extensão de código) não é
    // artefato, por mais novo que seja — é entregável em andamento. Ver
    // `isStructuralSourceFile`.
    if (isStructuralSourceFile(norm)) continue;
    if (file.modifiedAtMs > 0 && input.taskStartedAtMs > 0 && file.modifiedAtMs < input.taskStartedAtMs) continue;
    if (declaredCovers(norm, input.declaredFiles, input.workspaceRoot)) continue;
    out.push({ path: norm, bytes: file.bytes, modifiedAtMs: file.modifiedAtMs });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * AGENT-FACING — DO NOT TRANSLATE. A pendência é DITA, com caminho, tamanho e
 * desde quando, e com a ressalva explícita: a árvore é compartilhada e o app
 * não apaga nada sozinho. Silêncio foi o defeito que esta família de tasks
 * (ccab0c58, 3b1c9273, 3c696ec9) já curou três vezes hoje.
 */
export function describeArtifactPendencies(pendencies: readonly ArtifactPendency[]): string {
  if (pendencies.length === 0) return "";
  const lines = pendencies.map((p) => {
    const when = p.modifiedAtMs > 0 ? new Date(p.modifiedAtMs).toISOString() : "mtime desconhecido";
    return `- ${p.path} (${p.bytes} B, desde ${when})`;
  });
  return (
    `[de: stellar] ${pendencies.length} arquivo(s) UNTRACKED que o relatório NÃO declarou e que existem desde o início desta task ficaram na árvore ` +
    `— PENDÊNCIA DE LIMPEZA (nada foi apagado):\n${lines.join("\n")}\n` +
    `SINAL, não acusação: a árvore é compartilhada e outro card pode ter escrito no mesmo intervalo. ` +
    `Confira antes de remover — o app nunca apaga arquivo de trabalho sozinho.`
  );
}

/**
 * TROCA DE CARD EM TASK ABERTA (task e8802e32) — QUEM pode LIBERAR uma
 * participação.
 *
 * O guard de fechamento (ecd36437) existe para a task não ficar órfã, e a
 * liberação é a saída que faltava: "a task continua, e OUTRO card a fará".
 * Ela NÃO pode virar a porta dos fundos do próprio guard — mesma classe de
 * CAMADA 4, numa terceira porta:
 *   - IMPLEMENTER não se auto-libera (seria fugir do guard): recusa nomeando
 *     o papel. Participação vence o mark, como em `decideJudgmentWrite`.
 *   - reviewer, outsider/sem-vínculo (inclui o humano) e o mark de
 *     orquestrador do board liberam — não barrar `unknown` é a postura do
 *     repo; quem executa a liberação no bus ainda exige o MOTIVO.
 */
export function describeReleaseByImplementerRefusal(taskId: string): string {
  return (
    `[de: stellar] release_task_card da task "${taskId}" recusado: ` +
    `integrante implementer desta task não se auto-libera — seria a porta dos fundos do guard de fechamento ` +
    `(a task ficaria aberta sem quem a faça). ` +
    `Quem libera é o orquestrador ou o humano: use request_task_status para pedir, ` +
    `ou deixe um card de FORA da task (ou o mark do orquestrador do board) chamar com um motivo. Nada foi gravado.`
  );
}

export function decideTaskCardRelease(input: {
  taskId: string;
  requesterRoleOnTask: JudgmentRequesterRole;
  requesterId: string | null | undefined;
  targetCardId: string;
  orchestratorCardId: string | null | undefined;
}): JudgmentWriteDecision {
  const reqId = requesterOrNull(input.requesterId);

  // Marca libera quem quiser
  if (isBoardMark(reqId, input.orchestratorCardId)) return { action: "allow" };
  
  // Humano pela UI: principal NOMEADO, nunca ausencia.
  if (reqId === HUMAN_PRINCIPAL_ID) return { action: "allow" };
  if (reqId === null) {
    return { action: "refuse", error: describeAnonymousRefusal("release_task_card", input.taskId) };
  }

  // Se o chamador é o próprio card sendo liberado
  if (reqId === input.targetCardId) {
    if (input.requesterRoleOnTask === TASK_CARD_IMPLEMENTER_ROLE) {
      return { action: "refuse", error: describeReleaseByImplementerRefusal(input.taskId) };
    }
    return { action: "allow" }; // Revisor pode se auto-liberar
  }

  // O chamador é um TERCEIRO. Ele não pode expulsar ninguém.
  // Mesmo que seja o principal tentando expulsar o revisor, a regra do sistema é: 
  // "no board da task só o card marcado como orquestrador (ou o humano) faz". 
  // O principal não é dono do board, não tem autoridade para expulsar cards de uma task.
  return { action: "refuse", error: describeThirdPartyReleaseRefusal(input.taskId, reqId, input.targetCardId) };
}

export function describeThirdPartyReleaseRefusal(taskId: string, requesterId: string, targetCardId: string): string {
  return (
    `[de: stellar] release_task_card da task "${taskId}" recusado: ` +
    `expulsar o card "${targetCardId}" da task é ato de coordenação — no board da task só o ` +
    `card marcado como orquestrador (ou o humano) libera outros cards; quem chamou foi "${requesterId}". ` +
    `O próprio card pode pedir para sair (se for revisor), ou pedir ao orquestrador. Nada foi gravado.`
  );
}

/**
 * O que o fechamento do card deve fazer com UMA task aberta à qual ele
 * está ligado. Puro: o chamador só coleta fatos e aplica.
 *
 * NÃO conhece `released`: uma participação liberada sai do conjunto VIVO
 * (`listTaskCardsForCard`) e portanto nunca chega aqui como vínculo — o
 * fechamento do card liberado deixa de ver a task e não a conclui (decisão 1
 * da task e8802e32). Ler a linha liberada do histórico seria justamente
 * reintroduzir o caso que a liberação existe para resolver.
 */
export function decideCloseCardTaskEffect(input: CloseCardLinkedTask): CloseCardTaskEffect {
  // Uma rodada que o fan-out antigo carimbou em OUTRA task (`declared_other_task`)
  // não é assinatura deste card NESTA task, e uma rodada indecidível
  // (`undeclared_round`) não sustenta afirmação nenhuma sobre ela. Antes desta
  // fatia as duas contavam como "já julgou" (o carimbo era lido como veredito
  // real) — e o efeito era fechar uma task que ninguém tinha julgado. O
  // predicado é o MESMO que a proposta de conclusão usa (uma definição só).
  const isRoundOfThisTask = isRoundAttributableToTask;
  const targetApprovedAsReviewer = (() => {
    for (let i = input.targetVerdicts.length - 1; i >= 0; i--) {
      const round = input.targetVerdicts[i]!;
      if (round.role !== TASK_CARD_REVIEWER_ROLE) continue;
      // A rodada de OUTRA task não é a última palavra DESTE revisor aqui: ela
      // nem fala desta task. Pular (em vez de parar) impede que um carimbo
      // antigo apague um `aprovado` de verdade gravado antes dele.
      if (!isRoundOfThisTask(round.rule)) continue;
      return round.verdict === "aprovado";
    }
    return false;
  })();
  const targetJudgedAsReviewer = input.targetVerdicts.some(
    (r) => r.role === TASK_CARD_REVIEWER_ROLE && isRoundOfThisTask(r.rule),
  );

  if (input.reviewWanted) {
    if (input.targetRole === TASK_CARD_REVIEWER_ROLE) {
      // A assinatura viaja com o fechamento: o aprovado já está gravado, e
      // recusar aqui só deixaria a task presa esperando clique humano.
      if (targetApprovedAsReviewer) return { action: "conclude-task", taskId: input.taskId, reason: "reviewer-signature" };
      // Já julgou e não aprovou: o destino da task não depende mais deste
      // card (volta pro implementer/humano decidir) — fechar não prende nada.
      if (targetJudgedAsReviewer) return { action: "allow-close" };
      return { action: "refuse", error: describeReviewerLeavingUnsignedRefusal(input.taskId, input.targetCardId) };
    }
    // Não é reviewer: só pode fechar se sobrar alguém vivo para assinar.
    if (input.otherLiveReviewers > 0) return { action: "allow-close" };
    return { action: "refuse", error: describeStrandedReviewTaskCloseRefusal(input.taskId, input.targetCardId) };
  }

  if (!input.lastReportOk) {
    return { action: "refuse", error: describeCloseWithoutSuccessRefusal(input.taskId, input.targetCardId) };
  }
  // Mesmo portão de CAMADA 4: um implementer fechando o próprio card não
  // ganha aqui o direito de julgar que `update_task` nega.
  const judgment = decideJudgmentWrite({
    proposedStatus: "done",
    requesterRoleOnTask: input.requesterRoleOnTask,
    reviewWanted: false,
  });
  if (judgment.action === "refuse") return { action: "refuse", error: judgment.error };
  return { action: "conclude-task", taskId: input.taskId, reason: "success-report" };
}

function requesterOrNull(requesterId: string | null | undefined): string | null {
  const trimmed = requesterId?.trim();
  return trimmed ? trimmed : null;
}

/**
 * O humano operando fora de um card tem IDENTIDADE PROPRIA, e nao "ausencia de
 * identidade". Nao e um card: e um principal NOMEADO, para que nenhuma das tres
 * portas precise tratar AUSENCIA como autoridade.
 *
 * Por que isto existe, medido em 2026-09-22: a versao anterior destas portas
 * devolvia `allow` para `requesterId === null`, com o argumento de que o humano
 * via UI/CLI chega sem identidade. A medicao derrubou o argumento — `preload` e
 * `renderer` NAO expoem `link_task_card` nem `release_task_card`, e o handler do
 * bus ja recusa `!requesterId` antes da decisao. Ou seja: o chamador anonimo que
 * justificava a chave mestra NAO EXISTE, e o `allow` so enfraquecia a invariante.
 *
 * A regra da casa e a mesma de todas as outras decisoes desta area: ausencia de
 * informacao nunca vira permissao (o arquivo DISPUTADO lista todos, o papel
 * ambiguo grava NULL, a linha indecidivel diz "desconhecido"). Quem opera pela
 * UI declara ESTE principal; quem opera de um card declara o proprio id.
 */
export const HUMAN_PRINCIPAL_ID = "human:ui";

/** Ausencia de identidade NUNCA e autoridade — a recusa diz o que declarar. */
function describeAnonymousRefusal(tool: string, taskId: string): string {
  return (
    `[de: stellar] ${tool} recusado na task "${taskId}": chamador sem identidade. ` +
    `Ausencia de identidade nao e autoridade — declare quem chama: um card declara ` +
    `o proprio id (\`callerCardId\`), e o humano operando fora de um card declara ` +
    `"${HUMAN_PRINCIPAL_ID}". Nada foi gravado.`
  );
}

/** A marca confere? `null`/vazio dos dois lados NÃO é match — board sem marca = ninguém é a marca */
function isBoardMark(requesterId: string | null, orchestratorCardId: string | null | undefined): boolean {
  if (!requesterId || !orchestratorCardId) return false;
  return requesterId === orchestratorCardId;
}


export type TaskCardLinkAuthorshipDecision =
  | { action: "allow" }
  | { action: "refuse"; error: string };

/** Porta 1 — `link_task_card` (o vínculo de participação na task).
 *
 * allow: a marca do board da task; e a reivindicação de task SEM principal
 * (adoção de órfã) por card IDENTIFICADO. refuse: chamador anônimo; auto-vínculo
 * como reviewer (P1 e o agravante do bypass — é o único passo que falta para
 * um implementer se liberar sozinho); vínculo de TERCEIROS por quem não é a marca.
 */
export function decideTaskCardLinkAuthorship(input: {
  taskId: string;
  role: string;
  requesterId: string | null | undefined;
  cardId: string;
  taskCardId: string | null | undefined;
  orchestratorCardId: string | null | undefined;
}): TaskCardLinkAuthorshipDecision {
  const requesterId = requesterOrNull(input.requesterId);
  if (isBoardMark(requesterId, input.orchestratorCardId)) return { action: "allow" };
  if (requesterId === HUMAN_PRINCIPAL_ID) return { action: "allow" };
  if (requesterId === null) {
    return { action: "refuse", error: describeAnonymousRefusal("link_task_card", input.taskId) };
  }

  if (requesterId === input.cardId) {
    if (input.role === TASK_CARD_REVIEWER_ROLE) {
      return {
        action: "refuse",
        error: describeSelfReviewerLinkRefusal(input.taskId, requesterId),
      };
    }
    // Reivindicação: adotar task órfã (sem principal) como implementer.
    if (!input.taskCardId) return { action: "allow" };
    return {
      action: "refuse",
      error: describeSelfImplementerLinkRefusal(input.taskId, input.taskCardId),
    };
  }
  return {
    action: "refuse",
    error: describeThirdPartyLinkRefusal(input.taskId, requesterId, input.role),
  };
}

export function describeAnonymousRoleWriteRefusal(tool: string, taskId: string): string {
  return (
    `[de: stellar] ${tool} recusado: chamador anônimo (sem requesterId) não presume autoridade ` +
    `sobre os papéis da task "${taskId}" — atribuir participação é do orquestrador marcado do board ` +
    `(boards.orchestrator_card_id) ou do humano por um canal identificado. ` +
    `Nada foi gravado.`
  );
}

export function describeSelfReviewerLinkRefusal(taskId: string, requesterId: string): string {
  return (
    `[de: stellar] link_task_card recusado: o card "${requesterId}" não se declara REVISOR da task "${taskId}" — ` +
    `auto-atribuição de revisão é o caminho que fecha a própria disciplina de revisão ` +
    `(medido: self-link reviewer + update_task done fechava a task sem revisão nenhuma, ` +
    `e um implementer não-principal se liberava sozinho em dois passos). ` +
    `Quem atribui revisor é o orquestrador marcado do board ou o humano: ` +
    `peça via request_task_status, ou ao orquestrador. Nada foi gravado.`
  );
}

export function describeSelfImplementerLinkRefusal(taskId: string, taskCardId: string): string {
  return (
    `[de: stellar] link_task_card recusado: o card não se atribui como implementer da task "${taskId}", ` +
    `que JÁ tem principal ("${taskCardId}") — trocar o responsável é do orquestrador ` +
    `(release_task_card, com motivo) ou do humano. Reivindicar task SEM principal continua ` +
    `aberto: é adoção de órfã, não roubo. Nada foi gravado.`
  );
}

export function describeThirdPartyLinkRefusal(taskId: string, requesterId: string, role: string): string {
  return (
    `[de: stellar] link_task_card recusado: atribuir o papel "${role}" a OUTRO card é autoria de ` +
    `participação — no board da task "${taskId}" só o card marcado como orquestrador (ou o humano) linka. ` +
    `Quem chamou foi "${requesterId}" (medido: cards não-marcados linkaram até o card do orquestrador ` +
    `a tasks, por acidente). Peça ao orquestrador do board, ou marque um no UI do board. Nada foi gravado.`
  );
}

export type PrincipalRepointDecision =
  | { action: "allow" }
  | { action: "refuse"; error: string };

/** Porta 2 — `update_task { cardId }` (o ponteiro principal). */
export function decidePrincipalRepointAuthorship(input: {
  taskId: string;
  requesterId: string | null | undefined;
  currentCardId: string | null | undefined;
  newCardId: string | null;
  orchestratorCardId: string | null | undefined;
}): PrincipalRepointDecision {
  const requesterId = requesterOrNull(input.requesterId);
  if (isBoardMark(requesterId, input.orchestratorCardId)) return { action: "allow" };
  if (requesterId === HUMAN_PRINCIPAL_ID) return { action: "allow" };
  // ANTES das comparacoes: com `requesterId` nulo, `input.newCardId === requesterId`
  // e `null === null` numa task orfa — a reivindicacao passaria para ninguem.
  if (requesterId === null) {
    return { action: "refuse", error: describeAnonymousRefusal("update_task", input.taskId) };
  }

  if (input.currentCardId && requesterId === input.currentCardId) {
    return { action: "allow" }; // o principal entrega o bastão ou se destaca
  }
  if (input.newCardId === requesterId && !input.currentCardId) {
    return { action: "allow" }; // reivindicação de órfã
  }
  return {
    action: "refuse",
    error: describePrincipalRepointRefusal(input.taskId, requesterId, input.currentCardId, input.newCardId),
  };
}

export function describePrincipalRepointRefusal(
  taskId: string,
  // `null` e um chamador REAL desta porta, nao um caso impossivel: o humano e o
  // CLI atravessam sem identidade injetada (foi por isso que a recusa cega de
  // anonimo saiu daqui). A mensagem entao NOMEIA a ausencia em vez de imprimir
  // `"null"` entre aspas, que leria como se houvesse um card chamado null.
  requesterId: string | null,
  currentCardId: string | null | undefined,
  newCardId: string | null,
): string {
  const current = currentCardId ? `"${currentCardId}"` : "NULL";
  const next = newCardId ? `"${newCardId}"` : "NULL";
  const who = requesterId ? `"${requesterId}"` : "um chamador anonimo (sem requesterId)";
  return (
    `[de: stellar] update_task recusado: re-apontar o principal da task "${taskId}" ` +
    `de ${current} para ${next} é troca de responsável — no board da task só o card marcado ` +
    `como orquestrador (ou o humano) faz; quem chamou foi ${who} ` +
    `(medido: update_task {cardId: si mesmo} movia o ponteiro e criava a linha de implementer sozinha). ` +
    `O principal atual entrega o bastão por aqui mesmo; quem não é, pede ao orquestrador ` +
    `ou usa release_task_card quando for o caso. Nada foi gravado.`
  );
}

export type ReviewerSpawnDecision =
  | { action: "allow" }
  | { action: "refuse"; error: string };

/** Porta 3 — `spawn_agent { taskId, role: "reviewer" }` */
export function decideReviewerSpawnAuthorship(input: {
  taskId: string;
  requesterId: string | null | undefined;
  orchestratorCardId: string | null | undefined;
  consentSkipped: boolean;
}): ReviewerSpawnDecision {
  const requesterId = requesterOrNull(input.requesterId);
  if (isBoardMark(requesterId, input.orchestratorCardId)) return { action: "allow" };
  if (requesterId === null) return { action: "allow" }; // modal humano aparece
  if (!input.consentSkipped) return { action: "allow" }; // modal humano aparece
  return {
    action: "refuse",
    error: describeReviewerSpawnRefusal(input.taskId),
  };
}

export function describeReviewerSpawnRefusal(taskId: string): string {
  return (
    `[de: stellar] spawn_agent recusado: spawnar card já vinculado como REVISOR da task "${taskId}" ` +
    `em board autônomo pula o consentimento humano — e o brief do filho é texto seu, ` +
    `então é o mesmo que link_task_card de si mesmo (o P1). Quem spawna revisor autonomamente ` +
    `é o orquestrador marcado do board. Nada foi gravado.`
  );
}
