import { Fragment, useMemo, useState } from "react";
import type { TaskBoardItem } from "../../preload/index";
import { compareTasks, shortTaskId } from "./task-board-model";
import {
  QUEUE_PRIMARY_COLUMNS,
  columnForQueueTask,
  countQueueFilter,
  deriveTileGateChips,
  deriveTileStatusPhrase,
  deriveTileTypeLabel,
  isDoneToday,
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
    <section className={styles.needsStrip} aria-label={t("task.queue.filter.needsYou")}>
      {items.map((task) => {
        const facts = queueFactsFromBoardItem(task);
        const blocked = blockedQuestionOf(task);
        const isReview =
          facts.phase === "awaiting_review" &&
          facts.review === "wanted" &&
          !facts.cards.some((c) => c.role === "reviewer") &&
          !blocked &&
          !facts.requestedStatus;
        const ageMs = blocked?.askedAt ? now - blocked.askedAt : task.requestedAt ? now - task.requestedAt : null;
        const ageH = ageMs != null && ageMs > 0 ? Math.max(1, Math.floor(ageMs / 3_600_000)) : null;
        return (
          <div
            key={task.id}
            className={`${styles.needsCard}${isReview ? ` ${styles.needsCardReview}` : ""}`}
            data-part="needs-you-card"
          >
            <div className={`${styles.needsHead}${isReview ? ` ${styles.needsHeadReview}` : ""}`}>
              <span className={`${styles.needsDot}${isReview ? ` ${styles.needsDotReview}` : ""}`} />
              {isReview
                ? t("task.queue.needs.reviewTitle")
                : ageH
                  ? t("task.queue.needs.questionAge", { h: ageH })
                  : t("task.queue.needs.question")}
            </div>
            <span className={styles.needsBody}>
              #{shortTaskId(task.id)}{" "}
              {blocked?.text ?? task.requestedReason ?? boardItemTitle(task)}
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
  // Live progress + title come from describeGateChip (HEAD behavior the
  // prototype omits). Verdict labels stay the V3 compact form (✓ / ✕).
  const describedGate = describeGateChip(task.gateRun, task.gateProgress);
  const verdictChips = deriveTileGateChips(facts);
  const gateChip =
    describedGate == null
      ? null
      : {
          tone: describedGate.tone,
          title: describedGate.title,
          label:
            describedGate.tone === "running"
              ? describedGate.label
              : (verdictChips[0]?.label ?? describedGate.label),
        };
  const live = tileShowsLiveActivity(facts);
  const title = boardItemTitle(task);
  const startedAt = task.statusTransitions.find((tr) => tr.toValue === "running")?.at ?? task.createdAt;
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
        {meta && <span className={styles.tileMeta}>{meta}</span>}
      </div>
      <span className={styles.tileTitle}>{title}</span>
      {gateChip && (
        <div className={styles.gates} data-part="gate-chips">
          <span
            className={`${styles.gateChip} ${GATE_TONE_CLASS[gateChip.tone]}`}
            data-part="gate-chip"
            data-tone={gateChip.tone}
            title={gateChip.title}
          >
            {gateChip.label}
          </span>
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
  onCreateTask,
  totalDoneCount,
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
  onCreateTask: () => void;
  totalDoneCount: number;
}) {
  const [filter, setFilter] = useState<QueueFilter>("all");
  // Shown state of the approved Fila prototype: both rails open (still collapsible).
  const [openFail, setOpenFail] = useState(true);
  const [openSup, setOpenSup] = useState(true);

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
  const factList = tasks.map((t) => queueFactsFromBoardItem(t, { depTitles }));
  const counts = {
    all: countQueueFilter(factList, "all"),
    needsYou: countQueueFilter(factList, "needsYou"),
    liveAgent: countQueueFilter(factList, "liveAgent"),
  };

  function renderColumn(col: QueueColumn, list: TaskBoardItem[]) {
    const visible = draggingTaskId ? list.filter((t) => t.id !== draggingTaskId) : list;
    const overHere = !viewingFrozen && dragOver && dragOver.column === col ? dragOver : null;
    const wide = col === "running" || col === "review";
    return (
      <section
        key={col}
        className={`${styles.column}${wide ? ` ${styles.columnWide}` : ""}`}
        aria-label={t(COLUMN_TITLE_KEY[col])}
        data-part="queue-column"
        data-column={col}
      >
        <div className={styles.columnHead}>
          {col === "superseded" ? (
            <span className={styles.markerHollow} />
          ) : (
            <span className={styles.columnMarker} style={{ background: COLUMN_DOT[col] }} />
          )}
          <h2 className={styles.columnTitle}>{t(COLUMN_TITLE_KEY[col])}</h2>
          <span className={styles.columnCount}>
            {col === "done" ? t("task.queue.doneToday", { n: list.length }) : list.length}
          </span>
          {col === "waiting" && <span className={styles.columnHint}>{t("task.queue.waitingHint")}</span>}
          {(col === "failed" || col === "superseded") && (
            <button
              type="button"
              className={`${styles.btn} ${styles.collapseBtn}`}
              data-no-drag
              aria-label={t(col === "failed" ? "task.queue.collapseFailed" : "task.queue.collapseSuperseded")}
              onClick={() => (col === "failed" ? setOpenFail(false) : setOpenSup(false))}
            >
              ‹
            </button>
          )}
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

  return (
    <>
      <div className={styles.toolbar} data-part="queue-toolbar">
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
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {t(key)}{" "}
              <span className={needs ? styles.chipCountNeeds : styles.chipCount}>{count}</span>
            </button>
          ))}
        </div>
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
        <button type="button" className={styles.btn} data-no-drag onClick={onOpenCharts}>
          {t("task.charts")}
        </button>
        {!viewingFrozen && (
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-no-drag onClick={onCreateTask}>
            {t("task.queue.newTask")}
          </button>
        )}
      </div>

      {filter !== "liveAgent" && <NeedsYouStrip tasks={tasks} now={now} onOpen={onOpenTask} />}

      <div className={styles.board} data-part="queue-board" data-sprint-frozen={viewingFrozen ? "true" : "false"}>
        {QUEUE_PRIMARY_COLUMNS.map((col) =>
          renderColumn(col, col === "done" ? doneToday : groups[col]),
        )}

        {openFail
          ? renderColumn("failed", groups.failed)
          : (
              <button
                type="button"
                className={styles.rail}
                data-no-drag
                data-part="queue-rail-failed"
                aria-label={t("task.queue.showFailed")}
                onClick={() => setOpenFail(true)}
              >
                <span className={styles.columnMarker} style={{ background: COLUMN_DOT.failed }} />
                <span className={styles.railCount}>{groups.failed.length}</span>
                <span className={styles.vert}>{t(COLUMN_TITLE_KEY.failed)}</span>
              </button>
            )}

        {openSup
          ? renderColumn("superseded", groups.superseded)
          : (
              <button
                type="button"
                className={styles.rail}
                data-no-drag
                data-part="queue-rail-superseded"
                aria-label={t("task.queue.showSuperseded")}
                onClick={() => setOpenSup(true)}
              >
                <span className={styles.markerHollow} />
                <span className={styles.railCount}>{groups.superseded.length}</span>
                <span className={styles.vert}>{t(COLUMN_TITLE_KEY.superseded)}</span>
              </button>
            )}
      </div>
    </>
  );
}

export { columnForQueueTask, type QueueColumn };
