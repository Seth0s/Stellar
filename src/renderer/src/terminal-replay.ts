/**
 * The geometry a reattached xterm must have BEFORE it replays the ring.
 *
 * The ring held in main is raw PTY output produced for the PTY's own size, and a
 * TUI's output is cursor-addressed (`ESC[<col>G`, `ESC[<row>;<col>H`). Replaying
 * it into a brand-new xterm at the 80x24 default clamps every address to column
 * 80 and wraps every wide line: the history comes back deformed. A card that is
 * off the viewport never opens nor fits its xterm, so for those the default
 * stays until the card is panned into view, and the deformation is permanent
 * (a later fit only reflows what was already clamped).
 *
 * The main process returns the PTY's geometry with the ring; this reads it
 * defensively (the IPC value is untyped at runtime) and falls back to the
 * default when it is absent or nonsensical — never to a guess.
 */

/** Bounds of a plausible terminal; anything outside is treated as absent. */
const MIN_COLS = 2;
const MAX_COLS = 1000;
const MIN_ROWS = 1;
const MAX_ROWS = 1000;

export type TerminalGeometry = { cols: number; rows: number };

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function replayGeometry(
  replay: { cols?: unknown; rows?: unknown } | null | undefined,
  fallback: TerminalGeometry,
): TerminalGeometry {
  if (!replay) return fallback;
  if (!inRange(replay.cols, MIN_COLS, MAX_COLS) || !inRange(replay.rows, MIN_ROWS, MAX_ROWS)) return fallback;
  return { cols: replay.cols, rows: replay.rows };
}
