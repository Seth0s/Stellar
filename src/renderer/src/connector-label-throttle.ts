/**
 * Pure decision logic for the connector label auto-refresh throttle
 * (App.tsx's `autoConnect` → `scheduleConnectorLabelUpdate`).
 *
 * Review adversarial, RODADA 5 (2026-09-09) — the reviewer pushed back on
 * "sem jsdom não dá" as a blanket excuse for not testing this feature's
 * timing logic, and was right to: the bug that round (a board switch's
 * `await loadBoard(next)` window, where `activeBoardIdRef` already points
 * at the NEW board but `connectorsRef` still holds the OLD board's
 * connectors, letting a stale IPC event stamp a throttle snapshot with
 * the wrong board id) is a pure function of state, not of React or the
 * DOM. "Given this event and the current transition/throttle state, do I
 * write now, queue for later, or drop it?" needs no ref, no timer, no
 * IPC call, no component — extracting exactly that question here is what
 * makes it testable in plain Node (same category as `board-model.ts`/
 * `mask-buffer.ts`, this repo's existing precedent for pulling pure logic
 * out of a component). App.tsx keeps every side effect (the `Map` of
 * timers, `setTimeout`, `window.store.connectors.upsert`, `setConnectors`)
 * — this module only ever answers the question, never performs anything.
 */

export type ConnectorLabelScheduleDecision =
  | { action: "ignore"; reason: "board-transition" | "connector-gone" | "same-label" }
  | { action: "flush-now" }
  | { action: "queue"; waitMs: number };

export interface ConnectorLabelScheduleInput {
  /**
   * True while a board switch/delete is between `setActiveBoardId` and
   * the end of the corresponding `loadBoard` (useBoardStore.ts's
   * `boardTransitionRef`). During that window `activeBoardIdRef` already
   * points at the incoming (or, for a delete, the next) board while
   * `connectorsRef` can still hold the OUTGOING board's connectors — any
   * snapshot taken in there would stamp `boardId` with the WRONG board.
   * There's no board a snapshot taken here could safely point to (the
   * connector belongs to whichever board is being LEFT, which for a
   * delete may not even exist by the time the load finishes) — so a
   * transition in flight always means ignore, unconditionally, checked
   * before anything else.
   */
  boardTransitionInFlight: boolean;
  /** Whether the connector this event targets is still present in the
   * caller's current view of state (App.tsx's `connectorsRef.current`). */
  connectorExists: boolean;
  /** The connector's current label (`null` if it has none yet). */
  currentLabel: string | null;
  /** The label this event is proposing. */
  nextLabel: string;
  /** `Date.now()` at decision time. */
  now: number;
  /** `0` if this connector has never had a throttled write. */
  lastWriteAt: number;
  /** Whether a trailing timer is already scheduled for this connector. */
  hasPendingTimer: boolean;
  /** `CONNECTOR_LABEL_THROTTLE_MS` (App.tsx). */
  throttleWindowMs: number;
}

/**
 * The single decision point the throttle's scheduling entry point
 * (`scheduleConnectorLabelUpdate`, App.tsx) consults before touching any
 * state. Total order of checks matters: a transition in flight overrides
 * everything else (a stale-but-real connector with a genuinely new label
 * is STILL the wrong thing to schedule against a board that might be
 * mid-swap), then "does the connector even still exist", then "is this
 * actually a change" — only once none of those short-circuit does the
 * throttle window's own leading/trailing math run.
 */
export function decideConnectorLabelSchedule(input: ConnectorLabelScheduleInput): ConnectorLabelScheduleDecision {
  if (input.boardTransitionInFlight) return { action: "ignore", reason: "board-transition" };
  if (!input.connectorExists) return { action: "ignore", reason: "connector-gone" };
  if (input.nextLabel === input.currentLabel) return { action: "ignore", reason: "same-label" };

  const elapsed = input.now - input.lastWriteAt;
  if (elapsed >= input.throttleWindowMs && !input.hasPendingTimer) return { action: "flush-now" };
  return { action: "queue", waitMs: Math.max(input.throttleWindowMs - elapsed, 0) };
}
