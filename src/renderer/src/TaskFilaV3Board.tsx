import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { TaskBoardItem } from "../../preload/index";
import { compareTasks, shortTaskId } from "./task-board-model";
import {
  QUEUE_COLUMN_ORDER,
  columnForQueueTask,
  countQueueFilter,
  decideColumnRails,
  deriveTileGateChips,
  deriveTileStatusPhrase,
  deriveTileTypeLabel,
  isDoneToday,
  loadCollapsedColumns,
  saveCollapsedColumns,
  taskNeedsYou,
  tileShowsLiveActivity,
  type QueueColumn,
  type QueueFilter,
} from "./task-fila-v3-decision";
import { boardItemTitle, queueFactsFromBoardItem } from "./task-fila-v3-facts";
import { blockedQuestionOf } from "./task-board-model";
import { describeGateChip, type GateChipTone } from "./task-gate-view";
import { t } from "../../shared/i18n";
import styles from "./TaskFilaV3.module.css";

const GATE_TONE_CLASS: Record<GateChipTone, string> = {
  running: styles.gateRunning,
  good: styles.gateOk,
  danger: styles.gateFail,
};

const COLUMN_DOT: Record<QueueColumn, string> = {
  waiting: "var(--fila-dot-waiting)",
  ready: "var(--fila-dot-ready)",
  running: "var(--fila-dot-running)",
  review: "var(--fila-dot-review)",
  done: "var(--fila-dot-done)",
  failed: "var(--fila-dot-fail)",
  superseded: "var(--fila-dot-waiting)",
};

const COLUMN_TITLE_KEY = {
  waiting: "task.queue.column.waiting",
  ready: "task.queue.column.ready",
  running: "task.queue.column.running",
  review: "task.queue.column.review",
  done: "task.queue.column.done",
  failed: "task.queue.column.failed",
  superseded: "task.queue.column.superseded",
} as const;

function typeClass(label: string | null): string {
  if (label === "pergunta") return styles.typeAsk;
  if (label === "implementar") return styles.typeImpl;
  if (label === "corrigir") return styles.typeFix;
  if (label === "investigar") return styles.typeInvest;
  return styles.typeImpl;
}

function formatElapsed(ms: number | null | undefined): string | null {
  if (ms == null || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return null;
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h`;
}

function NeedsYouStrip({
  tasks,
  now,
  onOpen,
}: {
  tasks: TaskBoardItem[];
  now: number;
  onOpen: (id: string) => void;
}) {
  const items = tasks.filter((task) => taskNeedsYou(queueFactsFromBoardItem(task))).slice(0, 3);
  if (items.length === 0) return null;
  return (
    <section className={styles.needsStrip} aria-label={t("task.queue.filter.needsYou")} data-part="needs-you-strip">
      {items.map((task) => {
        const facts = queueFactsFromBoardItem(task);
        const blocked = blockedQuestionOf(task);
        const isReview =
          facts.review === "wanted" &&
          !facts.cards.some((c) => c.role === "reviewer") &&
          !blocked &&
          !facts.requestedStatus &&
          (facts.phase === "awaiting_review" ||
            facts.phase === "ready" ||
            facts.phase === "reserved" ||
            facts.phase === "changes_requested");
        const ageMs = blocked?.askedAt ? now - blocked.askedAt : task.requestedAt ? now - task.requestedAt : null;
        const ageH = ageMs != null && ageMs > 0 ? Math.max(1, Math.floor(ageMs / 3_600_000)) : null;
        const bodyRaw = blocked?.text ?? task.requestedReason ?? boardItemTitle(task);
        // Owner: do not repeat the id when the body already starts with #…
        const body = /^#\w/.test(bodyRaw.trim()) ? bodyRaw.trim() : `#${shortTaskId(task.id)} ${bodyRaw}`;
        const groupMatch = !blocked && facts.requestedStatus
          ? task.requestedReason?.match(/e mais\s+(\d+)/i)
          : null;
        const groupTotal = groupMatch ? Number(groupMatch[1]) + 1 : null;
        return (
          <div
            key={task.id}
            className={`${styles.needsCard}${isReview ? ` ${styles.needsCardReview}` : ""}`}
            data-part="needs-you-card"
          >
            <div
              className={`${styles.needsHead}${isReview ? ` ${styles.needsHeadReview}` : ""}`}
              data-part="needs-you-head"
            >
              <span className={`${styles.needsDot}${isReview ? ` ${styles.needsDotReview}` : ""}`} />
              {isReview
                ? t("task.queue.needs.reviewTitle")
                : ageH
                  ? t("task.queue.needs.questionAge", { h: ageH })
                  : t("task.queue.needs.question")}
            </div>
            <span className={styles.needsBody} data-part="needs-you-body">
              {body}
            </span>
            <div className={styles.needsActions}>
              {blocked
                ? blocked.options.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={styles.btn}
                      data-no-drag
                      onClick={() => void window.tasks.answerBlocked(task.id, opt.id, null)}
                    >
                      {opt.label}
                    </button>
                  ))
                : groupTotal != null
                  ? (
                      <button type="button" className={styles.btn} data-no-drag onClick={() => onOpen(task.id)}>
                        {t("task.queue.needs.seeGroup", { n: groupTotal })}
                      </button>
                    )
                : facts.requestedStatus
                  ? [
                      <button
                        key="ok"
                        type="button"
                        className={styles.btn}
                        data-no-drag
                        onClick={() => void window.tasks.respondStatusAsk(task.id, true)}
                      >
                        {t("task.queue.needs.approve")}
                      </button>,
                      <button
                        key="no"
                        type="button"
                        className={styles.btn}
                        data-no-drag
                        onClick={() => void window.tasks.respondStatusAsk(task.id, false)}
                      >
                        {t("task.queue.needs.deny")}
                      </button>,
                    ]
                  : (
                      <button type="button" className={styles.btn} data-no-drag onClick={() => onOpen(task.id)}>
                        {t("task.queue.needs.open")}
                      </button>
                    )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function QueueTile({
  task,
  now,
  column,
  onOpen,
  onDragPointerDown,
  depTitles,
}: {
  task: TaskBoardItem;
  now: number;
  column: QueueColumn;
  onOpen: (id: string) => void;
  onDragPointerDown: (e: React.PointerEvent) => void;
  depTitles: Record<string, string | undefined>;
}) {
  const facts = queueFactsFromBoardItem(task, { depTitles });
  const phrase = deriveTileStatusPhrase(facts);
  const typeLabel = deriveTileTypeLabel(facts);
  const describedGate = describeGateChip(task.gateRun, task.gateProgress);
  const verdictChips = deriveTileGateChips(facts);
  // Compact labels from deriveTileGateChips; tooltip stays describeGateChip
  // (command + isolation mode + failed output).
  const gateChips: { tone: GateChipTone; title: string; label: string }[] =
    describedGate?.tone === "running"
      ? [{ tone: describedGate.tone, title: describedGate.title, label: describedGate.label }]
      : verdictChips.length > 0
        ? verdictChips.map((c) => ({
            tone: c.tone,
            label: c.label,
            title: describedGate?.title ?? c.label,
          }))
        : describedGate
          ? [{ tone: describedGate.tone, title: describedGate.title, label: describedGate.label }]
          : [];
  const live = tileShowsLiveActivity(facts);
  const title = boardItemTitle(task);
  const startedAt =
    [...task.statusTransitions].reverse().find((tr) => tr.toValue === "running")?.at ?? task.createdAt;
  const elapsed = column === "running" ? formatElapsed(now - startedAt) : null;
  const rounds = task.verdicts.length;
  const meta =
    column === "review" && rounds > 0
      ? t("task.queue.tile.round", { n: rounds })
      : elapsed;
  const phraseAmber = facts.blockedQuestion != null || facts.requestedStatus != null;

  if (column === "done") {
    return (
      <button
        type="button"
        className={`${styles.tile} ${styles.tileDone}`}
        data-task-item-id={task.id}
        data-part="queue-tile"
        data-column={column}
        onPointerDown={onDragPointerDown}
        onClick={() => onOpen(task.id)}
      >
        <div className={styles.tileDoneRow}>
          <span className={styles.tileId}>#{shortTaskId(task.id)}</span>
          <span className={styles.tileDoneTitle}>{title}</span>
        </div>
        <span className={styles.tilePhraseDone}>{phrase}</span>
      </button>
    );
  }

  if (column === "superseded") {
    return (
      <button
        type="button"
        className={`${styles.tile} ${styles.tileDone}`}
        data-task-item-id={task.id}
        data-part="queue-tile"
        data-column={column}
        onPointerDown={onDragPointerDown}
        onClick={() => onOpen(task.id)}
      >
        <span className={styles.tileDoneTitle}>{title}</span>
        <span className={styles.tilePhrase}>{phrase}</span>
      </button>
    );
  }

  if (column === "failed") {
    return (
      <button
        type="button"
        className={styles.tile}
        data-task-item-id={task.id}
        data-part="queue-tile"
        data-column={column}
        onPointerDown={onDragPointerDown}
        onClick={() => onOpen(task.id)}
      >
        <div className={styles.tileTop}>
          <span className={styles.tileId}>#{shortTaskId(task.id)}</span>
        </div>
        <span className={styles.tileTitle}>{title}</span>
        <span className={`${styles.tilePhrase} ${styles.tilePhraseAmber}`}>{phrase}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.tile}${column === "running" ? ` ${styles.tileRunning}` : ""}${column === "review" ? ` ${styles.tileReview}` : ""}`}
      data-task-item-id={task.id}
      data-part="queue-tile"
      data-column={column}
      onPointerDown={onDragPointerDown}
      onClick={() => onOpen(task.id)}
    >
      <div className={styles.tileTop}>
        <span className={styles.tileId}>#{shortTaskId(task.id)}</span>
        {typeLabel && <span className={`${styles.typeChip} ${typeClass(typeLabel)}`}>{typeLabel}</span>}
        {meta && (
          <span className={styles.tileMeta} data-part="queue-tile-meta">
            {meta}
          </span>
        )}
      </div>
      <span className={styles.tileTitle} data-part="queue-tile-title">
        {title}
      </span>
      {gateChips.length > 0 && (
        <div className={styles.gates} data-part="gate-chips">
          {gateChips.map((chip) => (
            <span
              key={`${chip.tone}-${chip.label}`}
              className={`${styles.gateChip} ${GATE_TONE_CLASS[chip.tone]}`}
              data-part="gate-chip"
              data-tone={chip.tone}
              title={chip.title}
            >
              {chip.label}
            </span>
          ))}
        </div>
      )}
      <div className={`${styles.tilePhrase}${phraseAmber ? ` ${styles.tilePhraseAmber}` : ""}`}>
        {live && <span className={styles.live} aria-hidden="true" />}
        {!live && phraseAmber && <span className={styles.phraseDot} aria-hidden="true" />}
        {facts.phase === "reserved" && <span className={`${styles.avatar} ${styles.avatarCl}`}>CL</span>}
        {(facts.phase === "awaiting_review" || facts.phase === "changes_requested") && (
          <span className={`${styles.avatar} ${styles.avatarRv}`}>RV</span>
        )}
        <span className={live ? styles.tilePhraseLive : undefined}>{phrase}</span>
      </div>
      {live && (
        <div className={styles.bar} aria-hidden="true">
          <div className={styles.barFill} />
        </div>
      )}
    </button>
  );
}

export function TaskFilaV3Board({
  tasks,
  now,
  query,
  onQueryChange,
  onOpenTask,
  onBeginDrag,
  draggingTaskId,
  dragOver,
  columnBodyRefs,
  viewingFrozen,
  onOpenCharts,
  onOpenSprints,
  onCreateTask,
  totalDoneCount,
  boardId,
  boardLabel,
  sprintLabel,
}: {
  tasks: TaskBoardItem[];
  now: number;
  query: string;
  onQueryChange: (q: string) => void;
  onOpenTask: (id: string) => void;
  onBeginDrag: (task: TaskBoardItem, e: React.PointerEvent) => void;
  draggingTaskId: string | null;
  dragOver: { column: QueueColumn; index: number } | null;
  columnBodyRefs: React.MutableRefObject<Partial<Record<QueueColumn, HTMLDivElement | null>>>;
  viewingFrozen: boolean;
  onOpenCharts: () => void;
  onOpenSprints: () => void;
  onCreateTask: () => void;
  totalDoneCount: number;
  boardId: string;
  boardLabel: string;
  sprintLabel: string | null;
}) {
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [userCollapsed, setUserCollapsed] = useState<Set<QueueColumn>>(() => loadCollapsedColumns(boardId));
  const [userExpanded, setUserExpanded] = useState<Set<QueueColumn>>(() => new Set());
  const [boardWidth, setBoardWidth] = useState(0);
  const boardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setUserCollapsed(loadCollapsedColumns(boardId));
    setUserExpanded(new Set());
  }, [boardId]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setBoardWidth(w);
    });
    ro.observe(el);
    setBoardWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const depTitles = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const task of tasks) map[task.id] = boardItemTitle(task);
    return map;
  }, [tasks]);

  const filtered = useMemo(() => {
    const base = tasks.filter((task) => {
      const facts = queueFactsFromBoardItem(task, { depTitles });
      if (filter === "all") return true;
      if (filter === "needsYou") return taskNeedsYou(facts);
      return facts.cardAlive && facts.phase === "running" && facts.blockedQuestion == null;
    });
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (task) =>
        task.id.toLowerCase().includes(q) ||
        boardItemTitle(task).toLowerCase().includes(q) ||
        (task.promptPreview ?? "").toLowerCase().includes(q),
    );
  }, [tasks, filter, query, depTitles]);

  const groups = useMemo(() => {
    const next: Record<QueueColumn, TaskBoardItem[]> = {
      waiting: [],
      ready: [],
      running: [],
      review: [],
      done: [],
      failed: [],
      superseded: [],
    };
    for (const task of filtered) {
      next[columnForQueueTask(queueFactsFromBoardItem(task, { depTitles }))].push(task);
    }
    for (const col of Object.keys(next) as QueueColumn[]) next[col].sort(compareTasks);
    return next;
  }, [filtered, depTitles]);

  const doneToday = groups.done.filter((task) => isDoneToday(task.updatedAt, now));
  const factList = tasks.map((task) => queueFactsFromBoardItem(task, { depTitles }));
  const counts = {
    all: countQueueFilter(factList, "all", now),
    needsYou: countQueueFilter(factList, "needsYou", now),
    liveAgent: countQueueFilter(factList, "liveAgent", now),
  };

  const columnCounts = useMemo(() => {
    const c: Record<QueueColumn, number> = {
      waiting: groups.waiting.length,
      ready: groups.ready.length,
      running: groups.running.length,
      review: groups.review.length,
      done: doneToday.length,
      failed: groups.failed.length,
      superseded: groups.superseded.length,
    };
    return c;
  }, [groups, doneToday.length]);

  const rails = useMemo(
    () =>
      decideColumnRails({
        availableWidth: boardWidth,
        counts: columnCounts,
        userCollapsed,
        userExpanded,
      }),
    [boardWidth, columnCounts, userCollapsed, userExpanded],
  );

  function collapseColumn(col: QueueColumn) {
    setUserExpanded((prev) => {
      if (!prev.has(col)) return prev;
      const next = new Set(prev);
      next.delete(col);
      return next;
    });
    setUserCollapsed((prev) => {
      const next = new Set(prev);
      next.add(col);
      saveCollapsedColumns(boardId, next);
      return next;
    });
  }

  function expandColumn(col: QueueColumn) {
    setUserCollapsed((prev) => {
      if (!prev.has(col)) return prev;
      const next = new Set(prev);
      next.delete(col);
      saveCollapsedColumns(boardId, next);
      return next;
    });
    if (columnCounts[col] === 0) {
      setUserExpanded((prev) => {
        const next = new Set(prev);
        next.add(col);
        return next;
      });
    }
  }

  function renderColumn(col: QueueColumn, list: TaskBoardItem[]) {
    const visible = draggingTaskId ? list.filter((task) => task.id !== draggingTaskId) : list;
    const overHere = !viewingFrozen && dragOver && dragOver.column === col ? dragOver : null;
    const wide = col === "running" || col === "review";
    return (
      <section
        key={col}
        className={`${styles.column}${wide ? ` ${styles.columnWide}` : ""}`}
        aria-label={t(COLUMN_TITLE_KEY[col])}
        data-part="queue-column"
        data-column={col}
        data-collapsed="false"
      >
        <div className={styles.columnHead} data-part="queue-column-head">
          {col === "superseded" ? (
            <span className={styles.markerHollow} />
          ) : (
            <span className={styles.columnMarker} style={{ background: COLUMN_DOT[col] }} />
          )}
          <h2 className={styles.columnTitle}>{t(COLUMN_TITLE_KEY[col])}</h2>
          <span className={styles.columnCount} data-part="queue-column-count">
            {col === "done" ? t("task.queue.doneToday", { n: list.length }) : list.length}
          </span>
          {col === "waiting" && <span className={styles.columnHint}>{t("task.queue.waitingHint")}</span>}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className={`${styles.btn} ${styles.collapseBtn}`}
            data-no-drag
            data-part="queue-collapse"
            data-column={col}
            aria-label={`Recolher ${t(COLUMN_TITLE_KEY[col])}`}
            onClick={() => collapseColumn(col)}
          >
            ‹
          </button>
        </div>
        <div
          className={styles.columnBody}
          ref={(el) => {
            columnBodyRefs.current[col] = el;
          }}
        >
          {visible.length === 0 && !overHere && (
            <div className={styles.empty} data-part="column-empty">
              {t("task.queue.empty")}
            </div>
          )}
          {visible.map((task, i) => (
            <Fragment key={task.id}>
              {overHere && overHere.index === i && (
                <div className={styles.dropGhost} data-part="drop-ghost">
                  {t("task.queue.dropHere")}
                </div>
              )}
              <QueueTile
                task={task}
                now={now}
                column={col}
                onOpen={onOpenTask}
                onDragPointerDown={(e) => onBeginDrag(task, e)}
                depTitles={depTitles}
              />
            </Fragment>
          ))}
          {overHere && overHere.index === visible.length && (
            <div className={styles.dropGhost} data-part="drop-ghost">
              {t("task.queue.dropHere")}
            </div>
          )}
          {col === "done" && totalDoneCount > 0 && (
            <button type="button" className={styles.seeAll} data-no-drag data-part="queue-see-all-done">
              {t("task.queue.seeAllDone", { n: totalDoneCount })}
            </button>
          )}
        </div>
      </section>
    );
  }

  function renderRail(col: QueueColumn, count: number) {
    return (
      <button
        key={`rail-${col}`}
        type="button"
        className={styles.rail}
        data-no-drag
        data-part={`queue-rail-${col}`}
        data-column={col}
        data-collapsed="true"
        aria-label={`Mostrar ${t(COLUMN_TITLE_KEY[col])}`}
        onClick={() => expandColumn(col)}
      >
        {col === "superseded" ? (
          <span className={styles.markerHollow} />
        ) : (
          <span className={styles.columnMarker} style={{ background: COLUMN_DOT[col] }} />
        )}
        <span className={styles.railCount}>{count}</span>
        <span className={styles.vert}>{t(COLUMN_TITLE_KEY[col])}</span>
      </button>
    );
  }

  const sprintLink = sprintLabel
    ? `${boardLabel} · ${sprintLabel} ▾`
    : `${boardLabel} ▾`;

  return (
    <>
      <header className={styles.toolbar} data-part="queue-toolbar">
        <h1 className={styles.filaTitle} data-part="queue-title">
          Fila
        </h1>
        <button
          type="button"
          className={styles.sprintLink}
          data-no-drag
          data-part="sprints-toggle"
          aria-label={t("task.sprintsManage")}
          onClick={onOpenSprints}
        >
          {sprintLink}
        </button>
        <div className={styles.filters} role="group" aria-label={t("task.queue.filter.aria")}>
          {(
            [
              ["all", "task.queue.filter.all", counts.all, false],
              ["needsYou", "task.queue.filter.needsYou", counts.needsYou, true],
              ["liveAgent", "task.queue.filter.liveAgent", counts.liveAgent, false],
            ] as const
          ).map(([id, key, count, needs]) => (
            <button
              key={id}
              type="button"
              className={`${styles.chip}${filter === id ? ` ${styles.chipOn}` : ""}`}
              data-no-drag
              data-part={`queue-filter-${id}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {t(key)}{" "}
              <span className={needs ? styles.chipCountNeeds : styles.chipCount} data-part={`queue-filter-${id}-count`}>
                {count}
              </span>
            </button>
          ))}
        </div>
        <span className={styles.toolbarGrow} aria-hidden="true" />
        <label className={styles.search}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--card-context)" strokeWidth="1.5" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M9.5 9.5L13 13" />
          </svg>
          <input
            aria-label={t("task.queue.search")}
            placeholder={t("task.queue.searchPlaceholder")}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            data-no-drag
          />
        </label>
        <button type="button" className={styles.btn} data-no-drag data-part="charts-toggle" onClick={onOpenCharts}>
          {t("task.charts")}
        </button>
        {!viewingFrozen && (
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-no-drag onClick={onCreateTask}>
            {t("task.queue.newTask")}
          </button>
        )}
      </header>

      {filter !== "liveAgent" && <NeedsYouStrip tasks={tasks} now={now} onOpen={onOpenTask} />}

      <div
        ref={boardRef}
        className={styles.board}
        data-part="queue-board"
        data-sprint-frozen={viewingFrozen ? "true" : "false"}
        data-board-width={boardWidth > 0 ? Math.round(boardWidth) : undefined}
      >
        {QUEUE_COLUMN_ORDER.map((col) => {
          const list = col === "done" ? doneToday : groups[col];
          if (rails.has(col)) return renderRail(col, columnCounts[col]);
          return renderColumn(col, list);
        })}
      </div>
    </>
  );
}

export { columnForQueueTask, type QueueColumn };
export { QUEUE_PRIMARY_COLUMNS } from "./task-fila-v3-decision";
