import type { Terminal } from "@xterm/xterm";

// DESIGN-BACKLOG.md item 58, M1 — the only way to check on a spawned
// agent used to be `snapshot` (a screenshot, OCR-only, no text). Each
// terminal's live xterm.js instance lives inside its own `useTerminal`
// hook call with no shared registry, so `read_card` (main/index.ts) has
// nothing to ask the renderer to look up. This is that registry, keyed
// by the stable card id (not the ephemeral ptyId) — the same id every
// other MCP tool already addresses a card by.
const terminals = new Map<string, Terminal>();

export function registerTerminal(cardId: string, term: Terminal) {
  terminals.set(cardId, term);
}

export function unregisterTerminal(cardId: string) {
  terminals.delete(cardId);
}

/** Test-only (SCREEN_SPACE_PROJECTION_PLAN.md, Trilha A's verify
 * harness — `smoke-terminal-font-zoom.mjs`) — the real `fontSize`
 * `useTerminal.ts` set on this terminal via `fontSizeForZoom`. Reading it
 * directly here is far more reliable than the canvas-introspection
 * heuristics the earlier version of that test used (xterm's internal
 * measurement canvas is recreated on demand and isn't stably present
 * right after a `fontSize` mutation — confirmed live building this).
 * Attached to `window` below, unconditionally — a CDP `Runtime.evaluate`
 * call already runs inside this same renderer JS context, so no preload/
 * IPC round-trip is needed the way `clipboardImage.testWriteImage`/
 * `debugBridge` need one (those touch MAIN-process state, gated there via
 * `app.isPackaged`; this is a pure read with no side effect, same
 * negligible-risk profile as the rest of this file's exports already on
 * `window` indirectly through React state — nothing sensitive exposed). */
export function getTerminalFontSize(cardId: string): number | null {
  return terminals.get(cardId)?.options.fontSize ?? null;
}

(window as unknown as { __getTerminalFontSize: typeof getTerminalFontSize }).__getTerminalFontSize =
  getTerminalFontSize;

/** Test-only (mesmo raciocínio acima) — o `theme.background` real que o
 * toggle de transparência (TerminalCard.tsx, 2026-09-02) aplicou de fato
 * no xterm.js, não uma suposição sobre o que o botão "deveria" ter
 * feito. */
export function getTerminalBackground(cardId: string): string | null {
  return (terminals.get(cardId)?.options.theme?.background as string | undefined) ?? null;
}

(window as unknown as { __getTerminalBackground: typeof getTerminalBackground }).__getTerminalBackground =
  getTerminalBackground;

/** Test-only (resize-fluidity verify harness) — same pure-read, no-side-
 * effect profile as `getTerminalFontSize` above. Lets a live CDP test
 * prove cols/rows stay UNCHANGED during a resize drag (only the CSS
 * optical transform moves) and DO change for real once `fitNow()` runs
 * on release. */
export function getTerminalDims(cardId: string): { cols: number; rows: number } | null {
  const term = terminals.get(cardId);
  return term ? { cols: term.cols, rows: term.rows } : null;
}

(window as unknown as { __getTerminalDims: typeof getTerminalDims }).__getTerminalDims = getTerminalDims;

/**
 * Full scrollback (or just the last `lines`, if given) as plain text —
 * xterm.js keeps every row, printable or not, in `buffer.active`; blank
 * trailing rows are trimmed the same way a human copy-pasting the
 * terminal would expect.
 */
export function getTerminalText(cardId: string, lines?: number): string | null {
  const term = terminals.get(cardId);
  if (!term) return null;
  const buf = term.buffer.active;
  const total = buf.length;
  const start = lines && lines > 0 ? Math.max(0, total - lines) : 0;
  const out: string[] = [];
  for (let i = start; i < total; i++) {
    out.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Test-only hook (harmless, always on — same spirit as `App.tsx`'s
 * `window.__cardRenderCounts`, pre-release audit P1): selects the first
 * occurrence of `needle` in the visible scrollback via xterm.js's own
 * `term.select(col, row, length)`, the same primitive its own mouse-drag
 * selection uses internally. Exists so a CDP smoke test can exercise a
 * REAL selection (and the Ctrl+Shift+C copy handler in useTerminal.ts
 * that reads it) without needing pixel-perfect drag coordinates over a
 * canvas-rendered terminal. Returns whether a match was found.
 */
export function selectTextForTest(cardId: string, needle: string): boolean {
  const term = terminals.get(cardId);
  if (!term) return false;
  const buf = term.buffer.active;
  for (let row = 0; row < buf.length; row++) {
    const line = buf.getLine(row)?.translateToString(true) ?? "";
    const col = line.indexOf(needle);
    if (col !== -1) {
      term.select(col, row, needle.length);
      return true;
    }
  }
  return false;
}

(window as unknown as { __selectTerminalTextForTest?: typeof selectTextForTest }).__selectTerminalTextForTest =
  selectTextForTest;
