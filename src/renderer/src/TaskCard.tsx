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
  msToHours,
  type TaskColumn,
  type MetaPillKind,
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

/** RODADA 3-fix-textos — texto LITERAL do protótipo v5 (confirmado pelo
 * autor do protótipo, substituindo a reconstrução da rodada 3 — o
 * artefato nunca abriu nesta sessão pra conferir ao vivo). Ênfase do
 * protótipo reproduzida: "A fazer" em itálico e `retryCount` em mono, na
 * nota de "falhou". */
const COLUMN_NOTE: Partial<Record<TaskColumn, React.ReactNode>> = {
  todo: "O agente sugere a ordem pelo que desbloqueia; você arrasta pela alça e o seu palpite vence. A sugestão dele não some — fica ao lado.",
  failed: (
    <>
      Vizinha de <em>A fazer</em> de propósito: é para lá que uma task falhada volta, carregando <code>retryCount</code> e os providers já
      tentados.
    </>
  ),
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
 * `footerContent` do `CardFrame` (o mesmo slot que já dá uma linha final
 * "de graça" pra files/changes) em vez de um popover flutuante: o card
 * inteiro é clipado por `overflow: hidden` (CardFrame.tsx's `.card-clip`),
 * então um dropdown absoluto vazaria pra fora e seria cortado — texto
 * inline que cresce em altura, nunca em posição, é o que sobrevive a esse
 * clip.
 *
 * FIDELIDADE VISUAL AO PROTÓTIPO v5 (delta 11, PEDIDO EXPLÍCITO DO DONO
 * DO REPO, não estético) — a versão anterior tornava o NOME de cada board
 * um LINK clicável que trocava de board/sessão com um clique. Removido:
 * decisão 7 já dizia que tasks de outros boards são CONTADAS, nunca
 * clicáveis (`jumpToCard`/qualquer navegação só opera sobre o que está
 * carregado — um chip que às vezes navega e às vezes não é pior que
 * chip nenhum), e o dono do repo confirmou ao vivo que não quer esse
 * comportamento. O total agora é texto puro; a navegação (se alguém
 * quiser) vira um controle SEPARADO e ROTULADO ("trocar de board"), que
 * não aponta pra um board específico adivinhado — vai pra Home
 * (`onGoHome`, a mesma tela onde TODO board existente é selecionável),
 * nunca "o board X porque a contagem disse". O detalhamento por board
 * (nome + contagem) sobrevive só como `title` (tooltip nativo do
 * navegador, sem interação nenhuma) — informação sem virar afordância. */
function TaskScopeFooter({
  activeBoardId,
  boardNames,
  taskCountsByBoard,
  onGoHome,
}: {
  activeBoardId: string;
  boardNames: Record<string, string>;
  taskCountsByBoard: Record<string, number>;
  onGoHome: () => void;
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
        <span className={styles.scopeRight}>
          <span title={otherBoardsTooltip}>{scope.otherTotal} em outros boards</span>
          <button type="button" data-no-drag data-part="switch-board" className={styles.scopeSwitchButton} onClick={onGoHome}>
            trocar de board
          </button>
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
  const pills = computeMetaPills(waitingOn, task.order, task.suggestedOrder);
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
      {alive && (
        <div className={`${styles.activity} ${styles.on}`} data-part="activity-sweep">
          <div className={styles.activitySweep} />
        </div>
      )}
    </div>
  );
}

/** DESIGN-BACKLOG.md §2.3 "PARTES DOS GRÁFICOS" — gráfico 1 (reprovações
 * por provider) e gráfico 2 (rodadas até aprovar) NÃO têm fonte de dado
 * real hoje (ver o doc comment de `computeCycleTime` em
 * task-board-model.ts pro porquê) — vazio DECLARADO, nunca uma barra de
 * exemplo nem número inventado. Mesmo componente pros dois, o motivo
 * muda. */
function EmptyChart({ title, dataPart, reason }: { title: string; dataPart: string; reason: string }) {
  return (
    <div className={styles.chartBox} data-part={dataPart}>
      <div className={styles.chartTitle}>{title}</div>
      <div className={styles.chartEmpty}>sem histórico ainda — {reason}</div>
    </div>
  );
}

/** Gráfico 3 (tempo em cada estado) — o único com fonte real
 * (`task_transitions`). Uma barra empilhada por task: fila em
 * `--border`, executando em `--foam`. `viewBox` com margem nos dois lados
 * (`PAD`) pra o rótulo mais externo — o id à esquerda, o total de horas à
 * direita — nunca cortar. */
function CycleTimeChart({ data, loading }: { data: { id: string; queuedHours: number; runningHours: number }[]; loading: boolean }) {
  const W = 280;
  const ROW_H = 20;
  const PAD = 6;
  const LABEL_W = 46;
  const VALUE_W = 40;
  const barAreaW = W - LABEL_W - VALUE_W - PAD * 2;
  const maxTotal = Math.max(1e-6, ...data.map((d) => d.queuedHours + d.runningHours));
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
                  <rect x={LABEL_W} y={y + 3} width={queuedW} height={ROW_H - 8} fill="var(--border)" />
                  <rect x={LABEL_W + queuedW} y={y + 3} width={runningW} height={ROW_H - 8} fill="var(--foam)" />
                  <text x={LABEL_W + barAreaW + 4} y={y + ROW_H / 2 + 3} fontSize="9" fill="var(--text)">
                    {(d.queuedHours + d.runningHours).toFixed(1)}h
                  </text>
                </g>
              );
            })}
          </svg>
          <div className={styles.chartLegend}>
            <span>
              <span className={styles.legendSwatchQueued} /> fila
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

/** Painel de gráficos — escondido por padrão (`chartsOpen`), aberto pelo
 * toggle do header. Busca as transições SÓ quando aberto (nunca junto do
 * push normal de `tasks` — ver `preload/index.ts`'s `transitionsByBoard`
 * doc comment): o custo desta consulta só existe pra quem realmente abre
 * o painel. */
function ChartsPanel({ boardId, tasks }: { boardId: string; tasks: TaskBoardItem[] }) {
  const [transitionsByTask, setTransitionsByTask] = useState<Record<string, { toValue: string; at: number }[]> | null>(null);

  useEffect(() => {
    let cancelled = false;
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
  }, [boardId]);

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
        <EmptyChart
          title="reprovações por provider"
          dataPart="chart-verdicts"
          reason="reports guarda só o ÚLTIMO veredito por card, nunca o histórico das rodadas anteriores"
        />
        <EmptyChart
          title="rodadas até aprovar"
          dataPart="chart-rounds"
          reason="contagem de rodada não existe no modelo — mesma lacuna do gráfico anterior"
        />
        <CycleTimeChart data={cycleData} loading={transitionsByTask === null} />
      </div>
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
  onGoHome,
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
  /** DESIGN-BACKLOG.md §2.1, decisão 7 — delta 11 (RODADA de fidelidade
   * visual): substituiu `onSwitchBoard(boardId)`. O rodapé não navega
   * mais pra um board ESPECÍFICO adivinhado a partir da contagem (era
   * exatamente o comportamento indesejado que motivou este delta) — o
   * botão "trocar de board" vai pra Home (`useBoardStore.ts`'s
   * `goHome`), de onde qualquer board real é alcançável escolhendo à
   * mão. */
  onGoHome: () => void;
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
  const groups = groupTasksByColumn(tasks);
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
  // Lido uma vez por render, não num relógio próprio — a idade só precisa
  // de precisão de minuto/hora/dia (formatTaskAge), e qualquer push de
  // `task:changed` já re-renderiza isto quando algo de fato muda.
  const now = Date.now();
  // DESIGN-BACKLOG.md §2.3, peça 6 — "painel escondido por padrão":
  // `false` na montagem, `ChartsPanel` só monta (e só então busca as
  // transições, ver seu próprio `useEffect`) quando isto vira `true` —
  // enquanto ninguém nunca abriu, a consulta nunca roda. Fechar desmonta
  // `ChartsPanel`; abrir de novo remonta e busca de novo — deliberado
  // (não cacheado): dado fresco a cada abertura é mais barato de garantir
  // do que invalidar um cache certo, e a consulta é uma só (JOIN, sem
  // N+1) mesmo assim.
  const [chartsOpen, setChartsOpen] = useState(false);

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
        <TaskScopeFooter activeBoardId={activeBoardId} boardNames={boardNames} taskCountsByBoard={taskCountsByBoard} onGoHome={onGoHome} />
      }
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="task" size={14} />
          </span>
          <span className="card-head-actions">
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
      <div className={styles.board}>
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
              className={`${styles.columnBody} thin-scroll`}
              ref={(el) => {
                columnBodyRefs.current[col] = el;
              }}
            >
              {/* FASE 2, peça 3 — a task arrastada some da lista normal
                  enquanto o gesto dura (mesma lista que `locateDropTarget`
                  compara pela posição real do DOM); a "zona fantasma"
                  (`data-part="drop-ghost"`, contrato §2.3 item 7 —
                  "ausente, peça 3 adiada" — agora presente) aparece no
                  índice exato onde ela pousaria. */}
              {(() => {
                const visible = draggingTaskId ? groups[col].filter((t) => t.id !== draggingTaskId) : groups[col];
                const overHere = dragOver && dragOver.column === col ? dragOver : null;
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
                        <TaskItem task={task} now={now} rank={i + 1} onApproveCompletion={onApproveCompletion} onDragPointerDown={(e) => beginTaskDrag(task, e)} />
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
            {COLUMN_NOTE[col] && (
              <div className={styles.columnNote} data-part="column-note">
                {COLUMN_NOTE[col]}
              </div>
            )}
          </div>
        ))}
      </div>
      {chartsOpen && <ChartsPanel boardId={activeBoardId} tasks={tasks} />}
    </CardFrame>
  );
}

export const TaskCard = memo(TaskCardInner);
