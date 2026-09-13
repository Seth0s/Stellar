import { describe, it, expect } from "vitest";
import {
  ACTIVITY_SWEEP_WIDTH_RATIO,
  activitySweepCardTravelPercent,
  activitySweepTranslatePercent,
} from "../../src/renderer/src/terminal-activity-sweep";

describe("activity sweep travel", () => {
  it("translateX(200%) of a 34% strip only covers 68% of the card (photographed freeze)", () => {
    expect(ACTIVITY_SWEEP_WIDTH_RATIO).toBe(0.34);
    expect(activitySweepCardTravelPercent(200)).toBeCloseTo(68, 5);
  });

  it("right edge of the card takes ~294% of the strip, not 200%", () => {
    expect(activitySweepTranslatePercent(1)).toBeCloseTo(100 / 0.34, 5);
    expect(activitySweepTranslatePercent(1)).toBeGreaterThan(290);
  });

  it("fully exiting the card is one card width plus the strip itself", () => {
    const endAt = 1 + ACTIVITY_SWEEP_WIDTH_RATIO;
    expect(activitySweepCardTravelPercent(activitySweepTranslatePercent(endAt))).toBeCloseTo(endAt * 100, 5);
    // Literal in TerminalCard.module.css — keep the two in lockstep.
    expect(activitySweepTranslatePercent(endAt)).toBeCloseTo(394.117647, 5);
  });
});
