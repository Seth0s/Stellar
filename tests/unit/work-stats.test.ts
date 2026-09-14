import { describe, expect, it } from "vitest";
import {
  MIN_COMPARE_N,
  computeArrivalCycles,
  computeWorkStats,
  formatCycleMinutes,
  median,
} from "../../src/renderer/src/work-stats";

describe("median", () => {
  it("empty is null — absence, not zero", () => {
    expect(median([])).toBeNull();
  });
  it("odd and even", () => {
    expect(median([3])).toBe(3);
    expect(median([1, 3, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("computeArrivalCycles", () => {
  it("first pending → first done; reopen flagged without stretching", () => {
    const byTask = new Map([
      [
        "t1",
        [
          { toValue: "pending", fromValue: null, at: 1000 },
          { toValue: "running", fromValue: "pending", at: 2000 },
          { toValue: "done", fromValue: "running", at: 5000 },
          { toValue: "pending", fromValue: "done", at: 8000 },
          { toValue: "done", fromValue: "pending", at: 9000 },
        ],
      ],
    ]);
    const cycles = computeArrivalCycles(byTask);
    expect(cycles).toEqual([
      {
        taskId: "t1",
        firstPendingAt: 1000,
        firstDoneAt: 5000,
        ms: 4000,
        reopened: true,
      },
    ]);
  });

  it("detects reopen from toValue trail alone when fromValue omitted", () => {
    const byTask = new Map([
      [
        "t2",
        [
          { toValue: "pending", at: 0 },
          { toValue: "done", at: 10 },
          { toValue: "running", at: 20 },
        ],
      ],
    ]);
    expect(computeArrivalCycles(byTask)[0].reopened).toBe(true);
  });

  it("omits tasks missing a bound", () => {
    const byTask = new Map([["open", [{ toValue: "pending", at: 1 }]]]);
    expect(computeArrivalCycles(byTask)).toEqual([]);
  });
});

describe("computeWorkStats", () => {
  it("aggregates cycle, rounds, coverage; refuses provider compare under MIN_COMPARE_N", () => {
    const stats = computeWorkStats([
      {
        id: "a",
        status: "done",
        statusTransitions: [
          { toValue: "pending", fromValue: null, at: 0 },
          { toValue: "done", fromValue: "pending", at: 10 * 60_000 },
        ],
        verdicts: [
          { verdict: null, provider: "cursor", at: 1 },
          { verdict: "aprovado", provider: "cursor", at: 2 },
        ],
        cards: [{ cardId: "1", role: "implementer", provider: "cursor", model: null, orphan: true }],
      },
      {
        id: "b",
        status: "done",
        statusTransitions: [
          { toValue: "pending", fromValue: null, at: 0 },
          { toValue: "done", fromValue: "pending", at: 30 * 60_000 },
        ],
        verdicts: [{ verdict: null, provider: null, at: 1 }],
        cards: [{ cardId: "2", role: "implementer", provider: null, model: null, orphan: true }],
      },
      {
        id: "c",
        status: "running",
        statusTransitions: [{ toValue: "pending", fromValue: null, at: 0 }],
        verdicts: [],
        cards: [{ cardId: "3", role: "implementer", provider: "claude", model: "opus", orphan: false }],
      },
    ]);

    expect(stats.medianCycleMs).toBe(((10 + 30) / 2) * 60_000);
    expect(stats.medianRounds).toBe(1.5);
    expect(stats.coverage.reopened).toBe(0);
    expect(stats.coverage.verdictNull).toBe(2);
    expect(stats.coverage.verdictTyped).toBe(1);
    expect(stats.coverage.orphanParticipations).toBe(2);
    expect(stats.coverage.withProvider).toBe(2);
    expect(stats.providerRounds).toEqual([
      {
        key: "cursor",
        provider: "cursor",
        model: null,
        tasks: 1,
        medianRounds: 2,
        insufficient: true,
      },
    ]);
    expect(MIN_COMPARE_N).toBe(5);
    expect(formatCycleMinutes(5.5 * 60_000)).toBe("5.5");
    expect(formatCycleMinutes(41.4 * 60_000)).toBe("41");
  });
});
