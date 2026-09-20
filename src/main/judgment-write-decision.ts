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
  void TASK_CARD_REVIEWER_ROLE;
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
  /** Verdict rounds recorded on THIS task for the card being closed, chronological. */
  targetVerdicts: readonly { role: string; verdict: string | null }[];
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
 * O que o fechamento do card deve fazer com UMA task aberta à qual ele
 * está ligado. Puro: o chamador só coleta fatos e aplica.
 */
export function decideCloseCardTaskEffect(input: CloseCardLinkedTask): CloseCardTaskEffect {
  const targetApprovedAsReviewer = (() => {
    for (let i = input.targetVerdicts.length - 1; i >= 0; i--) {
      const round = input.targetVerdicts[i]!;
      if (round.role === TASK_CARD_REVIEWER_ROLE) return round.verdict === "aprovado";
    }
    return false;
  })();
  const targetJudgedAsReviewer = input.targetVerdicts.some((r) => r.role === TASK_CARD_REVIEWER_ROLE);

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
