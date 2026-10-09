import { describe, it, expect } from "vitest";
import {
  CHECKPOINT_WRITE_THRESHOLD,
  decideCheckpointReminder,
  isFinalReport,
  latestFinalSeq,
  normalizeReportEstado,
  reportConcludesTask,
  reportDeclaresIntention,
} from "../../src/main/report-estado-decision";

/**
 * Report estado contract: absence is parcial, never completeness.
 * Mutation: flip normalizeReportEstado's default to "final" → first case red.
 */

describe("normalizeReportEstado", () => {
  it("missing estado is parcial (absence is not completeness)", () => {
    expect(normalizeReportEstado({ ok: true, taskId: "t" })).toBe("parcial");
    expect(normalizeReportEstado({ ok: true, estado: "final" })).toBe("final");
    expect(normalizeReportEstado({ ok: true, estado: "parcial" })).toBe("parcial");
    expect(normalizeReportEstado({ ok: true, estado: "FINAL" })).toBe("final");
    expect(normalizeReportEstado({ ok: true, estado: "done" })).toBe("parcial");
    expect(normalizeReportEstado("x")).toBe("parcial");
  });
});

describe("reportConcludesTask", () => {
  it("ok:true without final does NOT conclude; ok:true + final does", () => {
    expect(reportConcludesTask({ ok: true })).toBe(false);
    expect(reportConcludesTask({ ok: true, estado: "parcial" })).toBe(false);
    expect(reportConcludesTask({ ok: false, estado: "final" })).toBe(false);
    expect(reportConcludesTask({ ok: true, estado: "final" })).toBe(true);
  });
});

describe("latestFinalSeq", () => {
  it("a later parcial does not erase an earlier final seq", () => {
    expect(
      latestFinalSeq([
        { seq: 1, report: { ok: true, estado: "final" } },
        { seq: 2, report: { ok: true, estado: "parcial", note: "more" } },
      ]),
    ).toBe(1);
    expect(latestFinalSeq([{ seq: 3, report: { ok: true } }])).toBeNull();
  });
});

describe("reportDeclaresIntention + checkpoint reminder", () => {
  it("threshold matches the measured 2× median filesChanged", () => {
    expect(CHECKPOINT_WRITE_THRESHOLD).toBe(8);
  });

  it("reminds once after N writes without intention; silent when already notified or under threshold", () => {
    expect(
      decideCheckpointReminder({ writesSinceCheckpoint: 7, alreadyNotified: false }),
    ).toEqual({ action: "silent" });
    expect(
      decideCheckpointReminder({ writesSinceCheckpoint: 8, alreadyNotified: false }),
    ).toEqual({ action: "remind", writesSinceCheckpoint: 8, threshold: 8 });
    expect(
      decideCheckpointReminder({ writesSinceCheckpoint: 20, alreadyNotified: true }),
    ).toEqual({ action: "silent" });
  });

  it("decisaoTomada / decision counts as intention", () => {
    expect(reportDeclaresIntention({ decisaoTomada: "ship the filter" })).toBe(true);
    expect(reportDeclaresIntention({ decision: "ship" })).toBe(true);
    expect(reportDeclaresIntention({ ok: true })).toBe(false);
    expect(isFinalReport({ estado: "final" })).toBe(true);
  });
});
