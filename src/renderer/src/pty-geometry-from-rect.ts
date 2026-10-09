/**
 * Estimate PTY cols/rows from a card's persisted world rect so a terminal
 * that never enters the viewport still leaves the default 80×24.
 *
 * docs/PERF.md §17 cause 5: fit only runs after the xterm is attached to a
 * visible DOM container, so an off-screen card kept its spawn size forever
 * and every line the shell produced was already wrapped to 80 columns. The
 * ring then replays honestly at that wrong width. Sizing from the card rect
 * at spawn (before any fit) is the fix that does not depend on visibility.
 *
 * Calibration: board-model documents 860×660 → ~80×24 at the default font
 * (header 42px). Cell size is derived from that pair, not invented.
 */

const CARD_HEAD_HEIGHT = 42;
/** 860 / 80 — width of one JetBrains Mono cell at BASE_FONT_SIZE. */
const CELL_WIDTH_PX = 10.75;
/** (660 - 42) / 24 — height of one cell inside the terminal body. */
const CELL_HEIGHT_PX = 25.75;

const MIN_COLS = 2;
const MAX_COLS = 1000;
const MIN_ROWS = 1;
const MAX_ROWS = 1000;

export type PtyGeometry = { cols: number; rows: number };

export function estimatePtyGeometryFromRect(rect: { w: number; h: number }): PtyGeometry {
  const bodyH = Math.max(1, rect.h - CARD_HEAD_HEIGHT);
  const cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(rect.w / CELL_WIDTH_PX)));
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(bodyH / CELL_HEIGHT_PX)));
  return { cols, rows };
}
