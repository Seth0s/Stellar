import { describe, expect, it } from "vitest";
import { decideAgentLineMarks, decideFileOwner } from "../../src/renderer/src/code-line-attribution-decision";

describe("decideAgentLineMarks", () => {
  it("expands hunks and lets the later at win on overlap", () => {
    const marks = decideAgentLineMarks([
      {
        fromLine: 742,
        toLine: 745,
        cardId: "a",
        color: "#f0883e",
        label: "IMPL",
        taskId: "t1",
        taskTitle: "replay",
        at: 100,
      },
      {
        fromLine: 745,
        toLine: 745,
        cardId: "b",
        color: "#5b8cff",
        label: "REV",
        taskId: "t2",
        taskTitle: null,
        at: 200,
      },
    ]);
    expect(marks.get(742)?.cardId).toBe("a");
    expect(marks.get(745)?.cardId).toBe("b");
    expect(marks.get(745)?.color).toBe("#5b8cff");
    expect(marks.size).toBe(4);
  });

  it("skips inverted ranges", () => {
    expect(
      decideAgentLineMarks([
        {
          fromLine: 10,
          toLine: 5,
          cardId: "a",
          color: "#f00",
          label: null,
          taskId: null,
          taskTitle: null,
          at: null,
        },
      ]).size,
    ).toBe(0);
  });
});

describe("decideFileOwner", () => {
  const a = { cardId: "a", label: "IMPL", at: 1 };
  const b = { cardId: "b", label: "REVISOR", at: 2 };

  it("a single declared owner wins over territory", () => {
    expect(decideFileOwner([a], [b])).toEqual(a);
  });

  it("two declared owners are not evidence of either", () => {
    expect(decideFileOwner([a, b], [])).toBeNull();
  });

  it("without a declaration, one running agent in the territory is the owner", () => {
    expect(decideFileOwner(null, [b])).toEqual(b);
  });

  it("without a declaration, two agents in the territory stay unattributed", () => {
    expect(decideFileOwner(null, [a, b])).toBeNull();
    expect(decideFileOwner(null, [])).toBeNull();
  });
});
