import { describe, expect, it } from "vitest";
import {
  closeDialogCounts,
  doneCount,
  doneDelta,
  allocateCycleSegments,
  formatDurationHm,
  reviewDurationMs,
  histogramBarHeight,
  inPeriod,
  inPreviousPeriod,
  inPreviousSprintWindow,
  inSprintWindow,
  meanNumber,
  medianNumber,
  providerBarScale,
  roundBucket,
  shareWidths,
  verdictShare,
  verdictShareOfTasks,
} from "../../src/renderer/src/graficos-sprints-v4-decision";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const DAY = 86_400_000;

describe("graficos-sprints-v4-decision", () => {
  it("keeps the whole board on the sprint period and windows 7/30 by updatedAt", () => {
    expect(inPeriod(NOW - 40 * DAY, "sprint", NOW)).toBe(true);
    expect(inPeriod(NOW - 6 * DAY, "7", NOW)).toBe(true);
    expect(inPeriod(NOW - 8 * DAY, "7", NOW)).toBe(false);
    expect(inPeriod(NOW - 29 * DAY, "30", NOW)).toBe(true);
    expect(inPreviousPeriod(NOW - 10 * DAY, "7", NOW)).toBe(true);
    expect(inPreviousPeriod(NOW - 2 * DAY, "7", NOW)).toBe(false);
    expect(inPreviousPeriod(NOW, "sprint", NOW)).toBe(false);
  });

  it("counts done tasks and a signed delta against the previous window", () => {
    const tasks = [{ status: "done" }, { status: "doing" }, { status: "done" }];
    expect(doneCount(tasks)).toBe(2);
    expect(doneDelta(18, 14)).toBe(4);
    expect(doneDelta(1, 4)).toBe(-3);
    const start = 5_000_000;
    const now = start + 48 * 3_600_000;
    expect(inSprintWindow(start, start)).toBe(true);
    expect(inSprintWindow(start - 1, start)).toBe(false);
    expect(inPreviousSprintWindow(start - 1, start, now)).toBe(true);
    expect(inPreviousSprintWindow(start - 48 * 3_600_000, start, now)).toBe(true);
    expect(inPreviousSprintWindow(start - 48 * 3_600_000 - 1, start, now)).toBe(false);
  });

  it("shares only atribuível verdicts and buckets rounds", () => {
    expect(
      verdictShare([
        { verdict: "aprovado" },
        { verdict: "reprovado" },
        { verdict: null },
        { verdict: "sem_veredito" },
      ]),
    ).toEqual({ typed: 2, total: 4, percent: 50 });
    expect(verdictShare([])).toEqual({ typed: 0, total: 0, percent: null });
    expect(roundBucket(1)).toBe("1");
    expect(roundBucket(0)).toBe("1");
    expect(roundBucket(2)).toBe("2");
    expect(roundBucket(3)).toBe("3");
    expect(roundBucket(4)).toBe("4+");
    expect(medianNumber([1, 4, 2])).toBe(2);
    expect(medianNumber([1, 2])).toBe(1.5);
    expect(medianNumber([])).toBeNull();
  });

  it("matches the graphs mock: mean 1.6, 78% with orphan nulls, scale 30, bar geometry", () => {
    const rounds = [...Array(22).fill(1), ...Array(9).fill(2), ...Array(4).fill(3), ...Array(2).fill(4)];
    expect(meanNumber(rounds)).toBeCloseTo(60 / 37);
    expect(medianNumber(rounds)).toBe(1);
    const typed: { verdicts: { verdict: "aprovado" | null }[] }[] = Array.from({ length: 46 }, () => ({
      verdicts: [{ verdict: "aprovado" }],
    }));
    typed[0]!.verdicts.unshift({ verdict: null });
    const orphans = Array.from({ length: 13 }, () => ({ verdicts: [{ verdict: null }] }));
    expect(verdictShareOfTasks([...typed, ...orphans])).toEqual({ typed: 46, total: 59, percent: 78 });
    expect(providerBarScale(25)).toBe(30);
    expect(histogramBarHeight(22, 22)).toBe(200);
    expect(histogramBarHeight(9, 22)).toBe(82);
    expect(histogramBarHeight(4, 22)).toBe(36);
    expect(histogramBarHeight(2, 22)).toBe(18);
    expect(shareWidths([18, 1, 2, 4, 3])).toEqual([64, 4, 7, 14, 11]);
    expect(formatDurationHm(160 * 60_000)).toBe("2 h 40");
    expect(formatDurationHm(55 * 60_000)).toBe("55 min");
    expect(formatDurationHm(125 * 60_000)).toBe("2 h 05");
    expect(formatDurationHm(250 * 60_000)).toBe("4 h 10");
  });

  it("ends a finished task's review at done or failed when there is no verdict", () => {
    expect(
      reviewDurationMs({
        concludingReportAt: 1_000,
        verdicts: [],
        transitions: [
          { toValue: "running", at: 0 },
          { toValue: "done", at: 4_000 },
        ],
        now: 90_000,
      }),
    ).toBe(3_000);
    expect(
      reviewDurationMs({
        concludingReportAt: 1_000,
        verdicts: [{ at: 8_000, verdict: "aprovado", role: "reviewer" }],
        transitions: [{ toValue: "failed", at: 3_000 }],
        now: 90_000,
      }),
    ).toBe(2_000);
    expect(
      reviewDurationMs({
        concludingReportAt: 1_000,
        verdicts: [{ at: 2_500, verdict: "aprovado", role: "orchestrator" }],
        transitions: [{ toValue: "done", at: 4_000 }],
        now: 90_000,
      }),
    ).toBe(1_500);
    expect(
      reviewDurationMs({
        concludingReportAt: 1_000,
        verdicts: [],
        transitions: [{ toValue: "running", at: 0 }],
        now: 5_800,
      }),
    ).toBe(4_800);
  });

  it("takes the review tail out of running so the three segments sum to the cycle", () => {
    expect(allocateCycleSegments({ queuedMs: 10_000, runningMs: 50_000, reviewMs: 20_000 })).toEqual({
      queuedMs: 10_000,
      runningMs: 30_000,
      reviewMs: 20_000,
    });
    expect(allocateCycleSegments({ queuedMs: 5_000, runningMs: 10_000, reviewMs: 40_000 })).toEqual({
      queuedMs: 5_000,
      runningMs: 0,
      reviewMs: 10_000,
    });
  });

  it("keeps an open review running until now, and ignores an earlier round's verdict", () => {
    expect(
      reviewDurationMs({
        concludingReportAt: 4_000,
        verdicts: [{ at: 2_500, verdict: "reprovado", role: "reviewer" }],
        now: 5_000,
      }),
    ).toBe(1_000);
    expect(
      reviewDurationMs({
        concludingReportAt: 4_000,
        verdicts: [],
        now: 5_800,
      }),
    ).toBe(1_800);
    expect(
      reviewDurationMs({
        concludingReportAt: 2_000,
        verdicts: [
          { at: 1_500, verdict: "aprovado", role: "reviewer" },
          { at: 2_600, verdict: "aprovado", role: "orchestrator" },
        ],
        now: 9_000,
      }),
    ).toBe(600);
    expect(reviewDurationMs({ concludingReportAt: null, verdicts: [], now: 9_000 })).toBe(0);
  });

  it("counts the close dialog from unfinished columns", () => {
    expect(closeDialogCounts(["running", "running", "review", "ready", "waiting", "waiting"])).toEqual({
      running: 2,
      review: 1,
      readyOrWaiting: 3,
      open: 6,
    });
  });
});
