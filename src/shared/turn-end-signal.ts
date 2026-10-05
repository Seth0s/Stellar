/**
 * Screen turn-end markers, shared by the renderer and the main process.
 *
 * A provider can declare how its turn ends as a screen pattern
 * (`capacity.delivery.turnEnd` with mechanism "screen"); a TUI that never
 * fires a hook (commandcode) is only readable this way. The renderer feeds
 * raw pty chunks to draw the activity bar; the main process feeds coalesced
 * output so the turn fact exists even when no board is mounted.
 *
 * Pure and dependency-free on purpose: both processes import the same matcher,
 * so a marker recognized on screen cannot mean two different things.
 */

/** Rolling window that keeps a split marker intact across chunks. */
export const TURN_END_BUFFER_MAX = 500;

/**
 * Feed one chunk and report whether the marker appeared.
 *
 * The whole combined text is tested BEFORE the window shrinks. A TUI frame
 * arrives as one large write and the marker can sit in the middle of it, so
 * trimming first would drop the marker whenever the tail of the same chunk is
 * longer than the window. `tail` is always returned for the caller to keep;
 * `matched` clears it, since a consumed marker must not fire again.
 */
export function feedTurnEndChunk(
  tail: string,
  data: string,
  pattern: RegExp,
  max: number = TURN_END_BUFFER_MAX,
): { matched: boolean; tail: string } {
  const combined = tail + data;
  if (pattern.test(combined)) return { matched: true, tail: "" };
  return { matched: false, tail: combined.slice(-max) };
}
