/**
 * Early ack for `spawn_agent` on an autonomous board's spawn queue.
 *
 * Measured: parallel `spawn_agent` calls on a full-cap autonomous board sat
 * in the FIFO for well over a typical MCP client watchdog (~120s); the
 * cardId arrived later only as a bus notice. Without an idempotencyKey, a
 * retry would create a duplicate card on the same tree.
 *
 * Client watchdogs sit well below the queue's 10 min ceiling. Holding the
 * MCP call for the whole wait is what manufactures those ghost cards. This
 * module declares the ack budget under that watchdog and the queue-reason
 * facts the response carries.
 *
 * Why the queue exists (measured, not guessed): `autonomousSpawn` enqueues
 * only when `countRunningAgentsOnBoard(boardId) >= concurrency_cap`. That is
 * the board's declared concurrent-agent ceiling — one slot per running
 * non-bash terminal — not a one-spawn-at-a-time gate and not TUI boot. TUI
 * boot serializes `send_to_card` deliveries on an already-open card; it does
 * not gate spawn admission. Parallel spawns already run up to `concurrency_cap`;
 * raising an undeclared in-flight spawn ceiling would bypass the board's own
 * opt-in limit. The ack does not change that ceiling — it stops holding the
 * caller's tool call while a slot is busy.
 */

/** SLA for the queued ack. Below measured client watchdogs (~120s / ~300s). */
export const SPAWN_QUEUE_ACK_MS = 20_000;

/** Only reason the autonomous spawn FIFO admits an entry today. */
export type SpawnQueueReasonCode = "concurrency_cap";

export type SpawnQueueReason = {
  code: SpawnQueueReasonCode;
  /** Agents already counting against the board cap when this entry joined. */
  running: number;
  /** Board concurrency cap that forced the enqueue. */
  cap: number;
  /** 1-based FIFO position at enqueue time. */
  position: number;
};

export type SpawnRecordStatus = "queued" | "up" | "failed";

/**
 * True when the MCP call has waited long enough that holding it further
 * risks a client watchdog abort. Used by the race path; the production
 * enqueue path acks immediately because a concurrency-cap wait is always
 * agent-lifetime scale (measured 125s+), never sub-ack.
 */
export function shouldAckQueuedSpawn(
  waitedMs: number,
  ackMs: number = SPAWN_QUEUE_ACK_MS,
): boolean {
  return waitedMs >= ackMs;
}

/** Agent-facing one-liner for the queued response / get_spawn. */
export function describeSpawnQueueReason(reason: SpawnQueueReason): string {
  return (
    `autonomous board at concurrency cap (${reason.running}/${reason.cap}); ` +
    `queue position ${reason.position}`
  );
}

/**
 * Build the reason snapshot at enqueue time. Position is 1-based length
 * after push would land — pass the post-push index (list.length with the
 * new entry already appended, or priorLength + 1).
 */
export function spawnQueueReasonAtEnqueue(input: {
  running: number;
  cap: number;
  position: number;
}): SpawnQueueReason {
  return {
    code: "concurrency_cap",
    running: input.running,
    cap: input.cap,
    position: input.position,
  };
}
