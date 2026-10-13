import { describe, expect, it } from "vitest";
import type { TaskBoardItem } from "../../src/preload/index";
import { queueFactsFromBoardItem } from "../../src/renderer/src/task-fila-v3-facts";
import { deriveTileStatusPhrase } from "../../src/renderer/src/task-fila-v3-decision";

describe("Fila V3 failed task facts", () => {
  it("carries the main-process failure kind into the tile phrase", () => {
    const item = {
      id: "task-1",
      status: "failed",
      phase: "failed",
      failureKind: "julgada",
      updatedAt: Date.parse("2026-09-23T12:00:00"),
    } as unknown as TaskBoardItem;

    const facts = queueFactsFromBoardItem(item);
    expect(facts.failureKind).toBe("julgada");
    expect(deriveTileStatusPhrase(facts)).toBe("✕ julgada · 23/09");
  });
});
