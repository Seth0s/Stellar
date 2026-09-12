import { Fragment, memo, useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import { PROVIDER_GLYPH } from "./provider-glyph";
import type { Rect } from "./board-model";
import type { TaskBoardItem } from "../../preload/index";
import {
  COLUMN_ORDER,
  COLUMN_TITLE,
  COLUMN_TO_STATUS,
  groupTasksByColumn,
  originBadge,
  deriveStage,
  shouldProposeCompletion,
  shortTaskId,
  formatTaskAge,
  waitingOnDep,
  resolveConcurrencyCap,
  computeBoardScope,
  computeCycleTime,
  computeColumnDrop,
  describeHumanMove,
  isTaskCardLive,
  computeMetaPills,
  describeTransitionTrail,
  describeHumanMoveNotice,
  describeStatusDivergence,
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

/** RODADA 3 (contrato §2.3, item 8) — "o protótipo nunca mostra coluna
 * vazia"; o `—` genérico da rodada 1/2 foi substituído por um vazio
 * DECLARADO, contextual por coluna (nunca o mesmo texto reciclado nas
 * quatro). */
const COLUMN_EMPTY_TEXT: Record<TaskColumn, string> = {
  todo: "nada esperando",
  doing: "nada em andamento",
  done: "nada concluído ainda",
  failed: "nenhuma falha",
};

/** DESIGN-BACKLOG.md §2.1, decisão 7 / peça 5 — rodapé de escopo. Vive no
 * `footerContent` do `CardFrame`. Contagem "N em outros boards" é texto
 * puro (nunca link). O botão "trocar de board" da rodada anterior foi
 * REMOVIDO a pedido do dono do repo (2ª rodada de fidelidade) — a Home
 * continua alcançável pelo fluxo normal do app, não por este rodapé. */
function TaskScopeFooter({
  activeBoardId,
  boardNames,
  taskCountsByBoard,
}: {
  activeBoardId: string;
  boardNames: Record<string, string>;
  taskCountsByBoard: Record<string, number>;
}) {
  const scope = computeBoardScope(activeBoardId, taskCountsByBoard, boardNames);
  const ownName = boardNames[activeBoardId] ?? activeBoardId;
  const otherBoardsTooltip = scope.otherBoards.map((b) => `${b.name ?? `board ${b.boardId} (não existe)`} (${b.count})`).join(", ");
  return (
    <span data-part="board-scope" className={styles.scopeFooter}>
      <span className={styles.scopeOwn}>
        board {ownName} · {scope.ownCount} tasks
      </span>
      {scope.otherTotal > 0 && (
        <span className={styles.scopeRight} title={otherBoardsTooltip}>
          {scope.otherTotal} em outros boards
        </span>
      )}
    </span>
  );
}

/** Papel do vínculo task↔card (`task_cards.role`, store.ts) — só
 * "implementer" é escrito automaticamente hoje (nenhuma tool de MCP expõe
 * `linkTaskCard` ainda, ver DESIGN-BACKLOG.md §2.1), mas o campo é uma
 * string livre — qualquer outro valor cai no fallback (o próprio texto). */
const ROLE_LABEL: Record<string, string> = { implementer: "implementa", reviewer: "revisa" };

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
  const roleLabel = ROLE_LABEL[role] ?? role;
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
  const stage = deriveStage(task.status, task.report !== null);
  const propose = shouldProposeCompletion(task.status, task.report?.verdict);
  const waitingOn = waitingOnDep(task.deps, task.depStatuses);
  const pills = computeMetaPills(waitingOn, task.order, task.suggestedOrder, task.verdicts);
  // RODADA 2 — "Mais uma rodada" (segundo botão da barra de proposta): a
  // semântica não estava definida em lugar nenhum do briefing. Implementado
  // como o caso mais simples e mais seguro descrito por ele mesmo —
  // dispensa a proposta ATÉ chegar um relatório novo, sem NENHUMA escrita
  // no banco. `dismissedAtReportUpdatedAt` guarda o `updatedAt` do
  // relatório que estava presente quando o humano dispensou; comparar com
  // o `updatedAt` do relatório ATUAL é o que invalida a dispensa sozinho
  // assim que um relatório novo substituir o antigo (`upsertReport`
  // sobrescreve a mesma linha, então `updatedAt` sempre muda) — sem
  // precisar de um `useEffect` limpando nada. Estado só de UI, local a
  // este item: se o card fechar e reabrir, ou a task sair e voltar da
  // lista, a proposta reaparece — aceitável pro que isto é (um "não agora"
  // efêmero, não uma decisão que precisa sobreviver a um reload).
  const [dismissedAtReportUpdatedAt, setDismissedAtReportUpdatedAt] = useState<number | null>(null);
  const proposeVisible = propose && task.report?.updatedAt !== dismissedAtReportUpdatedAt;
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
  const interruptNotice = task.interruptionReason;
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
      <div className={styles.prompt}>{task.prompt || "(sem prompt)"}</div>
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
      {stage && !proposeVisible && (
        <div className={styles.stageTrail} data-part="stage-trail">
          <span className={`${styles.stageSeg} ${stage === "implementar" ? styles.stageSegActive : ""}`}>implementar</span>
          <span className={`${styles.stageSeg} ${stage === "review" ? styles.stageSegActive : ""}`}>review</span>
        </div>
      )}
      {trail && (
        <div className={styles.transitionTrail} data-part="transition-trail">
          {trail}
        </div>
      )}
      {proposeVisible && (
        <div className={styles.proposeBar} data-part="propose-bar">
          <span className={styles.proposeText}>
            <span className={styles.verdictChip} data-part="verdict-chip">
              {task.report?.verdict}
            </span>
            propor conclusão
          </span>
          <span className={styles.proposeActions}>
            <button type="button" data-no-drag className={styles.proposeSecondary} onClick={() => setDismissedAtReportUpdatedAt(task.report?.updatedAt ?? null)}>
              Mais uma rodada
            </button>
            <button type="button" data-no-drag onClick={() => onApproveCompletion(task.id)}>
              Concluir
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
      {interruptNotice && (
        <div className={styles.interruptNotice} data-part="interruption-reason">
          interrompida: {interruptNotice}
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
        placeholder="nova task…"
        disabled={busy}
        aria-label="Criar task"
      />
      <button type="submit" data-no-drag data-part="create-task-submit" className={styles.createTaskSubmit} disabled={busy || !prompt.trim()}>
        criar
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
      <div className={styles.chartTitle}>reprovações por provider</div>
      {data.length === 0 ? (
        <div className={styles.chartEmpty}>sem histórico ainda — nenhuma participação com veredito neste board</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Reprovações por provider">
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
      <div className={styles.chartTitle}>rodadas até aprovar</div>
      {data.length === 0 ? (
        <div className={styles.chartEmpty}>sem histórico ainda — nenhuma task aprovada com rodadas neste board</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Rodadas até aprovar">
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
      <div className={styles.chartTitle}>tempo em cada estado (horas)</div>
      {loading ? (
        <div className={styles.chartEmpty}>carregando…</div>
      ) : data.length === 0 ? (
        <div className={styles.chartEmpty}>sem histórico ainda — nenhuma task com transição gravada neste board</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Tempo em fila e em execução por task">
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
      <div className={styles.sprintsTitle}>sprints — ver, renomear, fechar ou excluir</div>
      {sprints === null ? (
        <div className={styles.chartEmpty}>carregando…</div>
      ) : sprints.length === 0 ? (
        <div className={styles.chartEmpty}>nenhum sprint ainda — feche o atual pra abrir o histórico</div>
      ) : (
        <ul className={styles.sprintsList} role="listbox" aria-label="Sprints">
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
                        aria-label="Nome do sprint"
                        placeholder={`Sprint ${s.number}`}
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
                    title="Renomear"
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
                        title="Fechar sprint e abrir o próximo"
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
                        title="Excluir sprint ativo — tasks voltam ao anterior"
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
              ? `Fechar ${active ? sprintLabel(active) : "o sprint atual"}? Congela o histórico e abre o próximo.`
              : `Excluir ${active ? sprintLabel(active) : "o sprint atual"}? As tasks voltam ao sprint anterior (que reabre).`}
          </p>
          <div className={styles.sprintConfirmActions}>
            <button
              type="button"
              data-no-drag
              className={styles.sprintActionBtn}
              disabled={busy}
              onClick={() => setPendingAction(null)}
            >
              cancelar
            </button>
            <button
              type="button"
              data-no-drag
              data-part="sprint-confirm-go"
              className={`${styles.sprintActionBtn} ${styles.sprintActionDanger}`}
              disabled={busy || closingSprint}
              onClick={() => void confirmPending()}
            >
              {pendingAction.kind === "close" ? "fechar agora" : "excluir agora"}
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
    for (const t of tasks) {
      const snap = { cardId: t.cardId, status: t.status };
      next.set(t.id, snap);
      if (!isHumanCreatedTask(t.firstActor)) continue;
      if (didHumanTaskGetClaimed(prev.get(t.id), snap)) {
        try {
          new Notification("Task pega", { body: t.prompt?.slice(0, 120) || shortTaskId(t.id), silent: false });
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
   * só chama isto com um `target` não-nulo): decisão 5 é "SEMPRE vale, e
   * AVISA o agente", não uma otimização de "só grava se mudou de
   * verdade". */
  function onDropTask(task: TaskBoardItem, column: TaskColumn, index: number) {
    const destination = groupsRef.current[column].filter((t) => t.id !== task.id);
    const result = computeColumnDrop(destination, index);
    const status = COLUMN_TO_STATUS[column];
    window.tasks.moveTask(task.id, status, result.order, result.siblingImplicitOrders, describeHumanMove(column));
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
    if (viewingFrozen) return;
    if ((e.target as HTMLElement).closest("button, select, input, [data-no-drag]")) return;
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
        setDraggingTaskId(task.id);
      }
      if (!moved) return;
      setDragOver(locateDropTarget(task.id, ev.clientX, ev.clientY));
    }
    function onUp(ev: PointerEvent) {
      const target = moved ? locateDropTarget(task.id, ev.clientX, ev.clientY) : null;
      cleanup();
      setDraggingTaskId(null);
      setDragOver(null);
      if (target) onDropTask(task, target.column, target.index);
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
        <TaskScopeFooter activeBoardId={activeBoardId} boardNames={boardNames} taskCountsByBoard={taskCountsByBoard} />
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
              title="Gerenciar sprints — ver histórico, renomear, fechar ou excluir"
              onClick={() => setSprintsOpen((v) => !v)}
            >
              <span>{activeSprintLabel ?? "Sprints"}</span>
            </button>
            <button
              type="button"
              data-part="charts-toggle"
              className={`${styles.chartsToggleBtn} ${chartsOpen ? styles.chartsToggleActive : ""}`}
              aria-pressed={chartsOpen}
              title="Gráficos"
              onClick={() => setChartsOpen((v) => !v)}
            >
              <Icon name="charts" size={12} />
              {/* FIDELIDADE VISUAL AO PROTÓTIPO v5 (delta 9) — o protótipo
                  rotula este botão ("Gráficos"), a versão anterior só
                  tinha o ícone. */}
              <span>Gráficos</span>
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
              <span>{COLUMN_TITLE[col]}</span>
              {col === "doing" ? (
                <span className={styles.wipBadge} data-part="wip-badge">
                  WIP {groups.doing.length}/{cap}
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
                        {COLUMN_EMPTY_TEXT[col]}
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
    </CardFrame>
  );
}

export const TaskCard = memo(TaskCardInner);
