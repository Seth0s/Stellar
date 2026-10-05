/**
 * Renderer-side decisions for xterm writes.
 *
 * Two problems, one place.
 *
 * 1. A card that is off the canvas viewport (or on a board the user has left)
 *    must not pay to draw. The bytes are still retained by the main process
 *    (the per-card ring, `session-scrollback.ts`), but parsing and repainting
 *    them is the expensive part and it was happening unconditionally — measured
 *    in `docs/PERF.md` §2.3. So the xterm write is SKIPPED and the raw bytes are
 *    held here, in arrival order, until the card is visible again.
 * 2. A card that IS on screen but is not the one in focus can be drawn in
 *    batches instead of once per PTY flush. The focused card is never throttled.
 *
 * Only the DECISION lives here — the caller owns the xterm, the timers and the
 * state instance. This is pure so the frame grouping and the replay-order
 * guarantee are testable without a terminal.
 */

/** A visible-but-unfocused card draws at most once per this window (~15 fps). */
export const UNFOCUSED_FLUSH_MS = 66;

/**
 * Cap on raw output held for replay while a card is off the viewport. Kept in
 * the same order as the main ring's declared default so the two buffers are
 * honest about the same horizon: past it, the oldest bytes are dropped and the
 * xterm shows a bounded gap, exactly like a background-session ring replay.
 */
export const HIDDEN_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

export type DrawMode = "now" | "coalesce" | "skip";

/**
 * May this card draw right now, and how? Off-viewport never; visible and
 * focused immediately; visible but unfocused at the coalesced cap.
 */
export function decideTerminalDraw(input: { visible: boolean; focused: boolean }): DrawMode {
  if (!input.visible) return "skip";
  if (input.focused) return "now";
  return "coalesce";
}

/** Raw chunks held back from the xterm, in arrival order. */
export type PendingDraw = { chunks: string[]; bytes: number };

export function createPendingDraw(): PendingDraw {
  return { chunks: [], bytes: 0 };
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The tail of `text` that fits in `maxBytes`, never splitting a code point. */
function tailByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const points = Array.from(text);
  let budget = maxBytes;
  let take = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const len = byteLength(points[i]);
    if (budget - len < 0) break;
    budget -= len;
    take++;
  }
  return points.slice(points.length - take).join("");
}

/**
 * Appends one raw chunk and caps the total: oldest chunks leave from the front
 * until it fits, and a single chunk larger than the cap is kept by its TAIL.
 * Returns a new state (callers assign it back), same shape as the main ring.
 */
export function appendPendingDraw(state: PendingDraw, chunk: string, maxBytes = HIDDEN_OUTPUT_MAX_BYTES): PendingDraw {
  if (chunk.length === 0) return state;
  const chunkBytes = byteLength(chunk);
  if (maxBytes <= 0) return createPendingDraw();
  if (chunkBytes >= maxBytes) {
    const tail = tailByBytes(chunk, maxBytes);
    return { chunks: [tail], bytes: byteLength(tail) };
  }
  let chunks = state.chunks.concat(chunk);
  let bytes = state.bytes + chunkBytes;
  let first = 0;
  // The newly appended chunk always fits alone (guarded above), so the loop can
  // never evict it.
  while (bytes > maxBytes && first < chunks.length - 1) {
    bytes -= byteLength(chunks[first]);
    first++;
  }
  if (first > 0) chunks = chunks.slice(first);
  return { chunks, bytes };
}

/** The held text in arrival order. Non-destructive — `flushPendingDraw` drains. */
export function readPendingDraw(state: PendingDraw): string {
  return state.chunks.join("");
}

export function hasPendingDraw(state: PendingDraw): boolean {
  return state.chunks.length > 0;
}

/**
 * Drains the held output for a SINGLE xterm write. The returned `next` is a
 * fresh empty state: whatever comes back in `text` is written exactly once, so
 * no byte is drawn twice and none is dropped by the drain itself.
 */
export function flushPendingDraw(state: PendingDraw): { text: string; next: PendingDraw } {
  return { text: state.chunks.join(""), next: createPendingDraw() };
}
