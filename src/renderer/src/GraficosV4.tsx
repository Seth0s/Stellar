/**
 * Fila graphs (Graficos.dc.html). Numbers come from the tasks in view;
 * only attributable verdicts (`aprovado` / `reprovado`) are counted.
 */
import { useState } from "react";
import type { TaskBoardItem } from "../../preload/index";
import { t } from "../../shared/i18n";
import {
  computeRoundsToApprove,
  computeVerdictsByProvider,
  computeCycleTime,
  shortTaskId,
} from "./task-board-model";
import { computeArrivalCycles } from "./work-stats";
import {
  attributableVerdict,
  doneCount,
  doneDelta,
  allocateCycleSegments,
  formatDurationHm,
  histogramBarHeight,
  inPeriod,
  inPreviousPeriod,
  inPreviousSprintWindow,
  inSprintWindow,
  meanNumber,
  medianNumber,
  providerBarScale,
  reviewDurationMs,
  roundBucket,
  type ChartPeriod,
  type RoundBucket,
  verdictShareOfTasks,
} from "./graficos-sprints-v4-decision";
import styles from "./GraficosV4.module.css";

const BUCKETS: RoundBucket[] = ["1", "2", "3", "4+"];

function formatTenths(value: number | null): string {
  if (value === null) return "—";
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace(".", ",");
}

function firstDoneAt(task: TaskBoardItem): number {
  let at = -1;
  for (const tr of task.statusTransitions) {
    if (tr.toValue === "done" && (at < 0 || tr.at < at)) at = tr.at;
  }
  return at;
}

export function GraficosV4({
  tasks,
  boardLabel,
  sprint,
  onBack,
  onOpenTask,
}: {
  tasks: readonly TaskBoardItem[];
  boardLabel: string;
  sprint: { name: string | null; startedAt: number } | null;
  onBack: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [period, setPeriod] = useState<ChartPeriod>("sprint");
  const now = Date.now();
  const sprintStart = sprint?.startedAt ?? null;

  const inCurrent = (updatedAt: number) => {
    if (period === "sprint") return sprintStart === null ? true : inSprintWindow(updatedAt, sprintStart);
    return inPeriod(updatedAt, period, now);
  };
  const inPrevious = (updatedAt: number) => {
    if (period === "sprint") return sprintStart === null ? false : inPreviousSprintWindow(updatedAt, sprintStart, now);
    return inPreviousPeriod(updatedAt, period, now);
  };
  const current = tasks.filter((task) => inCurrent(task.updatedAt));
  const previous = tasks.filter((task) => inPrevious(task.updatedAt));
  const done = doneCount(current);
  const delta = period === "sprint" && sprintStart === null ? null : doneDelta(done, doneCount(previous));

  const verdicts = current.flatMap((task) =>
    task.verdicts
      .filter((v) => attributableVerdict(v.verdict))
      .map((v) => ({ verdict: v.verdict, provider: v.provider, at: v.at })),
  );
  const share = verdictShareOfTasks(current);
  const byProvider = computeVerdictsByProvider(verdicts);
  const scale = providerBarScale(Math.max(0, ...byProvider.map((row) => row.approved + row.rejected)));

  const rounds = computeRoundsToApprove(
    current.map((task) => ({
      taskId: task.id,
      label: shortTaskId(task.id),
      verdicts: task.verdicts.map((v) => ({ verdict: v.verdict, provider: v.provider, at: v.at })),
    })),
  );
  const bucketCounts = { "1": 0, "2": 0, "3": 0, "4+": 0 } as Record<RoundBucket, number>;
  for (const row of rounds) bucketCounts[roundBucket(row.rounds)] += 1;
  const maxBucket = Math.max(1, ...BUCKETS.map((b) => bucketCounts[b]));
  const longOnes = rounds.filter((row) => row.rounds >= 4);

  const cycles = computeArrivalCycles(
    new Map(current.map((task) => [task.id, task.statusTransitions])),
  );
  const cycleValues = cycles.map((c) => c.ms);
  const medianCycle = medianNumber(cycleValues);
  const roundValues = rounds.map((r) => r.rounds);
  const meanRounds = meanNumber(roundValues);
  const medianRounds = medianNumber(roundValues);
  const reopened = cycles.filter((c) => c.reopened).length;

  const arrivalMs = new Map(cycles.map((cycle) => [cycle.taskId, cycle.ms]));
  const measured = current
    .map((task) => {
      const cycle = computeCycleTime(task.statusTransitions, now);
      const review = reviewDurationMs({
        concludingReportAt: task.concludingReportAt ?? null,
        verdicts: task.verdicts,
        transitions: task.statusTransitions,
        now,
      });
      const segments = allocateCycleSegments({
        queuedMs: cycle.queuedMs,
        runningMs: cycle.runningMs,
        reviewMs: review,
      });
      const cycleMs = segments.queuedMs + segments.runningMs + segments.reviewMs;
      return {
        id: task.id,
        queued: segments.queuedMs,
        running: segments.runningMs,
        review: segments.reviewMs,
        cycleMs,
        labelMs: arrivalMs.get(task.id) ?? cycleMs,
        doneAt: firstDoneAt(task),
      };
    })
    .filter((row) => row.cycleMs > 0 && row.doneAt >= 0);
  const cycleRows = [...measured].sort((a, b) => b.doneAt - a.doneAt).slice(0, 5);
  // The five rows are the latest done tasks. The axis is the longest cycle
  // in the period, so a recent bar stays short when an older one was longer.
  const maxCycle = Math.max(1, ...measured.map((row) => row.cycleMs));

  const periodLabel =
    period === "sprint"
      ? sprint?.name?.trim()
        ? `Sprint ${sprint.name.trim()}`
        : t("task.chartsV4.periodSprint")
      : period === "7"
        ? t("task.chartsV4.period7")
        : t("task.chartsV4.period30");
  const signedDelta = delta === null ? null : delta > 0 ? `+${delta}` : String(delta);

  return (
    <div className={styles.shell} data-part="graficos-v4">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack} data-part="graficos-back">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M9 2L4 7l5 5" />
          </svg>
          {t("task.chartsV4.back")}
        </button>
        <h1 className={styles.title} data-part="graficos-title">
          {t("task.chartsV4.title")}
        </h1>
        <div className={styles.periods} role="group" aria-label={t("task.chartsV4.period")} data-part="graficos-periods">
          {(
            [
              ["sprint", t("task.chartsV4.chipSprint")],
              ["7", t("task.chartsV4.chip7")],
              ["30", t("task.chartsV4.chip30")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={period === id ? styles.chipOn : styles.chip}
              aria-pressed={period === id}
              data-part={period === id ? "graficos-chip-on" : "graficos-chip"}
              onClick={() => setPeriod(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className={styles.spacer} />
        <span className={styles.scope}>
          {boardLabel} · {periodLabel} · {t("task.chartsV4.attributable")}
        </span>
      </header>

      <section className={styles.kpis} aria-label={t("task.chartsV4.kpis")} data-part="graficos-kpis">
        <div className={styles.kpi} data-part="graficos-kpi">
          <span className={styles.k}>{t("task.chartsV4.done")}</span>
          <span className={styles.kpiValue}>{done}</span>
          <span className={delta !== null && delta > 0 ? styles.hintUp : styles.hint}>
            {signedDelta === null
              ? t("task.chartsV4.doneSprint")
              : t("task.chartsV4.doneDelta", { n: signedDelta })}
          </span>
        </div>
        <div className={styles.kpi}>
          <span className={styles.k}>{t("task.chartsV4.cycle")}</span>
          <span className={styles.kpiValue}>{medianCycle === null ? "—" : formatDurationHm(medianCycle)}</span>
          <span className={styles.hint}>{t("task.chartsV4.cycleHint")}</span>
        </div>
        <div className={styles.kpi}>
          <span className={styles.k}>{t("task.chartsV4.rounds")}</span>
          <span className={styles.kpiValue}>{formatTenths(meanRounds)}</span>
          <span className={styles.hint}>{t("task.chartsV4.roundsHint", { n: formatTenths(medianRounds) })}</span>
        </div>
        <div className={styles.kpi}>
          <span className={styles.k}>{t("task.chartsV4.reopened")}</span>
          <span className={styles.kpiValue}>{reopened}</span>
          <span className={styles.hint}>{t("task.chartsV4.reopenedHint")}</span>
        </div>
        <div className={styles.kpi}>
          <span className={styles.k}>{t("task.chartsV4.verdict")}</span>
          <span className={styles.kpiValue}>{share.percent === null ? "—" : `${share.percent}%`}</span>
          <span className={styles.hint}>{t("task.chartsV4.verdictHint")}</span>
        </div>
      </section>

      <div className={styles.grid}>
        <section className={styles.panel} aria-label={t("task.chartsV4.byProvider")} data-part="graficos-panel">
          <h2 className={styles.k}>{t("task.chartsV4.byProvider")}</h2>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: "#3fb68b" }} />
              {t("task.chartsV4.approved")}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: "#8a3b30" }} />
              {t("task.chartsV4.rejected")}
            </span>
          </div>
          <div className={styles.bars}>
            {byProvider.length === 0 ? (
              <span className={styles.hint}>{t("task.chartsV4.empty")}</span>
            ) : (
              byProvider.map((row, index) => (
                  <div className={styles.barBlock} key={row.provider}>
                    <div className={styles.barHead} data-part={index === 0 ? "graficos-provider-line" : undefined}>
                      <span className={styles.barName}>{row.provider}</span>
                      <span className={styles.mono}>
                        {row.approved} · {row.rejected}
                      </span>
                    </div>
                    <div className={styles.track}>
                      {row.approved > 0 ? (
                        <span
                          data-part={index === 0 ? "graficos-provider-bar" : undefined}
                          style={{ width: `${(row.approved / scale) * 100}%`, background: "#3fb68b" }}
                        />
                      ) : null}
                      {row.rejected > 0 ? (
                        <span style={{ width: `${(row.rejected / scale) * 100}%`, background: "#8a3b30" }} />
                      ) : null}
                    </div>
                  </div>
                ))
            )}
          </div>
          <p className={styles.note}>{t("task.chartsV4.thinNote")}</p>
        </section>

        <section className={styles.panel} aria-label={t("task.chartsV4.rounds")}>
          <h2 className={styles.k}>{t("task.chartsV4.rounds")}</h2>
          <div className={styles.hist}>
            {BUCKETS.map((bucket) => (
              <div className={styles.col} key={bucket}>
                <span className={styles.colCount}>{bucketCounts[bucket]}</span>
                <span
                  className={bucket === "4+" ? styles.colBarHot : styles.colBar}
                  data-part={bucket === "1" ? "graficos-hist-bar" : undefined}
                  style={{ height: `${histogramBarHeight(bucketCounts[bucket], maxBucket)}px` }}
                />
              </div>
            ))}
          </div>
          <div className={styles.axis}>
            {BUCKETS.map((bucket) => (
              <span key={bucket}>{bucket}</span>
            ))}
          </div>
          <p className={styles.note}>
            {t("task.chartsV4.longRounds")}{" "}
            {longOnes.length === 0
              ? t("task.chartsV4.none")
              : longOnes.map((row, index) => {
                  const task = current.find((item) => item.id === row.taskId);
                  const prompt = task?.promptPreview?.trim() ?? "";
                  const label = `#${row.taskId.slice(0, 6)}${prompt ? ` ${prompt}` : ""}`;
                  return (
                    <span key={row.taskId}>
                      {index > 0 ? ", " : ""}
                      <button type="button" className={styles.link} onClick={() => onOpenTask(row.taskId)}>
                        {label}
                      </button>
                    </span>
                  );
                })}
          </p>
        </section>

        <section className={styles.panel} aria-label={t("task.chartsV4.cycleChart")}>
          <h2 className={styles.k}>{t("task.chartsV4.cycleChart")}</h2>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: "#4a5068" }} />
              {t("task.chartsV4.queued")}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: "#7d8cff" }} />
              {t("task.chartsV4.running")}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: "#f0a43e" }} />
              {t("task.chartsV4.review")}
            </span>
          </div>
          <div className={styles.cycleBars}>
            {cycleRows.length === 0 ? (
              <span className={styles.hint}>{t("task.chartsV4.empty")}</span>
            ) : (
              cycleRows.map((row, index) => (
                <div className={styles.cycleRow} key={row.id}>
                  <button type="button" className={styles.cycleId} onClick={() => onOpenTask(row.id)}>
                    {`#${row.id.slice(0, 6)}`}
                  </button>
                  <div
                    className={styles.cycleTrack}
                    style={{ flex: 1 }}
                    title={t("task.chartsV4.cycleTip")}
                    data-part={index === 0 ? "graficos-cycle-bar" : undefined}
                  >
                    <span
                      data-part={`graficos-cycle-q-${index}`}
                      style={{ width: `${(row.queued / maxCycle) * 100}%`, background: "#4a5068" }}
                    />
                    <span
                      data-part={`graficos-cycle-r-${index}`}
                      style={{ width: `${(row.running / maxCycle) * 100}%`, background: "#7d8cff" }}
                    />
                    <span
                      data-part={`graficos-cycle-v-${index}`}
                      style={{ width: `${(row.review / maxCycle) * 100}%`, background: "#f0a43e" }}
                    />
                  </div>
                  <span className={styles.cycleDur} data-part={`graficos-cycle-dur-${index}`}>
                    {formatDurationHm(row.labelMs)}
                  </span>
                </div>
              ))
            )}
          </div>
          <p className={styles.note}>{t("task.chartsV4.cycleTip")}</p>
        </section>
      </div>
    </div>
  );
}
