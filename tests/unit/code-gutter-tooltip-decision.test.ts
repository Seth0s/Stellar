import { describe, expect, it } from "vitest";
import { decideGutterTooltip } from "../../src/renderer/src/code-gutter-tooltip-decision";

describe("decideGutterTooltip", () => {
  it("formats who/range/task/when from mark facts", () => {
    const tip = decideGutterTooltip(
      {
        line: 744,
        cardId: "abcd1234",
        color: "#f0883e",
        label: "IMPL · Claude",
        taskId: "c5b6ae11-xxxx",
        taskTitle: "replay",
        at: 1_000_000,
        fromLine: 742,
        toLine: 745,
      },
      1_000_000 + 90_000,
    );
    expect(tip.title).toContain("IMPL · Claude");
    expect(tip.title).toContain("742–745");
    expect(tip.taskLine).toContain("#c5b6ae");
    expect(tip.whenLine).toBe("1 min ago");
  });
});
