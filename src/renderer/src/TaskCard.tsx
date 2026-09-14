import { Fragment, memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import { PROVIDER_GLYPH } from "./provider-glyph";
import { useModal } from "./useModal";
import type { Rect } from "./board-model";
import type { TaskBoardItem } from "../../preload/index";
import { parseTaskPrompt } from "../../task-prompt-decision";
import {
  COLUMN_ORDER,
  COLUMN_TO_STATUS,
  columnForStatus,
  groupTasksByColumn,
  originBadge,
  deriveStage,
  shouldShowStageTrail,
  derivePurposeChip,
  describePurposeChip,
  deriveCompletionProposal,
  describeVerdictChip,
  shortTaskId,
  formatTaskAge,
  waitingOnDep,
  resolveConcurrencyCap,
  computeBoardScope,
  computeCycleTime,
  computeColumnDrop,
  isTaskCardLive,
  computeMetaPills,
  describeTransitionTrail,
  describeHumanMoveNotice,
  describeStatusDivergence,
  describeStatusAskNotice,
  describeReviewWantedNotice,
  msToHours,
  cycleAxisMarks,
  computeVerdictsByProvider,
  computeRoundsToApprove,
  roundsBarTone,
  isHumanCreatedTask,
  didHumanTaskGetClaimed,
  shortSprintId,
  formatSprintTimestamp,
  formatSprintDuration,
  describeSprintCounts,
  sprintLabel,
  snapshotTaskToBoardItem,
  type TaskColumn,
  type MetaPillKind,
  type SprintView,
} from "./task-board-model";
import styles from "./TaskCard.module.css";
import { getLocale, t } from "../../shared/i18n";

/** RODADA 3 (contrato de partes §2.3, item 1) — "a diferença visual mais
 * gritante das duas telas": cada cabeçalho de coluna tem cor própria no
 * protótipo, hoje os quatro saem em cinza uniforme. Dados estáticos de
 * apresentação (não uma decisão testável) — mesmo tratamento que
 * `ROLE_LABEL` abaixo já recebe, vivendo no componente, não no módulo
 * puro. */
const COLUMN_COLOR: Record<TaskColumn, string> = {
  todo: "var(--muted)",
  doing: "var(--foam)",
  done: "var(--good)",
  failed: "var(--danger)",
};

/** RODADA 3 (contrato §2.3, item 8) — empty column messages via i18n. */
const COLUMN_EMPTY_KEY = {
  todo: "task.empty.todo",
  doing: "task.empty.doing",
  done: "task.empty.done",
  failed: "task.empty.failed",
} as const satisfies Record<TaskColumn, "task.empty.todo" | "task.empty.doing" | "task.empty.done" | "task.empty.failed">;

/** Column header keys — JSX only; agent-facing COLUMN_TITLE stays in the model. */
const COLUMN_HEADER_KEY = {
  todo: "task.column.todo",
  doing: "task.column.doing",
  done: "task.column.done",
  failed: "task.column.failed",
} as const satisfies Record<TaskColumn, "task.column.todo" | "task.column.doing" | "task.column.done" | "task.column.failed">;

/** DESIGN-BACKLOG.md §2.1, decisão 7 / peça 5 — rodapé de escopo. Vive no
 * `footerContent` do `CardFrame`. Contagem "N em outros boards" é texto
 * puro (nunca link). O botão "trocar de board" da rodada anterior foi
 * REMOVIDO a pedido do dono do repo (2ª rodada de fidelidade) — a Home
 * continua alcançável pelo fluxo normal do app, não por este rodapé.
 *
 * §0 (2026-09-12) — o número principal é o sprint em foco (`focusedSprintCount`:
 * comprimento do quadro vivo ou do snapshot congelado). O total histórico
 * do board, quando diverge, aparece só como "total N" rotulado. */
function TaskScopeFooter({
  activeBoardId,
  boardNames,
  taskCountsByBoard,
  focusedSprintCount,
}: {
  activeBoardId: string;
  boardNames: Record<string, string>;
  taskCountsByBoard: Record<string, number>;
  focusedSprintCount: number;
}) {
  const scope = computeBoardScope(activeBoardId, taskCountsByBoard, boardNames, focusedSprintCount);
  const ownName = boardNames[activeBoardId] ?? activeBoardId;
  const otherBoardsTooltip = scope.otherBoards.map((b) => `${b.name ?? `board ${b.boardId} (não existe)`} (${b.count})`).join(", ");
  const showBoardTotal = scope.boardTotal !== scope.ownCount;
  return (
    <span data-part="board-scope" className={styles.scopeFooter}>
      <span className={styles.scopeOwn}>
        {t("task.scope.board", { name: ownName })} · {t("task.scope.tasks", { n: scope.ownCount })}
        {showBoardTotal ? ` · total ${scope.boardTotal}` : ""}
      </span>
      {scope.otherTotal > 0 && (
        <span className={styles.scopeRight} title={otherBoardsTooltip}>
          {t("task.scope.others", { n: scope.otherTotal })}
        </span>
      )}
    </span>
  );
}

/** Papel do vínculo task↔card (`task_cards.role`, store.ts) — só
 * "implementer" é escrito automaticamente hoje (nenhuma tool de MCP expõe
 * `linkTaskCard` ainda, ver DESIGN-BACKLOG.md §2.1), mas o campo é uma
 * string livre — qualquer outro valor cai no fallback (o próprio texto). */
function describeCardRole(role: string): string {
  if (role === "implementer") return t("task.role.implementer");
  if (role === "reviewer") return t("task.role.reviewer");
  return role;
}

function describeLinkedCard(card: { cardId: string; label: string | null; role: string }): string {
  const name = card.label ? `${card.cardId} ${card.label}` : card.cardId;
  return `${name} ${describeCardRole(card.role)}`;
}

function statusLabel(status: string): string {
  return t(COLUMN_HEADER_KEY[columnForStatus(status)]);
}

function formatPromptWhen(at: number): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(at));
}

/** DESIGN-BACKLOG.md §2.1 "Card `task`", Fase 2 peça 4 — o glyph metálico
 * de um chip de card, mesma técnica de `TerminalCard.module.css`
 * (`background-clip: text`, gradiente 125deg). `provider` vem direto do
 * LEFT JOIN com `cards` (store.ts) — funciona mesmo pro card já fechado.
 *
 * FIDELIDADE VISUAL AO PROTÓTIPO v5 (delta 3) — o protótipo mostra
 * glyph + ID (mono, forte) + label + papel maiúsculo alinhado à direita
 * ("◆ 306 persist-reports IMPLEMENTA"); a versão anterior só mostrava
 * glyph + label (o id só aparecia como fallback QUANDO não havia label,
 * nunca junto dela) e o papel saía minúsculo, colado ao lado. `cardId`
 * agora é SEMPRE mostrado (id de card já é curto por natureza neste app —
 * inteiros sequenciais, "306"/"288" — nunca precisou de `shortTaskId`); o
 * uppercase do papel é só CSS (`.chipRole`), sem mudar `ROLE_LABEL`. */
function CardChip({ cardId, role, provider, label }: { cardId: string; role: string; provider: string | null; label: string | null }) {
  const metal = provider ? PROVIDER_GLYPH[provider] : undefined;
  const roleLabel = describeCardRole(role);
  return (
    <span className={styles.chip} data-part="card-chip" title={`${label ?? cardId} — ${roleLabel}`}>
      {metal ? (
        <span
          className={`${styles.chipGlyph} ${metal.dark ? "" : styles.chipGlyphFlat}`}
          style={{ "--m-mid": metal.mid, ...(metal.dark ? { "--m-dark": metal.dark } : {}) } as React.CSSProperties}
        >
          {metal.glyph}
        </span>
      ) : (
        <Icon name="terminal" size={11} />
      )}
      <span className={styles.chipId}>{cardId}</span>
      {label && <span className={styles.chipLabel}>{label}</span>}
      <span className={styles.chipRole}>{roleLabel}</span>
    </span>
  );
}

/** Cor por tipo de pílula de meta (delta 5) — o significado mora na cor,
 * não no texto; `computeMetaPills` (task-board-model.ts) decide QUAL
 * pílula aparece, este mapa só decide QUE TOKEN cada `kind` usa.
 * Dado estático de apresentação, mesmo tratamento que `COLUMN_COLOR`/
 * `ROLE_LABEL` já recebem — vive no componente, não no módulo puro. */
const PILL_CLASS: Record<MetaPillKind, string> = {
  wait: styles.pillWait,
  "wait-broken": styles.pillBroken,
  suggestion: styles.pillSuggestion,
  round: styles.pillRound,
  rejection: styles.pillRejection,
};

/** Um item do quadro — DESIGN-BACKLOG.md §2.1 peça 4, "anatomia da task
 * conforme o protótipo v5": alça de arraste + rank, id curto, idade, selo
 * de origem, pílulas coloridas, chips de card, trilha de etapa
 * (controle segmentado), trilha de transição com horários, varredura de
 * atividade (gated por card vivo, não só status), barra de proposta de
 * conclusão, marca de movimento humano. SEM faixa de acento à esquerda
 * (removida do protótipo de propósito). Cada parte carrega `data-part` —
 * contrato de fidelidade contra o protótipo pedido no review da RODADA 2,
 * fechado visualmente nesta rodada (comparação lado a lado, dono do
 * repo). */
function TaskItem({
  task,
  now,
  rank,
  onApproveCompletion,
  onDragPointerDown,
}: {
  task: TaskBoardItem;
  now: number;
  /** Delta 1 — o NÚMERO da posição na coluna, o que torna a prioridade
   * legível sem contar linhas. Só a posição no array já ordenado
   * (`groupTasksByColumn`) — 1-based, calculada por quem itera (`i+1`),
   * não uma decisão nova: a ORDEM já é testada em `compareTasks`/
   * `groupTasksByColumn`, isto só numera o que já está certo. */
  rank: number;
  onApproveCompletion: (taskId: string) => void;
  /** FASE 2, peça 3 — inicia o arraste (mesmo gesto pointerdown/move/up
   * que `CardFrame.tsx`'s `onHeaderPointerDown` já usa pra mover um card
   * inteiro, reaproveitado aqui pra mover uma TASK dentro do quadro — não
   * um segundo paradigma). Vive em `TaskCardInner` (não aqui) porque
   * precisa comparar a posição do ponteiro contra os REFS das 4 colunas
   * irmãs, algo que um item sozinho não enxerga. */
  onDragPointerDown: (e: React.PointerEvent) => void;
}) {
  const badge = originBadge(task.lastActor);
  const cardRoles = task.cards.map((c) => c.role);
  const purposeChip = derivePurposeChip(task.purpose, task.deps, task.depPurposes, cardRoles);
  const stage = deriveStage(task.status, task.report !== null);
  const showStage = Boolean(stage && shouldShowStageTrail(task.purpose, cardRoles));
  // Quem disse "aprovado" importa: a proposta vem de `task_verdicts` (com
  // papel), não do relatório do card principal — ver
  // `deriveCompletionProposal`. `origin: "self"` = implementador sem
  // reviewer na task; a barra diz isso em texto. Com `review="wanted"`
  // sem reviewer, a barra some e `reviewWantedNotice` explica o stall.
  const proposal = deriveCompletionProposal(task.status, cardRoles, task.verdicts, task.review === "wanted");
  const proposalChip = proposal
    ? describeVerdictChip(proposal.origin === "self" ? "implementer" : "reviewer", proposal.verdict)
    : null;
  const reviewWantedNotice = describeReviewWantedNotice(task.review, cardRoles);
  const waitingOn = waitingOnDep(task.deps, task.depStatuses);
  const pills = computeMetaPills(waitingOn, task.order, task.suggestedOrder, task.verdicts);
  // RODADA 2 — "Mais uma rodada" (segundo botão da barra de proposta): a
  // semântica não estava definida em lugar nenhum do briefing. Implementado
  // como o caso mais simples e mais seguro descrito por ele mesmo —
  // dispensa a proposta ATÉ chegar um veredito novo, sem NENHUMA escrita
  // no banco. `dismissedAtVerdictAt` guarda o `at` da rodada que
  // sustentava a proposta quando o humano dispensou; comparar com o `at`
  // da proposta ATUAL é o que invalida a dispensa sozinho assim que uma
  // rodada nova a substituir (`task_verdicts` é append-only, cada rodada
  // tem o próprio `at`) — sem precisar de um `useEffect` limpando nada.
  // Estado só de UI, local a este item: se o card fechar e reabrir, ou a
  // task sair e voltar da lista, a proposta reaparece — aceitável pro que
  // isto é (um "não agora" efêmero, não uma decisão que precisa sobreviver
  // a um reload).
  const [dismissedAtVerdictAt, setDismissedAtVerdictAt] = useState<number | null>(null);
  const proposeVisible = proposal !== null && proposal.at !== dismissedAtVerdictAt;
  // FIDELIDADE VISUAL (delta 4) — "vivo" agora é o CARD por trás estar
  // vivo de verdade (`task.cardAlive`, `registry.isAlive` do main
  // process), não só a task estar `running`: uma task pode continuar
  // `running` por um instante depois do processo já ter morrido (a janela
  // entre o crash e o Sinal 2 derrubar pra `failed`), e a varredura nesse
  // intervalo mentiria "isto está acontecendo agora". Antes disto, esta
  // aproximação era documentada como deliberadamente imprecisa por medo
  // de custo de N chamadas por task — `registry.isAlive` é um Map em
  // memória, O(1), então esse medo não se sustentava.
  const alive = isTaskCardLive(task.status, task.cardAlive);
  // Delta 6 — trilha de transição com horários, dado que já existe desde
  // a Fase 1 (`task_transitions`) e agora chega em TODA task, não só
  // atrás do toggle de gráficos.
  const trail = describeTransitionTrail(task.statusTransitions);
  // Delta 8 — marca de movimento humano. `describeHumanMoveNotice` já
  // decide as DUAS condições (último ator humano + card ainda vivo); este
  // componente só entrega o resultado.
  const humanMoveNotice = describeHumanMoveNotice(task.lastActor, task.cardAlive, task.cardId);
  const divergenceNotice = describeStatusDivergence(task.divergedStatus, task.divergedActor);
  const statusAskNotice = describeStatusAskNotice(task.requestedStatus);
  const interruptNotice = task.interruptionReason;
  const parsedPrompt = parseTaskPrompt(task.prompt);
  return (
    <div className={styles.item} data-task-item-id={task.id} onPointerDown={onDragPointerDown}>
      <div className={styles.itemTop}>
        <span className={styles.dragHandle} data-part="drag-handle" aria-hidden="true">
          <Icon name="grip" size={12} />
        </span>
        <span className={styles.rank} data-part="task-rank">
          {rank}
        </span>
        <span className={styles.taskId} data-part="task-id">
          {shortTaskId(task.id)}
        </span>
        {badge && (
          <span className={styles.badge} data-part="origin-badge">
            {badge}
          </span>
        )}
        <span className={styles.age} data-part="task-age">
          {formatTaskAge(task.createdAt, now)}
        </span>
      </div>
      {/* No purpose → no chip. Absence is NORMAL; do not invent a label. */}
      {purposeChip && (
        <div className={styles.purposeChip} data-part="purpose-chip">
          {describePurposeChip(purposeChip)}
        </div>
      )}
      <div className={styles.prompt}>{parsedPrompt.original || t("task.noPrompt")}</div>
      {task.cards.length > 0 && (
        <div className={styles.chips}>
          {task.cards.map((c) => (
            <CardChip key={c.cardId} cardId={c.cardId} role={c.role} provider={c.provider} label={c.label} />
          ))}
        </div>
      )}
      {pills.length > 0 && (
        <div className={styles.pills} data-part="task-pills">
          {pills.map((p, i) => (
            <span key={i} className={PILL_CLASS[p.kind]}>
              {p.text}
            </span>
          ))}
        </div>
      )}
      {/* Uma vez que a barra de proposta aparece, a trilha de etapa fica
          redundante (propor conclusão já diz "passou pela review") —
          comparação lado a lado com o protótipo confirmou que ele nunca
          mostra as duas juntas. */}
      {showStage && !proposeVisible && (
        <div className={styles.stageTrail} data-part="stage-trail">
          <span className={`${styles.stageSeg} ${stage === "implementar" ? styles.stageSegActive : ""}`}>{t("task.stage.implement")}</span>
          <span className={`${styles.stageSeg} ${stage === "review" ? styles.stageSegActive : ""}`}>{t("task.stage.review")}</span>
        </div>
      )}
      {trail && (
        <div className={styles.transitionTrail} data-part="transition-trail">
          {trail}
        </div>
      )}
      {proposeVisible && proposal && proposalChip && (
        <div className={styles.proposeBar} data-part="propose-bar" data-origin={proposal.origin}>
          <span className={styles.proposeText}>
            <span className={styles.verdictChip} data-part="verdict-chip" data-tone={proposalChip.tone}>
              {proposalChip.label}
            </span>
            {proposal.origin === "self" ? t("task.propose.self") : t("task.propose")}
          </span>
          <span className={styles.proposeActions}>
            <button type="button" data-no-drag className={styles.proposeSecondary} onClick={() => setDismissedAtVerdictAt(proposal.at)}>
              {t("task.anotherRound")}
            </button>
            <button type="button" data-no-drag onClick={() => onApproveCompletion(task.id)}>
              {t("task.conclude")}
            </button>
          </span>
        </div>
      )}
      {humanMoveNotice && (
        <div className={styles.humanMoveNotice} data-part="human-move-notice">
          {humanMoveNotice}
        </div>
      )}
      {divergenceNotice && (
        <div className={styles.divergenceNotice} data-part="status-divergence">
          {divergenceNotice}
        </div>
      )}
      {statusAskNotice && (
        <div className={styles.statusAskNotice} data-part="status-ask-notice">
          {statusAskNotice}
        </div>
      )}
      {reviewWantedNotice && (
        <div className={styles.statusAskNotice} data-part="review-wanted-notice">
          {reviewWantedNotice}
        </div>
      )}
      {interruptNotice && (
        <div className={styles.interruptNotice} data-part="interruption-reason">
          {t("task.interrupted", { reason: interruptNotice })}
        </div>
      )}
      {alive && (
        <div className={`${styles.activity} ${styles.on}`} data-part="activity-sweep">
          <div className={styles.activitySweep} />
        </div>
      )}
    </div>
  );
}

/** Fila click — all task fields, prompt edit via `updatePrompt`, and the
 * live divergence that a board row can otherwise hide in a clamp. Portaled
 * to `document.body` so screen-projected card transform never clips it.
 * Does not go through App.tsx (settings modal lives there). */
function TaskDetailModal({
  task,
  now,
  readOnly,
  onClose,
}: {
  task: TaskBoardItem;
  now: number;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { modalProps } = useModal({ onClose });
  const parsed = parseTaskPrompt(task.prompt);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creator = originBadge(task.firstActor);
  const creatorCard = task.cards.find((c) => c.role === "implementer") ?? task.cards[0] ?? null;
  const trail = describeTransitionTrail(task.statusTransitions);
  const divergenceNotice = describeStatusDivergence(task.divergedStatus, task.divergedActor);
  const statusAskNotice = describeStatusAskNotice(task.requestedStatus);
  const humanMoveNotice = describeHumanMoveNotice(task.lastActor, task.cardAlive, task.cardId);
  const waitingOn = waitingOnDep(task.deps, task.depStatuses);

  async function submitPrompt(mode: "append" | "replace") {
    const trimmed = draft.trim();
    if (!trimmed || busy || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.tasks.updatePrompt(task.id, trimmed, mode);
      if (!res.ok) {
        setError(t("task.detail.error", { error: res.error }));
        return;
      }
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  async function respondAsk(allowed: boolean) {
    if (busy || readOnly || !task.requestedStatus) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.tasks.respondStatusAsk(task.id, allowed);
      if (!res.ok) setError(t("task.detail.error", { error: res.error }));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-root"
      data-part="task-detail-modal"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onClose} />
      <div className={`modal ${styles.detailModal}`} {...modalProps} aria-labelledby="task-detail-title">
        <div className={styles.detailHead}>
          <h3 id="task-detail-title">{t("task.detail.title", { id: shortTaskId(task.id) })}</h3>
          <button type="button" className={styles.detailClose} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <div className={styles.detailBody}>
          <div className={styles.detailMeta}>
            <span>
              {t("task.detail.status")}: {statusLabel(task.status)}
            </span>
            <span data-part="task-age">{formatTaskAge(task.createdAt, now)}</span>
            {task.provider && (
              <span>
                {t("task.detail.provider")}: {task.provider}
              </span>
            )}
            {task.retryCount > 0 && <span>{t("task.detail.retry", { n: task.retryCount })}</span>}
          </div>
          <div className={styles.detailCreator} data-part="task-detail-creator">
            {creator ? t("task.detail.createdBy", { actor: creator }) : t("task.detail.createdUnknown")}
            {creatorCard && (
              <span className={styles.detailCreatorCard}>{t("task.detail.creatorCard", { card: describeLinkedCard(creatorCard) })}</span>
            )}
          </div>
          {readOnly && (
            <div className={styles.detailHint} data-part="task-detail-frozen">
              {t("task.detail.frozen")}
            </div>
          )}
          {divergenceNotice && (
            <div className={styles.divergenceNotice} data-part="status-divergence">
              {divergenceNotice}
            </div>
          )}
          {statusAskNotice && task.requestedStatus && (
            <div className={styles.statusAsk} data-part="status-ask">
              <div className={styles.statusAskTitle}>{t("task.statusAsk.title")}</div>
              <p>
                <strong>{task.requestedBy ?? t("task.badge.agent")}</strong> {t("agentAsk.pedes")}
              </p>
              <code className={styles.statusAskCommand}>
                {t("task.statusAsk.command", { from: statusLabel(task.status), to: statusLabel(task.requestedStatus) })}
              </code>
              {task.requestedReason && (
                <p className={styles.statusAskReason}>
                  <span className={styles.statusAskReasonLabel}>{t("agentAsk.reason")}</span> {task.requestedReason}
                </p>
              )}
              {!readOnly && (
                <div className="modal-actions">
                  <button type="button" className="ghost" data-part="status-ask-deny" disabled={busy} onClick={() => void respondAsk(false)}>
                    {t("agentAsk.deny")}
                  </button>
                  <button type="button" className="primary" data-part="status-ask-allow" disabled={busy} onClick={() => void respondAsk(true)}>
                    {t("agentAsk.allow")}
                  </button>
                </div>
              )}
            </div>
          )}
          {humanMoveNotice && (
            <div className={styles.humanMoveNotice} data-part="human-move-notice">
              {humanMoveNotice}
            </div>
          )}
          {task.interruptionReason && (
            <div className={styles.interruptNotice} data-part="interruption-reason">
              {t("task.interrupted", { reason: task.interruptionReason })}
            </div>
          )}

          <section>
            <div className={styles.detailSectionTitle}>{t("task.detail.prompt")}</div>
            <div className={styles.detailPromptBlock} data-part="task-detail-prompt-original">
              <span className={styles.detailPromptLabel}>{t("task.detail.promptOriginal")}</span>
              {parsed.original || t("task.noPrompt")}
            </div>
            {parsed.additions.map((addition, i) => (
              <div key={`${addition.at}-${i}`} className={styles.detailPromptBlock} data-part="task-detail-prompt-added">
                <span className={styles.detailPromptLabel}>{t("task.detail.promptAdded", { when: formatPromptWhen(addition.at) })}</span>
                {addition.text}
              </div>
            ))}
            {!readOnly && (
              <>
                <textarea
                  data-part="task-detail-prompt-draft"
                  data-no-drag
                  className={styles.detailDraft}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t("task.detail.promptPlaceholder")}
                  disabled={busy}
                  aria-label={t("task.detail.prompt")}
                />
                <p className={styles.detailHint}>{t("task.detail.replaceHint")}</p>
                {error && (
                  <p className={styles.detailError} data-part="task-detail-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="modal-actions">
                  <button type="button" className="ghost" data-part="task-detail-replace" disabled={busy || !draft.trim()} onClick={() => void submitPrompt("replace")}>
                    {t("task.detail.replace")}
                  </button>
                  <button type="button" className="primary" data-part="task-detail-append" disabled={busy || !draft.trim()} onClick={() => void submitPrompt("append")}>
                    {t("task.detail.append")}
                  </button>
                </div>
              </>
            )}
          </section>

          <section>
            <div className={styles.detailSectionTitle}>{t("task.detail.cards")}</div>
            {task.cards.length === 0 ? (
              <div className={styles.detailEmpty}>{t("task.detail.noCards")}</div>
            ) : (
              <div className={styles.chips}>
                {task.cards.map((c) => (
                  <CardChip key={c.cardId} cardId={c.cardId} role={c.role} provider={c.provider} label={c.label} />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className={styles.detailSectionTitle}>{t("task.detail.verdicts")}</div>
            {task.verdicts.length === 0 ? (
              <div className={styles.detailEmpty}>{t("task.detail.noVerdicts")}</div>
            ) : (
              <div className={styles.detailList}>
                {task.verdicts.map((v, i) => {
                  const chip = describeVerdictChip(v.role, v.verdict);
                  return (
                  <div key={`${v.cardId}-${v.at}-${i}`} className={styles.detailVerdict} data-part="task-detail-verdict">
                    <span>{t("task.detail.verdictRound", { n: i + 1 })}</span>
                    <span className={styles.chipId}>{v.cardId}</span>
                    <span className={styles.chipRole}>{describeCardRole(v.role)}</span>
                    <span className={styles.verdictChip} data-part="verdict-chip" data-tone={chip.tone}>
                      {chip.label}
                    </span>
                    {v.provider && <span className={styles.age}>{v.provider}</span>}
                    <span className={styles.detailVerdictWhen}>{formatPromptWhen(v.at)}</span>
                  </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className={styles.detailSectionTitle}>{t("task.detail.history")}</div>
            {trail ? <div className={styles.transitionTrail}>{trail}</div> : <div className={styles.detailEmpty}>{t("task.detail.noHistory")}</div>}
          </section>

          <section>
            <div className={styles.detailSectionTitle}>{t("task.detail.deps")}</div>
            {task.deps.length === 0 ? (
              <div className={styles.detailEmpty}>{t("task.detail.noDeps")}</div>
            ) : waitingOn ? (
              <div className={styles.detailEmpty}>{waitingOn.status === undefined ? t("task.waitUnknown", { id: shortTaskId(waitingOn.depId) }) : t("task.wait", { id: shortTaskId(waitingOn.depId) })}</div>
            ) : (
              <div className={styles.detailEmpty}>{task.deps.map((id) => shortTaskId(id)).join(" · ")}</div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Formulário pra o humano criar task na coluna "a fazer". */
function CreateTaskForm({ boardId, onCreated }: { boardId: string; onCreated: (taskId: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const res = await window.tasks.create(boardId, trimmed);
      if (res.ok) {
        setPrompt("");
        onCreated(res.taskId);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <form data-part="create-task-form" className={styles.createTaskForm} onSubmit={submit} onPointerDown={(e) => e.stopPropagation()}>
      <input
        data-part="create-task-input"
        data-no-drag
        className={styles.createTaskInput}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t("task.createPlaceholder")}
        disabled={busy}
        aria-label={t("task.create")}
      />
      <button type="submit" data-no-drag data-part="create-task-submit" className={styles.createTaskSubmit} disabled={busy || !prompt.trim()}>
        {t("common.create").toLowerCase()}
      </button>
    </form>
  );
}

/** Gráfico 1 — reprovações por provider (barras empilhadas). */
function VerdictsByProviderChart({ data }: { data: { provider: string; approved: number; rejected: number }[] }) {
  const W = 280;
  const ROW_H = 20;
  const PAD = 6;
  const LABEL_W = 72;
  const VALUE_W = 40;
  const barAreaW = W - LABEL_W - VALUE_W - PAD * 2;
  const maxTotal = Math.max(1, ...data.map((d) => d.approved + d.rejected));
  const height = Math.max(ROW_H, data.length * ROW_H) + PAD * 2;
  return (
    <div className={styles.chartBox} data-part="chart-verdicts">
      <div className={styles.chartTitle}>{t("task.charts.rejections")}</div>
      {data.length === 0 ? (
        <div className={styles.chartEmpty}>{t("task.charts.rejectionsEmpty")}</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={t("task.charts.rejectionsAria")}>
            {data.map((d, i) => {
              const y = PAD + i * ROW_H;
              const approvedW = (d.approved / maxTotal) * barAreaW;
              const rejectedW = (d.rejected / maxTotal) * barAreaW;
              return (
                <g key={d.provider}>
                  <text x={0} y={y + ROW_H / 2 + 3} fontFamily="var(--font-mono)" fontSize="9" fill="var(--muted)">
                    {d.provider}
                  </text>
                  <rect x={LABEL_W} y={y + 3} width={Math.max(0, approvedW)} height={ROW_H - 8} fill="var(--good)" />
                  <rect x={LABEL_W + approvedW} y={y + 3} width={Math.max(0, rejectedW)} height={ROW_H - 8} fill="var(--danger)" />
                  <text x={LABEL_W + barAreaW + 4} y={y + ROW_H / 2 + 3} fontSize="9" fill="var(--text)">
                    {d.approved} / {d.rejected}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className={styles.chartLegend}>
            <span>
              <span className={styles.legendSwatchApproved} /> aprovado
            </span>
            <span>
              <span className={styles.legendSwatchRejected} /> reprovado
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Gráfico 2 — rodadas até aprovar. */
function RoundsToApproveChart({ data }: { data: { taskId: string; label: string; rounds: number }[] }) {
  const W = 280;
  const ROW_H = 20;
  const PAD = 6;
  const LABEL_W = 72;
  const VALUE_W = 28;
  const barAreaW = W - LABEL_W - VALUE_W - PAD * 2;
  const maxRounds = Math.max(1, ...data.map((d) => d.rounds));
  const height = Math.max(ROW_H, data.length * ROW_H) + PAD * 2 + 14;
  const axisMid = maxRounds / 2;
  return (
    <div className={styles.chartBox} data-part="chart-rounds">
      <div className={styles.chartTitle}>{t("task.charts.rounds")}</div>
      {data.length === 0 ? (
        <div className={styles.chartEmpty}>{t("task.charts.roundsEmpty")}</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={t("task.charts.roundsAria")}>
            {data.map((d, i) => {
              const y = PAD + i * ROW_H;
              const w = (d.rounds / maxRounds) * barAreaW;
              const fill = roundsBarTone(d.rounds) === "expensive" ? "var(--signal)" : "var(--foam)";
              return (
                <g key={d.taskId}>
                  <text x={0} y={y + ROW_H / 2 + 3} fontFamily="var(--font-mono)" fontSize="9" fill="var(--muted)">
                    {d.label}
                  </text>
                  <rect x={LABEL_W} y={y + 3} width={Math.max(0, w)} height={ROW_H - 8} fill={fill} />
                  <text x={LABEL_W + barAreaW + 4} y={y + ROW_H / 2 + 3} fontSize="9" fill="var(--text)">
                    {d.rounds}
                  </text>
                </g>
              );
            })}
            <text x={LABEL_W} y={height - 2} fontSize="9" fill="var(--muted)">
              0
            </text>
            <text x={LABEL_W + barAreaW / 2} y={height - 2} fontSize="9" fill="var(--muted)" textAnchor="middle">
              {axisMid % 1 === 0 ? axisMid : axisMid.toFixed(1)}
            </text>
            <text x={LABEL_W + barAreaW} y={height - 2} fontSize="9" fill="var(--muted)" textAnchor="end">
              {maxRounds} rodadas
            </text>
          </svg>
        </>
      )}
    </div>
  );
}

/** Gráfico 3 — tempo em cada estado, barras empilhadas + eixo + legenda. */
function CycleTimeChart({ data, loading }: { data: { id: string; queuedHours: number; runningHours: number }[]; loading: boolean }) {
  const W = 280;
  const ROW_H = 20;
  const PAD = 6;
  const LABEL_W = 46;
  const VALUE_W = 40;
  const barAreaW = W - LABEL_W - VALUE_W - PAD * 2;
  const maxTotal = Math.max(1e-6, ...data.map((d) => d.queuedHours + d.runningHours));
  const axis = cycleAxisMarks(maxTotal);
  const height = Math.max(ROW_H, data.length * ROW_H) + PAD * 2;
  return (
    <div className={styles.chartBox} data-part="chart-cycle">
      <div className={styles.chartTitle}>{t("task.charts.cycle")}</div>
      {loading ? (
        <div className={styles.chartEmpty}>{t("common.loading")}</div>
      ) : data.length === 0 ? (
        <div className={styles.chartEmpty}>{t("task.charts.cycleEmpty")}</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={t("task.charts.cycle")}>
            {data.map((d, i) => {
              const y = PAD + i * ROW_H;
              const queuedW = (d.queuedHours / maxTotal) * barAreaW;
              const runningW = (d.runningHours / maxTotal) * barAreaW;
              return (
                <g key={d.id}>
                  <text x={0} y={y + ROW_H / 2 + 3} fontFamily="var(--font-mono)" fontSize="9" fill="var(--muted)">
                    {shortTaskId(d.id)}
                  </text>
                  <rect x={LABEL_W} y={y + 3} width={barAreaW} height={ROW_H - 8} fill="var(--surface)" />
                  <rect x={LABEL_W} y={y + 3} width={Math.max(0, queuedW)} height={ROW_H - 8} fill="var(--border)" />
                  <rect x={LABEL_W + queuedW} y={y + 3} width={Math.max(0, runningW)} height={ROW_H - 8} fill="var(--foam)" />
                  <text x={LABEL_W + barAreaW + 4} y={y + ROW_H / 2 + 3} fontSize="9" fill="var(--text)">
                    {(d.queuedHours + d.runningHours).toFixed(1)}h
                  </text>
                </g>
              );
            })}
          </svg>
          <div className={styles.chartAxis} data-part="chart-cycle-axis">
            {axis.map((m) => (
              <span key={m.label}>{m.label}</span>
            ))}
          </div>
          <div className={styles.chartLegend}>
            <span>
              <span className={styles.legendSwatchQueued} /> parada na fila
            </span>
            <span>
              <span className={styles.legendSwatchRunning} /> executando
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Painel de gráficos — escondido por padrão. Vereditos vêm das tasks
 * passadas (quadro vivo ou snapshot congelado). Transições do gráfico 3:
 * ao vivo só quando `liveTransitions` — nunca consultar o board ativo
 * enquanto se visualiza um sprint fechado. */
function ChartsPanel({
  boardId,
  tasks,
  liveTransitions,
}: {
  boardId: string;
  tasks: TaskBoardItem[];
  liveTransitions: boolean;
}) {
  const [transitionsByTask, setTransitionsByTask] = useState<Record<string, { toValue: string; at: number }[]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!liveTransitions) {
      // Frozen view: use trails already on the snapshot stubs (usually
      // empty) — never `transitionsByBoard` of the live sprint.
      const grouped: Record<string, { toValue: string; at: number }[]> = {};
      for (const t of tasks) {
        if (t.statusTransitions.length > 0) grouped[t.id] = t.statusTransitions;
      }
      setTransitionsByTask(grouped);
      return;
    }
    setTransitionsByTask(null);
    window.tasks.transitionsByBoard(boardId).then((rows) => {
      if (cancelled) return;
      const grouped: Record<string, { toValue: string; at: number }[]> = {};
      for (const r of rows) {
        const list = grouped[r.task_id] ?? [];
        list.push({ toValue: r.to_value, at: r.at });
        grouped[r.task_id] = list;
      }
      setTransitionsByTask(grouped);
    });
    return () => {
      cancelled = true;
    };
  }, [boardId, liveTransitions, tasks]);

  const allVerdicts = tasks.flatMap((t) => t.verdicts.map((v) => ({ verdict: v.verdict, provider: v.provider, at: v.at })));
  const verdictsByProvider = computeVerdictsByProvider(allVerdicts);
  const roundsData = computeRoundsToApprove(
    tasks.map((t) => ({
      taskId: t.id,
      label: shortTaskId(t.id),
      verdicts: t.verdicts.map((v) => ({ verdict: v.verdict, provider: v.provider, at: v.at })),
    })),
  );

  const now = Date.now();
  const cycleData =
    transitionsByTask === null
      ? []
      : tasks
          .map((t) => {
            const cycle = computeCycleTime(transitionsByTask[t.id] ?? [], now);
            return { id: t.id, queuedHours: msToHours(cycle.queuedMs), runningHours: msToHours(cycle.runningMs) };
          })
          .filter((d) => d.queuedHours > 0 || d.runningHours > 0);

  return (
    <div className={styles.chartsPanel} data-part="charts-panel">
      <div className={styles.chartsGrid}>
        <VerdictsByProviderChart data={verdictsByProvider} />
        <RoundsToApproveChart data={roundsData} />
        <CycleTimeChart data={cycleData} loading={liveTransitions && transitionsByTask === null} />
      </div>
    </div>
  );
}

/** DESIGN-BACKLOG.md §2.0 — um painel só: ver, renomear, fechar, excluir.
 * Contagens de sprint FECHADO vêm do snapshot congelado (nunca recalculadas).
 * Fechar/excluir moram aqui (não no header) — peso destrutivo separado do toggle. */
function SprintsPanel({
  boardId,
  reloadKey,
  selectedId,
  viewingFrozen,
  onSelect,
  onClosed,
  onRenamed,
  onDeleted,
  closingSprint,
  setClosingSprint,
}: {
  boardId: string;
  reloadKey: number;
  selectedId: string | null;
  viewingFrozen: boolean;
  onSelect: (sprint: SprintView) => void;
  onClosed: () => void;
  onRenamed: () => void;
  onDeleted: () => void;
  closingSprint: boolean;
  setClosingSprint: (v: boolean) => void;
}) {
  const [sprints, setSprints] = useState<SprintView[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<null | { kind: "close" | "delete"; sprintId: string }>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const skipRenameBlurRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setSprints(null);
    window.tasks.listSprints(boardId).then((rows) => {
      if (cancelled) return;
      setSprints(
        rows.map((r) => ({
          id: r.id,
          number: r.number,
          name: r.name,
          startedAt: r.startedAt,
          closedAt: r.closedAt,
          countTodo: r.countTodo,
          countDoing: r.countDoing,
          countDone: r.countDone,
          countFailed: r.countFailed,
          migratedIn: r.migratedIn,
          migratedOut: r.migratedOut,
          hasSnapshot: r.hasSnapshot,
        })),
      );
      setNow(Date.now());
    });
    return () => {
      cancelled = true;
    };
  }, [boardId, reloadKey]);

  async function commitRename(sprintId: string) {
    setRenameError(null);
    const res = await window.tasks.renameSprint(sprintId, editDraft);
    if (!res.ok) {
      setRenameError(res.error);
      return;
    }
    setEditingId(null);
    onRenamed();
  }

  async function confirmPending() {
    if (!pendingAction || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      if (pendingAction.kind === "close") {
        setClosingSprint(true);
        try {
          const res = await window.tasks.closeSprint(boardId);
          if (!res.ok) {
            setActionError(res.error);
            return;
          }
          setPendingAction(null);
          onClosed();
        } finally {
          setClosingSprint(false);
        }
      } else {
        const res = await window.tasks.deleteSprint(pendingAction.sprintId);
        if (!res.ok) {
          setActionError(res.error);
          return;
        }
        setPendingAction(null);
        onDeleted();
      }
    } finally {
      setBusy(false);
    }
  }

  const active = sprints?.find((s) => s.closedAt === null) ?? null;

  return (
    <div className={styles.sprintsPanel} data-part="sprints-panel">
      <div className={styles.sprintsTitle}>{t("task.sprintsTitle")}</div>
      {sprints === null ? (
        <div className={styles.chartEmpty}>{t("common.loading")}</div>
      ) : sprints.length === 0 ? (
        <div className={styles.chartEmpty}>{t("task.sprintsEmpty")}</div>
      ) : (
        <ul className={styles.sprintsList} role="listbox" aria-label={t("task.sprints")}>
          {sprints.map((s) => {
            const open = s.closedAt === null;
            const selected = selectedId === s.id || (selectedId === null && open);
            const editing = editingId === s.id;
            return (
              <li key={s.id} className={styles.sprintItem}>
                <button
                  type="button"
                  data-part="sprint-row"
                  data-sprint-open={open ? "true" : "false"}
                  data-sprint-selected={selected ? "true" : "false"}
                  className={`${styles.sprintRow} ${selected ? styles.sprintRowSelected : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    if (editing) return;
                    onSelect(s);
                  }}
                >
                  <div className={styles.sprintHead}>
                    {editing ? (
                      <input
                        data-part="sprint-rename-input"
                        data-no-drag
                        className={styles.sprintRenameInput}
                        value={editDraft}
                        autoFocus
                        aria-label={t("task.sprintName")}
                        placeholder={t("task.sprintDefault", { number: s.number })}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitRename(s.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            skipRenameBlurRef.current = true;
                            setEditingId(null);
                            setRenameError(null);
                          }
                        }}
                        onBlur={() => {
                          if (skipRenameBlurRef.current) {
                            skipRenameBlurRef.current = false;
                            return;
                          }
                          void commitRename(s.id);
                        }}
                      />
                    ) : (
                      <span className={styles.sprintId} data-part="sprint-id">
                        {sprintLabel(s)}
                      </span>
                    )}
                    <span className={styles.sprintState} data-part="sprint-state">
                      {open ? "em curso" : "fechado"}
                    </span>
                    <span className={styles.sprintDuration} data-part="sprint-duration">
                      {formatSprintDuration(s.startedAt, s.closedAt, now)}
                    </span>
                  </div>
                  <div className={styles.sprintWhen} data-part="sprint-when">
                    {formatSprintTimestamp(s.startedAt)}
                    {" → "}
                    {s.closedAt ? formatSprintTimestamp(s.closedAt) : "agora"}
                    <span className={styles.sprintIdHint}> · {shortSprintId(s.id)}</span>
                  </div>
                  {!open && (
                    <div className={styles.sprintCounts} data-part="sprint-counts">
                      {describeSprintCounts(s)}
                    </div>
                  )}
                  {open && s.migratedIn > 0 && (
                    <div className={styles.sprintCounts} data-part="sprint-counts">
                      veio migrado: {s.migratedIn}
                    </div>
                  )}
                </button>
                <div className={styles.sprintActions} data-part="sprint-actions">
                  <button
                    type="button"
                    data-part="sprint-rename"
                    data-no-drag
                    className={styles.sprintActionBtn}
                    title={t("common.rename")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(s.id);
                      setEditDraft(s.name ?? "");
                      setRenameError(null);
                    }}
                  >
                    renomear
                  </button>
                  {open && (
                    <>
                      <button
                        type="button"
                        data-part="sprint-close-action"
                        data-no-drag
                        className={`${styles.sprintActionBtn} ${styles.sprintActionQuiet}`}
                        title={t("task.sprintClose")}
                        disabled={closingSprint || viewingFrozen || busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingAction({ kind: "close", sprintId: s.id });
                          setActionError(null);
                        }}
                      >
                        fechar
                      </button>
                      <button
                        type="button"
                        data-part="sprint-delete-action"
                        data-no-drag
                        className={`${styles.sprintActionBtn} ${styles.sprintActionDanger}`}
                        title={t("task.sprintDelete")}
                        disabled={busy || viewingFrozen}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingAction({ kind: "delete", sprintId: s.id });
                          setActionError(null);
                        }}
                      >
                        excluir
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {renameError && (
        <div className={styles.sprintCloseError} data-part="sprint-rename-error" role="alert">
          {renameError}
        </div>
      )}
      {pendingAction && (
        <div className={styles.sprintConfirm} data-part="sprint-confirm" role="alertdialog">
          <p>
            {pendingAction.kind === "close"
              ? t("task.sprintCloseConfirm", { label: active ? sprintLabel(active) : t("task.sprintCurrent") })
              : t("task.sprintDeleteConfirm", { label: active ? sprintLabel(active) : t("task.sprintCurrent") })}
          </p>
          <div className={styles.sprintConfirmActions}>
            <button
              type="button"
              data-no-drag
              className={styles.sprintActionBtn}
              disabled={busy}
              onClick={() => setPendingAction(null)}
            >
              {t("common.cancel").toLowerCase()}
            </button>
            <button
              type="button"
              data-no-drag
              data-part="sprint-confirm-go"
              className={`${styles.sprintActionBtn} ${styles.sprintActionDanger}`}
              disabled={busy || closingSprint}
              onClick={() => void confirmPending()}
            >
              {pendingAction.kind === "close" ? t("task.sprintCloseNow") : t("task.sprintDeleteNow")}
            </button>
          </div>
        </div>
      )}
      {actionError && (
        <div className={styles.sprintCloseError} data-part="sprint-action-error" role="alert">
          {actionError}
        </div>
      )}
    </div>
  );
}

function TaskCardInner({
  rect,
  zoom,
  zIndex,
  interactionMode,
  selected,
  reflowing,
  closing,
  displayName,
  tasks,
  concurrencyCapRaw,
  activeBoardId,
  boardNames,
  taskCountsByBoard,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onConnectorStart,
  onSelectStart,
  onApproveCompletion,
  screenProjected,
  panX,
  panY,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  displayName: string;
  /** Já vem "achatada" com selo/chips/relatório prontos — ver
   * `main/index.ts`'s `buildTaskBoard` e `preload/index.ts`'s
   * `TaskBoardItem`. Empurrada por `window.tasks.onChanged` (App.tsx),
   * nunca por poll. */
  tasks: TaskBoardItem[];
  /** RODADA 2 — `BoardRow.concurrency_cap` cru (`null` = "usar o
   * default"), já carregado no estado `boards` de App.tsx — nenhuma
   * consulta nova só pro badge de WIP, ver `resolveConcurrencyCap`. */
  concurrencyCapRaw: number | null;
  /** RODADA 3, peça 5 — rodapé de escopo. `taskCountsByBoard` é GLOBAL
   * (todo board, não só este), `boardNames` é `{boardId: nome}` de
   * `App.tsx`'s próprio estado `boards` (`useMemo`, ver seu comentário) —
   * um boardId ausente daqui é um board que não existe mais (o achado
   * desta rodada). */
  activeBoardId: string;
  boardNames: Record<string, string>;
  taskCountsByBoard: Record<string, number>;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** DESIGN-BACKLOG.md §2.1 decisões 8/9 — aceita a proposta de conclusão
   * de um report aprovado. O OUTRO caminho de escrita desta fase —
   * arrastar entre colunas (peça 3) — é `beginTaskDrag`/`onDropTask`,
   * dentro deste próprio componente (precisa dos refs das 4 colunas
   * irmãs, não faz sentido como prop vindo de fora). */
  onApproveCompletion: (taskId: string) => void;
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [chartsOpen, setChartsOpen] = useState(false);
  const [sprintsOpen, setSprintsOpen] = useState(false);
  const [sprintsReloadKey, setSprintsReloadKey] = useState(0);
  const [closingSprint, setClosingSprint] = useState(false);
  /** null = live active sprint (default). Closed id → frozen snapshot board. */
  const [viewingSprintId, setViewingSprintId] = useState<string | null>(null);
  const [viewingSprintMeta, setViewingSprintMeta] = useState<SprintView | null>(null);
  const [activeSprintLabel, setActiveSprintLabel] = useState<string | null>(null);
  const [frozenTasks, setFrozenTasks] = useState<TaskBoardItem[] | null>(null);

  const viewingFrozen = viewingSprintId !== null && frozenTasks !== null;
  const boardTasks = viewingFrozen ? frozenTasks : tasks;
  const openTask = openTaskId ? (boardTasks.find((item) => item.id === openTaskId) ?? null) : null;
  useEffect(() => {
    if (openTaskId && !openTask) setOpenTaskId(null);
  }, [openTaskId, openTask]);
  const groups = groupTasksByColumn(boardTasks);
  // FASE 2, peça 3 — `onDropTask` é chamado de dentro de um listener de
  // `window` registrado no INÍCIO do arraste (`beginTaskDrag`); se um push
  // de `task:changed` re-renderizar este componente NO MEIO de um arraste
  // em andamento (nova `tasks`, novo `groups`), esse listener continua
  // fechado sobre o `groups` de quando o arraste começou, a menos que leia
  // de uma ref — mesmo motivo de `CardFrame.tsx`'s `rectRef` existir (lido
  // dentro de listeners de `window` iguais a este, pelo mesmo risco de
  // closure velha).
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const cap = resolveConcurrencyCap(concurrencyCapRaw);
  // RODADA 4 — relógio ÚNICO do card (nunca um setInterval por task).
  // Granularidade de `formatTaskAge` é minuto; 15s basta pra "agora"→"1min"
  // sem acordar o renderer à toa.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  // DESIGN-BACKLOG.md §2.3, peça 6 — "painel escondido por padrão":
  // `false` na montagem, `ChartsPanel` só monta (e só então busca as
  // transições, ver seu próprio `useEffect`) quando isto vira `true` —
  // enquanto ninguém nunca abriu, a consulta nunca roda. Fechar desmonta
  // `ChartsPanel`; abrir de novo remonta e busca de novo — deliberado
  // (não cacheado): dado fresco a cada abertura é mais barato de garantir
  // do que invalidar um cache certo, e a consulta é uma só (JOIN, sem
  // N+1) mesmo assim.

  useEffect(() => {
    // Chaves em volta de propósito: `onSprintsChanged` devolve um cleanup
    // que por sua vez devolve o `IpcRenderer` do `removeListener`, e o
    // `EffectCallback` do React exige `void | Destructor`. Sem as chaves o
    // tipo vaza e o tsc recusa. Mesmo formato usado nos outros listeners
    // deste arquivo.
    const off = window.tasks.onSprintsChanged((id) => {
      if (id === activeBoardId) setSprintsReloadKey((k) => k + 1);
    });
    return () => {
      off();
    };
  }, [activeBoardId]);

  useEffect(() => {
    let cancelled = false;
    window.tasks.listSprints(activeBoardId).then((rows) => {
      if (cancelled) return;
      const active = rows.find((r) => r.closedAt === null);
      setActiveSprintLabel(active ? sprintLabel(active) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeBoardId, sprintsReloadKey]);

  useEffect(() => {
    if (!viewingSprintId) {
      setFrozenTasks(null);
      setViewingSprintMeta(null);
      return;
    }
    let cancelled = false;
    window.tasks.sprintSnapshot(viewingSprintId).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setViewingSprintId(null);
        setFrozenTasks(null);
        setViewingSprintMeta(null);
        return;
      }
      setViewingSprintMeta({
        id: res.sprint.id,
        number: res.sprint.number,
        name: res.sprint.name,
        startedAt: res.sprint.startedAt,
        closedAt: res.sprint.closedAt,
        countTodo: res.sprint.countTodo,
        countDoing: res.sprint.countDoing,
        countDone: res.sprint.countDone,
        countFailed: res.sprint.countFailed,
        migratedIn: res.sprint.migratedIn,
        migratedOut: res.sprint.migratedOut,
        hasSnapshot: res.sprint.hasSnapshot,
      });
      setFrozenTasks(res.tasks.map((t) => snapshotTaskToBoardItem(t, activeBoardId)));
    });
    return () => {
      cancelled = true;
    };
  }, [viewingSprintId, activeBoardId, sprintsReloadKey]);

  function onSelectSprint(s: SprintView) {
    if (s.closedAt === null) {
      setViewingSprintId(null);
      setFrozenTasks(null);
      setViewingSprintMeta(null);
      return;
    }
    setViewingSprintId(s.id);
  }

  function onSprintClosed() {
    setSprintsReloadKey((k) => k + 1);
    setViewingSprintId(null);
    setFrozenTasks(null);
    setViewingSprintMeta(null);
  }

  function onSprintDeleted() {
    setSprintsReloadKey((k) => k + 1);
    setViewingSprintId(null);
    setFrozenTasks(null);
    setViewingSprintMeta(null);
  }
  // RODADA 4 — aviso quando task criada por humano é pega (ganha card ou
  // vira running). Snapshot anterior × atual; também cobre tasks humanas
  // já no board ao montar (firstActor), não só as criadas nesta sessão.
  const prevClaimSnapRef = useRef<Map<string, { cardId: string | null; status: string }>>(new Map());
  useEffect(() => {
    const prev = prevClaimSnapRef.current;
    const next = new Map<string, { cardId: string | null; status: string }>();
    for (const taskItem of tasks) {
      const snap = { cardId: taskItem.cardId, status: taskItem.status };
      next.set(taskItem.id, snap);
      if (!isHumanCreatedTask(taskItem.firstActor)) continue;
      if (didHumanTaskGetClaimed(prev.get(taskItem.id), snap)) {
        try {
          new Notification(t("task.dragGhost"), { body: taskItem.prompt?.slice(0, 120) || shortTaskId(taskItem.id), silent: false });
        } catch {
          // Notification API indisponível/negada — nunca deve quebrar o quadro.
        }
      }
    }
    prevClaimSnapRef.current = next;
  }, [tasks]);

  // FASE 2, peça 3 — arrastar entre colunas e dentro da coluna. Refs (não
  // estado) pros 4 corpos de coluna: só precisamos da posição/conteúdo
  // REAL do DOM no momento do pointermove/pointerup (hit-test de
  // coordenada de tela), nunca de re-render por causa deles — mesma razão
  // de `CardFrame.tsx`'s `rectRef` existir como ref e não como estado.
  const columnBodyRefs = useRef<Partial<Record<TaskColumn, HTMLDivElement | null>>>({});
  // Estado de fato (precisa re-renderizar): qual task está sendo
  // arrastada (some da lista normal enquanto isso — ver o filtro abaixo)
  // e onde ela pousaria se soltasse agora (a "zona fantasma").
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ column: TaskColumn; index: number } | null>(null);
  // ACHADO DE REVIEW ADVERSARIAL (RODADA 2, achado 2, MÉDIO-ALTO) —
  // `beginTaskDrag` registrava `pointermove`/`pointerup` no `window` sem
  // nenhuma garantia de remoção fora do caminho feliz: alt-tab durante o
  // arraste (o SO nunca entrega `pointerup`), ou o card fechando/o board
  // trocando NO MEIO do gesto (o componente desmonta), deixavam os dois
  // listeners vivos pra sempre — um clique comum depois rodava `onUp`
  // sobre um `task`/`groupsRef` de um render que já não existe mais.
  // Esta ref guarda a função de limpeza do arraste ATUALMENTE em curso
  // (no máximo um por vez — um humano só tem um ponteiro), permitindo
  // encerrá-lo de FORA de `beginTaskDrag`: no início do PRÓXIMO arraste
  // (rede de segurança caso um anterior tenha escapado) e no unmount do
  // componente (`useEffect` abaixo).
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  /** Acha em qual coluna (se alguma) e em que índice o ponteiro está —
   * comparado contra os itens REALMENTE renderizados ali (exclui a própria
   * task arrastada, que este mesmo componente já tira da lista enquanto
   * `draggingTaskId` estiver setado — ver o JSX abaixo), pela posição
   * vertical do meio de cada item (acima da metade de um item = solta
   * ANTES dele). Mesma técnica de coordenadas de tela que
   * `CardFrame.tsx`'s `onResizePointerDown`/`onHeaderPointerDown` já usam
   * (`getBoundingClientRect`/`clientX`/`clientY`), não uma segunda. */
  function locateDropTarget(taskId: string, clientX: number, clientY: number): { column: TaskColumn; index: number } | null {
    for (const col of COLUMN_ORDER) {
      const el = columnBodyRefs.current[col];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      const items = Array.from(el.querySelectorAll<HTMLElement>("[data-task-item-id]")).filter((n) => n.dataset.taskItemId !== taskId);
      let index = items.length;
      for (let i = 0; i < items.length; i++) {
        const itemRect = items[i].getBoundingClientRect();
        if (clientY < itemRect.top + itemRect.height / 2) {
          index = i;
          break;
        }
      }
      return { column: col, index };
    }
    return null;
  }

  /** DESIGN-BACKLOG.md §2.1, decisão 5 — o drop em si. `destination`
   * exclui a própria task (mesmo filtro de `locateDropTarget`, mesma
   * "lista realmente visível" que decidiu o índice) — `computeColumnDrop`
   * (task-board-model.ts) é quem decide o `order` da arrastada E o
   * `implicitOrder` de qualquer vizinho que precisou virar comparável,
   * puro e testado ali.
   *
   * ACHADO DE REVIEW ADVERSARIAL (RODADA 3, achado 1, ALTO) — a rodada 2
   * gravava `order` real em vizinhos intocados, tornando-os PERMANENTE-
   * MENTE imunes a um `suggestedOrder` futuro do agente (`order` sempre
   * vence, sem exceção). Fix: só a task arrastada (`task.id`) recebe
   * `order`/`status` (`window.tasks.moveTask`'s 1º/2º/3º argumentos);
   * `result.siblingImplicitOrders` grava `implicitOrder` (terceiro nível,
   * nunca `order`) pra quem só precisou virar comparável — zero
   * imunidade, o PRÓXIMO `suggestedOrder` do agente pra essas tasks
   * ainda vence normalmente.
   *
   * Escreve incondicionalmente quando houve movimento de verdade (`onUp`
   * só chama isto com um `target` não-nulo): decisão 5 é "SEMPRE vale" —
   * a Fila mostra a marca de movimento humano; o card de trabalho NÃO
   * recebe push (interrupt não pedido). Status-ask Allow/Deny é outro
   * canal. */
  function onDropTask(task: TaskBoardItem, column: TaskColumn, index: number) {
    const destination = groupsRef.current[column].filter((t) => t.id !== task.id);
    const result = computeColumnDrop(destination, index);
    const status = COLUMN_TO_STATUS[column];
    window.tasks.moveTask(task.id, status, result.order, result.siblingImplicitOrders);
  }

  /** Reaproveita o MESMO gesto pointerdown→pointermove→pointerup que
   * `CardFrame.tsx`'s `onHeaderPointerDown` já usa pra mover um card
   * inteiro (limiar de 4px pra distinguir click de arraste) — nunca um
   * segundo paradigma de arraste (HTML5 `draggable`/`dragstart`, por
   * exemplo) só porque o alvo agora é uma task dentro do quadro em vez do
   * card inteiro.
   *
   * ACHADO DE REVIEW ADVERSARIAL (RODADA 2, achado 2) — `cleanup` agora é
   * o ÚNICO caminho que desliga os listeners, chamado de TODA saída
   * possível do gesto: solto de verdade (`onUp`), cancelado pelo SO
   * (`onCancel` — `pointercancel`, ex.: alt-tab, o navegador decide que
   * isto virou outro gesto), e desmontagem do componente (via
   * `dragCleanupRef`, ver o `useEffect` acima). Também chamada no
   * INÍCIO deste método, como rede de segurança — se um gesto anterior
   * por algum motivo não tiver sido encerrado (não deveria acontecer com
   * as saídas acima cobertas, mas um humano só tem um ponteiro mesmo, um
   * 2º pointerdown só pode significar que o 1º já deveria ter
   * terminado). */
  function beginTaskDrag(task: TaskBoardItem, e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button, select, input, textarea, [data-no-drag]")) return;
    dragCleanupRef.current?.();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    function cleanup() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    }
    function onMove(ev: PointerEvent) {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        moved = true;
        if (!viewingFrozen) setDraggingTaskId(task.id);
      }
      if (!moved || viewingFrozen) return;
      setDragOver(locateDropTarget(task.id, ev.clientX, ev.clientY));
    }
    function onUp(ev: PointerEvent) {
      const target = !viewingFrozen && moved ? locateDropTarget(task.id, ev.clientX, ev.clientY) : null;
      cleanup();
      setDraggingTaskId(null);
      setDragOver(null);
      if (target) onDropTask(task, target.column, target.index);
      else if (!moved) setOpenTaskId(task.id);
    }
    function onCancel() {
      // Gesto interrompido pelo SO/navegador antes de um `pointerup` real
      // chegar — trata como "não moveu": limpa e não escreve nada, nunca
      // um drop parcial/adivinhado a partir de coordenadas que podem não
      // refletir mais a intenção do usuário.
      cleanup();
      setDraggingTaskId(null);
      setDragOver(null);
    }
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return (
    <CardFrame
      className=""
      kind="task"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      displayName={displayName}
      onRename={onRename}
      interactionMode={interactionMode}
      selected={selected}
      accent="var(--accent-task)"
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      footerContent={
        <TaskScopeFooter
          activeBoardId={activeBoardId}
          boardNames={boardNames}
          taskCountsByBoard={taskCountsByBoard}
          focusedSprintCount={boardTasks.length}
        />
      }
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="task" size={14} />
          </span>
          <span className="card-head-actions">
            <button
              type="button"
              data-part="sprints-toggle"
              data-no-drag
              className={`${styles.chartsToggleBtn} ${sprintsOpen ? styles.chartsToggleActive : ""}`}
              aria-pressed={sprintsOpen}
              title={t("task.sprintsManage")}
              onClick={() => setSprintsOpen((v) => !v)}
            >
              <span>{activeSprintLabel ?? t("task.sprints")}</span>
            </button>
            <button
              type="button"
              data-part="charts-toggle"
              className={`${styles.chartsToggleBtn} ${chartsOpen ? styles.chartsToggleActive : ""}`}
              aria-pressed={chartsOpen}
              title={t("task.charts")}
              onClick={() => setChartsOpen((v) => !v)}
            >
              <Icon name="charts" size={12} />
              <span>{t("task.charts")}</span>
            </button>
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
    >
      {viewingFrozen && viewingSprintMeta && (
        <div className={styles.sprintFrozenBanner} data-part="sprint-frozen-banner">
          visualizando {sprintLabel(viewingSprintMeta)} (congelado)
          <button
            type="button"
            data-no-drag
            className={styles.sprintBackLive}
            onClick={() => {
              setViewingSprintId(null);
              setFrozenTasks(null);
              setViewingSprintMeta(null);
            }}
          >
            voltar ao atual
          </button>
        </div>
      )}
      <div className={styles.board} data-sprint-frozen={viewingFrozen ? "true" : "false"}>
        {COLUMN_ORDER.map((col) => (
          <div key={col} className={styles.column}>
            <div className={styles.columnHeader} data-part="column-header" style={{ color: COLUMN_COLOR[col] }}>
              <span>{t(COLUMN_HEADER_KEY[col])}</span>
              {col === "doing" ? (
                <span className={styles.wipBadge} data-part="wip-badge">
                  {t("task.wip", { current: groups.doing.length, cap })}
                </span>
              ) : (
                <span className={styles.columnCount} data-part="column-count">
                  {groups[col].length}
                </span>
              )}
            </div>
            <div
              className={styles.columnBody}
              ref={(el) => {
                columnBodyRefs.current[col] = el;
              }}
            >
              {col === "todo" && !viewingFrozen && <CreateTaskForm boardId={activeBoardId} onCreated={() => {}} />}
              {/* FASE 2, peça 3 — a task arrastada some da lista normal
                  enquanto o gesto dura (mesma lista que `locateDropTarget`
                  compara pela posição real do DOM); a "zona fantasma"
                  (`data-part="drop-ghost"`, contrato §2.3 item 7 —
                  "ausente, peça 3 adiada" — agora presente) aparece no
                  índice exato onde ela pousaria. */}
              {(() => {
                const visible = draggingTaskId ? groups[col].filter((t) => t.id !== draggingTaskId) : groups[col];
                const overHere = !viewingFrozen && dragOver && dragOver.column === col ? dragOver : null;
                return (
                  <>
                    {visible.length === 0 && !overHere && (
                      <div className={styles.empty} data-part="column-empty">
                        {t(COLUMN_EMPTY_KEY[col])}
                      </div>
                    )}
                    {visible.map((task, i) => (
                      <Fragment key={task.id}>
                        {overHere && overHere.index === i && (
                          <div className={styles.dropGhost} data-part="drop-ghost">
                            solta aqui para mover
                          </div>
                        )}
                        <TaskItem
                          task={task}
                          now={now}
                          rank={i + 1}
                          onApproveCompletion={viewingFrozen ? () => {} : onApproveCompletion}
                          onDragPointerDown={(e) => beginTaskDrag(task, e)}
                        />
                      </Fragment>
                    ))}
                    {overHere && overHere.index === visible.length && (
                      <div className={styles.dropGhost} data-part="drop-ghost">
                        solta aqui para mover
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        ))}
      </div>
      {sprintsOpen && (
        <SprintsPanel
          boardId={activeBoardId}
          reloadKey={sprintsReloadKey}
          selectedId={viewingSprintId}
          viewingFrozen={viewingFrozen}
          onSelect={onSelectSprint}
          onClosed={onSprintClosed}
          onRenamed={() => setSprintsReloadKey((k) => k + 1)}
          onDeleted={onSprintDeleted}
          closingSprint={closingSprint}
          setClosingSprint={setClosingSprint}
        />
      )}
      {chartsOpen && <ChartsPanel boardId={activeBoardId} tasks={boardTasks} liveTransitions={!viewingFrozen} />}
      {openTask && (
        <TaskDetailModal task={openTask} now={now} readOnly={viewingFrozen} onClose={() => setOpenTaskId(null)} />
      )}
    </CardFrame>
  );
}

export const TaskCard = memo(TaskCardInner);
