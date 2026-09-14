import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: spawn_card task singleton", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the live queue before consent instead of creating another card", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-task-card-"));
    const onSpawnCardRequest = (..._args: never[]) => {
      throw new Error("an existing queue must not reach the spawn/consent path");
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getCardBoardId: (id: string) => (id === "agent-1" ? "board-a" : undefined),
        listCardsForBoard: () => [
          { id: "queue-4", boardId: "board-a", kind: "task", archivedAt: null },
        ],
        listCards: () => [],
        onSpawnCardRequest,
      }),
    );

    const result = await bus.handleRequest({ cmd: "spawn_card", kind: "task", reason: "test", requesterId: "agent-1" } as BusRequest);

    expect(result).toEqual({ ok: true, cardId: "queue-4" });
  });
});
