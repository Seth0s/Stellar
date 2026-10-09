import { describe, it, expect } from "vitest";
import {
  SPAWN_QUEUE_ACK_MS,
  describeSpawnQueueReason,
  shouldAckQueuedSpawn,
  spawnQueueReasonAtEnqueue,
} from "../../src/main/spawn-queue-ack-decision";

/** Early ack budget for the autonomous spawn_agent queue. */
describe("spawn-queue-ack-decision", () => {
  it("declares an ack budget below measured client watchdogs (120s / 300s)", () => {
    expect(SPAWN_QUEUE_ACK_MS).toBe(20_000);
    expect(SPAWN_QUEUE_ACK_MS).toBeLessThan(120_000);
    expect(SPAWN_QUEUE_ACK_MS).toBeLessThan(300_000);
  });

  it("acks once waitedMs reaches the declared budget", () => {
    expect(shouldAckQueuedSpawn(SPAWN_QUEUE_ACK_MS - 1)).toBe(false);
    expect(shouldAckQueuedSpawn(SPAWN_QUEUE_ACK_MS)).toBe(true);
  });

  it("records concurrency_cap facts as the queue reason (not TUI boot)", () => {
    const reason = spawnQueueReasonAtEnqueue({ running: 4, cap: 4, position: 2 });
    expect(reason).toEqual({ code: "concurrency_cap", running: 4, cap: 4, position: 2 });
    expect(describeSpawnQueueReason(reason)).toContain("concurrency cap (4/4)");
    expect(describeSpawnQueueReason(reason)).toContain("position 2");
  });
});
