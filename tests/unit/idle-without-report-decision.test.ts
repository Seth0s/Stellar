import { describe, it, expect } from "vitest";
import {
  IDLE_WITHOUT_REPORT_MS,
  IDLE_WITHOUT_REPORT_POLL_MS,
  decideIdleWithoutReport,
} from "../../src/main/idle-without-report-decision";
import { ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS } from "../../src/renderer/src/terminal-activity-decision";

describe("idle-without-report-decision — SINAL 3 gate", () => {
  it("floor matches the activity-bar silence-as-work ceiling (180s), not card_status's 5s", () => {
    expect(IDLE_WITHOUT_REPORT_MS).toBe(180_000);
    expect(IDLE_WITHOUT_REPORT_MS).toBe(ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS);
    expect(IDLE_WITHOUT_REPORT_POLL_MS).toBe(5_000);
  });

  const base = {
    alive: true,
    waitingOnConsent: false,
    hasReport: false,
    hasLinkedRunningTask: true,
    alreadyNotified: false,
    msSinceLastActivity: IDLE_WITHOUT_REPORT_MS,
  };

  it("notify only when alive, linked, no report, past floor, not waiting, not yet notified", () => {
    expect(decideIdleWithoutReport(base)).toEqual({ action: "notify" });
  });

  it("never notifies a card waiting on consent", () => {
    expect(decideIdleWithoutReport({ ...base, waitingOnConsent: true })).toEqual({
      action: "skip",
      reason: "waiting_consent",
    });
  });

  it("false positive guard: reported + idle waiting for follow-up is skipped", () => {
    expect(decideIdleWithoutReport({ ...base, hasReport: true })).toEqual({
      action: "skip",
      reason: "has_report",
    });
  });

  it("only cards with a linked non-judgment task qualify", () => {
    expect(decideIdleWithoutReport({ ...base, hasLinkedRunningTask: false })).toEqual({
      action: "skip",
      reason: "no_linked_running_task",
    });
  });

  it("once-only: already notified this episode → skip", () => {
    expect(decideIdleWithoutReport({ ...base, alreadyNotified: true })).toEqual({
      action: "skip",
      reason: "already_notified",
    });
  });

  it("below the floor (incl. card_status's 5s idle) → not yet", () => {
    for (const ms of [0, 5_000, 60_000, IDLE_WITHOUT_REPORT_MS - 1]) {
      expect(decideIdleWithoutReport({ ...base, msSinceLastActivity: ms })).toEqual({
        action: "skip",
        reason: "not_idle_long_enough",
      });
    }
  });

  it("dead card / unknown activity → skip (exit path owns death)", () => {
    expect(decideIdleWithoutReport({ ...base, alive: false })).toEqual({
      action: "skip",
      reason: "not_alive",
    });
    expect(decideIdleWithoutReport({ ...base, msSinceLastActivity: null })).toEqual({
      action: "skip",
      reason: "activity_unknown",
    });
  });
});
