import { describe, expect, it } from "vitest";
import { decideTaskCardSpawn, type TaskCardGuardCard } from "../../src/task-card-guard";

const card = (overrides: Partial<TaskCardGuardCard> = {}): TaskCardGuardCard => ({
  id: "queue-1",
  boardId: "board-a",
  kind: "task",
  archivedAt: null,
  ...overrides,
});

describe("decideTaskCardSpawn", () => {
  it("creates a queue when the board has no live task card", () => {
    expect(decideTaskCardSpawn([], "board-a")).toEqual({ action: "create" });
  });

  it("reuses the board's live queue", () => {
    expect(decideTaskCardSpawn([card({ id: "queue-7" })], "board-a")).toEqual({
      action: "reuse",
      cardId: "queue-7",
      existingCount: 1,
    });
  });

  it("does not let an archived queue occupy the board's slot", () => {
    expect(decideTaskCardSpawn([card({ id: "old-queue", archivedAt: 123 })], "board-a")).toEqual({ action: "create" });
  });

  it("ignores a queue belonging to another board", () => {
    expect(decideTaskCardSpawn([card({ id: "other-queue", boardId: "board-b" })], "board-a")).toEqual({ action: "create" });
  });

  it("reuses one deterministic queue without deleting legacy duplicates", () => {
    expect(
      decideTaskCardSpawn([
        card({ id: "queue-10" }),
        card({ id: "queue-2" }),
      ], "board-a"),
    ).toEqual({ action: "reuse", cardId: "queue-2", existingCount: 2 });
  });
});
