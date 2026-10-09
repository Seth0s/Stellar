/**
 * Fila sprints (Sprints.dc.html).
 * Closing always moves open tasks onto the next sprint.
 * A closed sprint's menu only renames; delete stays refused by the store.
 */
import { useEffect, useState } from "react";
import type { TaskBoardItem } from "../../preload/index";
import { t } from "../../shared/i18n";
import {
  computeRoundsToApprove,
  formatSprintDuration,
  sprintLabel,
  type SprintView,
} from "./task-board-model";
import { columnForQueueTask } from "./task-fila-v3-decision";
import { queueFactsFromBoardItem } from "./task-fila-v3-facts";
import { closeDialogCounts, formatDurationHm, meanNumber, medianNumber, shareWidths } from "./graficos-sprints-v4-decision";
import { computeArrivalCycles } from "./work-stats";
import styles from "./SprintsV4.module.css";

function dayStamp(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatTenths(value: number | null): string {
  if (value === null) return "—";
  return String(Math.round(value * 10) / 10).replace(".", ",");
}

function openAge(startedAt: number, now: number): string {
  const hours = Math.max(0, now - startedAt) / 3_600_000;
  if (hours < 48) return formatSprintDuration(startedAt, null, now);
  const days = Math.round(hours / 24);
  return days === 1 ? t("task.sprintsV4.day", { n: "1" }) : t("task.sprintsV4.days", { n: String(days) });
}

const PHASE_COLOR: Record<string, string> = {
  done: "#3fb68b",
  review: "#f0a43e",
  running: "#7d8cff",
  ready: "#c9cede",
  waiting: "#4a5068",
};

export function SprintsV4({
  boardId,
  tasks,
  reloadKey,
  onBack,
  onChanged,
}: {
  boardId: string;
  tasks: readonly TaskBoardItem[];
  reloadKey: number;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [sprints, setSprints] = useState<SprintView[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [closing, setClosing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.tasks.listSprints(boardId).then((rows) => {
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

  const active = sprints?.find((s) => s.closedAt === null) ?? null;
  const closed = (sprints ?? []).filter((s) => s.closedAt !== null);
  const unsprinted = closed.find((s) => s.name?.trim() === t("task.sprintsV4.none")) ?? null;
  const past = closed
    .filter((s) => s !== unsprinted)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const scoped = active ? tasks.filter((task) => task.updatedAt >= active.startedAt) : tasks;
  const columns = scoped.map((task) => columnForQueueTask(queueFactsFromBoardItem(task)));
  const counts = {
    done: columns.filter((c) => c === "done").length,
    review: columns.filter((c) => c === "review").length,
    running: columns.filter((c) => c === "running").length,
    ready: columns.filter((c) => c === "ready").length,
    waiting: columns.filter((c) => c === "waiting").length,
  };
  const phaseKeys = ["done", "review", "running", "ready", "waiting"] as const;
  const phaseWidths = shareWidths(phaseKeys.map((key) => counts[key]));
  const closeCounts = closeDialogCounts(columns.filter((c) => c !== "done" && c !== "failed" && c !== "superseded"));
  const cycles = computeArrivalCycles(new Map(scoped.map((task) => [task.id, task.statusTransitions])));
  const medianCycle = medianNumber(cycles.map((c) => c.ms));
  const rounds = computeRoundsToApprove(
    scoped.map((task) => ({
      taskId: task.id,
      label: task.id,
      verdicts: task.verdicts.map((v) => ({ verdict: v.verdict, provider: v.provider, at: v.at })),
    })),
  );
  const meanRounds = meanNumber(rounds.map((r) => r.rounds));
  const superseded = columns.filter((c) => c === "superseded").length;
  const nextNumber = active ? active.number + 1 : 1;

  async function createSprint() {
    setError(null);
    const res = await window.tasks.openSprint(boardId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onChanged();
  }

  async function commitRename(id: string) {
    setError(null);
    const res = await window.tasks.renameSprint(id, draft);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditingId(null);
    onChanged();
  }

  async function confirmClose() {
    if (!active || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.tasks.closeSprint(boardId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setClosing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.shell} data-part="sprints-v4">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack} data-part="sprints-back">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M9 2L4 7l5 5" />
          </svg>
          {t("task.sprintsV4.back")}
        </button>
        <h1 className={styles.title} data-part="sprints-title">
          {t("task.sprintsV4.title")}
        </h1>
        <span className={styles.spacer} />
        <button type="button" className={styles.primary} data-part="sprints-new" onClick={() => void createSprint()}>
          {t("task.sprintsV4.new")}
        </button>
      </header>
      <div className={styles.body} data-part="sprints-scroll">
        {active && (
          <section className={styles.current} aria-label={t("task.sprintsV4.current")} data-part="sprints-current">
            <div className={styles.currentHead}>
              <span className={styles.pill} data-part="sprints-pill">
                {t("task.sprintsV4.currentBadge")}
              </span>
              {editingId === active.id ? (
                <input
                  className={styles.rename}
                  value={draft}
                  aria-label={t("task.sprintName")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(active.id);
                  }}
                />
              ) : (
                <h2 className={styles.currentName}>{sprintLabel(active)}</h2>
              )}
              <span className={styles.meta}>
                {t("task.sprintsV4.since", {
                  date: dayStamp(active.startedAt),
                  dur: openAge(active.startedAt, now),
                })}
              </span>
              <span className={styles.spacer} />
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  setEditingId(active.id);
                  setDraft(active.name ?? "");
                }}
              >
                {t("task.sprintsV4.rename")}
              </button>
              <button type="button" className={styles.btn} data-part="sprints-close" onClick={() => setClosing(true)}>
                {t("task.sprintsV4.close")}
              </button>
            </div>
            <div
              className={styles.bar}
              role="img"
              aria-label={t("task.sprintsV4.bar", counts)}
            >
              {phaseKeys.map((key, index) =>
                counts[key] > 0 ? (
                  <span
                    key={key}
                    data-part={index === 0 ? "sprints-bar-seg" : undefined}
                    style={{ width: `${phaseWidths[index]}%`, background: PHASE_COLOR[key] }}
                  />
                ) : null,
              )}
            </div>
            <div className={styles.legend}>
              {(
                [
                  ["done", counts.done, t("task.sprintsV4.done")],
                  ["review", counts.review, t("task.sprintsV4.review")],
                  ["running", counts.running, t("task.sprintsV4.running")],
                  ["ready", counts.ready, t("task.sprintsV4.ready")],
                  ["waiting", counts.waiting, t("task.sprintsV4.waiting")],
                ] as const
              ).map(([key, n, label]) => (
                <span className={styles.legendItem} key={key}>
                  <span className={styles.dot} style={{ background: PHASE_COLOR[key] }} />
                  {n} {label}
                </span>
              ))}
            </div>
            <div className={styles.stats}>
              <div className={styles.stat}>
                <span className={styles.statLabel}>{t("task.chartsV4.cycle")}</span>
                <span className={styles.statValue}>
                  {medianCycle === null ? "—" : formatDurationHm(medianCycle)}
                </span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>{t("task.chartsV4.rounds")}</span>
                <span className={styles.statValue}>{formatTenths(meanRounds)}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>{t("task.sprintsV4.superseded")}</span>
                <span className={styles.statValue}>{superseded}</span>
              </div>
            </div>
          </section>
        )}

        <section className={styles.past} aria-label={t("task.sprintsV4.past")} data-part="sprints-past">
          <h2 className={styles.secTitle}>{t("task.sprintsV4.past")}</h2>
          {past.map((sprint) => (
            <div className={styles.row} key={sprint.id} data-part="sprints-row">
              <div className={styles.rowMain}>
                {editingId === sprint.id ? (
                  <input
                    className={styles.rename}
                    value={draft}
                    aria-label={t("task.sprintName")}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(sprint.id);
                    }}
                  />
                ) : (
                  <span className={styles.rowName}>{sprintLabel(sprint)}</span>
                )}
                <span className={styles.rowHint}>
                  {dayStamp(sprint.startedAt)} a {sprint.closedAt ? dayStamp(sprint.closedAt) : "—"} · {sprint.countDone}{" "}
                  {t("task.sprintsV4.done")} ·{" "}
                  {sprint.migratedOut > 0
                    ? t("task.sprintsV4.movedTo", {
                        n: String(sprint.migratedOut),
                        name: sprintLabel((sprints ?? []).find((row) => row.number === sprint.number + 1) ?? sprint),
                      })
                    : t("task.sprintsV4.stillOpen", { n: String(sprint.countTodo + sprint.countDoing) })}
                </span>
              </div>
              <span className={styles.closed}>{t("task.sprintsV4.closed")}</span>
              {menuId === sprint.id ? (
                <span className={styles.menu}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => {
                      setEditingId(sprint.id);
                      setDraft(sprint.name ?? "");
                      setMenuId(null);
                    }}
                  >
                    {t("task.sprintsV4.rename")}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={t("task.sprintsV4.more", { name: sprintLabel(sprint) })}
                  onClick={() => setMenuId(sprint.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="#c9cede" aria-hidden="true">
                    <circle cx="3" cy="7" r="1.3" />
                    <circle cx="7" cy="7" r="1.3" />
                    <circle cx="11" cy="7" r="1.3" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          <div className={styles.row} data-part="sprints-unsprinted">
            <div className={styles.rowMain}>
              <span className={styles.rowName}>{t("task.sprintsV4.none")}</span>
              <span className={styles.rowHint}>
                {t("task.sprintsV4.noneHint", { n: String(unsprinted?.countDone ?? 0) })}
              </span>
            </div>
            <button type="button" className={styles.see}>
              {t("task.sprintsV4.see")}
            </button>
          </div>
          {error && <span className={styles.error}>{error}</span>}
        </section>
      </div>

      {closing && active && (
        <div className={styles.overlay}>
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="sprint-close-title" data-part="sprints-close-dialog">
            <h2 id="sprint-close-title">{t("task.sprintsV4.closeAsk", { name: sprintLabel(active) })}</h2>
            <p>{t("task.sprintsV4.closeBody", { n: String(closeCounts.open) })}</p>
            <div className={styles.box}>
              <span>{t("task.sprintsV4.closeRunning", { n: String(closeCounts.running) })}</span>
              <span>{t("task.sprintsV4.closeReview", { n: String(closeCounts.review) })}</span>
              <span>{t("task.sprintsV4.closeRest", { n: String(closeCounts.readyOrWaiting) })}</span>
            </div>
            <label className={styles.field}>
              {t("task.sprintsV4.dest")}
              <select className={styles.select} defaultValue="next">
                <option value="next">{t("task.sprintsV4.destNext", { n: String(nextNumber) })}</option>
              </select>
            </label>
            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={() => setClosing(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className={styles.primary} disabled={busy} onClick={() => void confirmClose()}>
                {t("task.sprintsV4.confirm", { n: String(nextNumber) })}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
