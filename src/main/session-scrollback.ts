/**
 * Per-card ring buffer of raw PTY output.
 *
 * Why it exists: the renderer's xterm holds the real scrollback, and the main
 * process cannot read it. When a board is unmounted (its terminals disposed,
 * nothing rendered) the process keeps running; without a copy here, everything
 * the process writes in that gap is lost and the terminal comes back blank.
 * This module is that copy: a byte ring (not lines) with a configurable cap,
 * fed by every raw `proc.onData` chunk.
 *
 * It is deliberately a string, not a terminal model: replay is best-effort.
 * Writing the raw stream back into a fresh xterm repaints the recent history,
 * and a cut in the middle of an ANSI escape at the window start is trimmed by
 * `trimLeadingPartialEscape`. This is not an emulator — it does not try to
 * reconstruct exact screen state, only to show again what happened.
 */

/** 2 MB per card. */
export const DEFAULT_SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The cap is configurable through `STELLAR_SCROLLBACK_MAX_BYTES`; the default
 * is always declared, never "unlimited". `0` is accepted and means "keep
 * nothing" (replay comes back empty). Invalid input falls back to the default,
 * never to `NaN`/`Infinity`.
 */
export function resolveScrollbackMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STELLAR_SCROLLBACK_MAX_BYTES);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_SCROLLBACK_MAX_BYTES;
  return Math.floor(raw);
}

export type ScrollbackState = {
  /** Chunks in arrival order; the oldest is evicted first. */
  chunks: string[];
  /** Sum of the UTF-8 bytes currently retained (not characters). */
  bytes: number;
  /** Bytes already dropped from the front. */
  droppedBytes: number;
};

export function createScrollback(): ScrollbackState {
  return { chunks: [], bytes: 0, droppedBytes: 0 };
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The tail of `text` within `maxBytes` bytes; never cuts a code point in half
 *  (walks backwards until the budget runs out). */
function tailByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLen(text) <= maxBytes) return text;
  let budget = maxBytes;
  let start = text.length;
  while (start > 0) {
    const len = byteLen(text[start - 1]);
    if (budget - len < 0) break;
    budget -= len;
    start--;
  }
  return text.slice(start);
}

/**
 * Appends a raw chunk and applies the cap: oldest chunks leave from the front
 * until it fits. A single chunk larger than the cap is kept by its TAIL (the
 * most recent part is what the user needs to see). `maxBytes === 0` drops
 * everything while keeping an honest count of dropped bytes.
 */
export function appendScrollback(state: ScrollbackState, chunk: string, maxBytes: number): ScrollbackState {
  if (chunk.length === 0) return state;
  const chunkBytes = byteLen(chunk);
  if (maxBytes <= 0) {
    return { chunks: [], bytes: 0, droppedBytes: state.droppedBytes + state.bytes + chunkBytes };
  }
  if (chunkBytes >= maxBytes) {
    const tail = tailByBytes(chunk, maxBytes);
    const tailBytes = byteLen(tail);
    return {
      chunks: [tail],
      bytes: tailBytes,
      droppedBytes: state.droppedBytes + state.bytes + (chunkBytes - tailBytes),
    };
  }
  let chunks = state.chunks.concat(chunk);
  let bytes = state.bytes + chunkBytes;
  let droppedBytes = state.droppedBytes;
  // Evict from the front until it fits; the newly appended chunk is never
  // removed (the size guard above already guarantees it fits alone).
  let first = 0;
  while (bytes > maxBytes && first < chunks.length - 1) {
    const len = byteLen(chunks[first]);
    bytes -= len;
    droppedBytes += len;
    first++;
  }
  if (first > 0) chunks = chunks.slice(first);
  return { chunks, bytes, droppedBytes };
}

/** The retained text in chronological order (oldest to newest). */
export function readScrollback(state: ScrollbackState): string {
  return state.chunks.join("");
}

/**
 * Trims the start of a stream cut in the middle of an ANSI escape sequence, so
 * replay does not begin by printing the tail of a CSI/OSC.
 *
 * Declared best-effort, not a parser: it covers the real case (the ring cut
 * the buffer start) and passes through what it does not recognize, because
 * dropping real content would be worse than a stray escape. If the text begins
 * with a well-formed CSI, nothing is removed; if it begins with the tail of one
 * (without the ESC, or with an ESC that never terminates), it advances to the
 * first line break.
 *
 * The ESC regexes are built from strings rather than literals: a `\u001b`
 * inside a regex literal triggers `no-control-regex`.
 */
const WELL_FORMED_CSI = new RegExp(`^\\u001b\\[[0-9;?]*[ -/]*[@-~]`);
/** Tail without the ESC: starts with an escape parameter/terminator. Built
 *  from a string (`\u005D` = `]`, which in a literal would need escaping and
 *  trigger `no-useless-escape`). */
const ESCAPE_FRAGMENT_START = new RegExp("^[[;0-9?\\u005D]");

export function trimLeadingPartialEscape(text: string): string {
  const ESC = "\u001b";
  if (text.length === 0) return text;
  if (text[0] === ESC) {
    if (WELL_FORMED_CSI.test(text)) return text;
    const nl = text.search(/[\r\n]/);
    return nl === -1 ? "" : text.slice(nl + 1);
  }
  if (ESCAPE_FRAGMENT_START.test(text)) {
    const nl = text.search(/[\r\n]/);
    return nl === -1 ? "" : text.slice(nl + 1);
  }
  return text;
}
