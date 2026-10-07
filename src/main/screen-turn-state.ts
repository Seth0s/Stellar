import type { ScreenTurnDecl } from "./providers";

/**
 * Is the turn over, according to the SCREEN? Pure — it reads the ANSI-stripped
 * tail the app already keeps (`getCardRecentOutput`) and the provider's
 * declaration (`capacity.delivery.screenTurn`), and nothing else.
 *
 * Why the screen and not the byte clock: a TUI that repaints while parked at
 * its composer never goes quiet, so `lastActivityAt` never ages and the idle
 * watchdog never saw it. The turn state is on screen, in text: a spinner while
 * working, an end marker once finished.
 *
 * Positional on purpose. The tail is a stream of repaints, so both markers can
 * be in it at once (the previous turn's "Worked for" line is still there when
 * the next spinner draws). The LAST occurrence of each decides: an end marker
 * with no working marker after it is a finished turn; a working marker after
 * the end marker is a turn in progress. Neither pattern present is `unknown` —
 * a freshly booted card, or a marker that rolled out of the tail — and
 * `unknown` is never read as "ended": a nudge sent to a card that is still
 * working is worse than a nudge that does not come.
 */
export type ScreenTurnState = "ended" | "working" | "unknown";

/** Index where the LAST match of `pattern` starts, or -1. Clones the pattern
 *  with the `g` flag so the shared declaration's `lastIndex` is never touched. */
function lastMatchIndex(pattern: RegExp, text: string): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let found = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found = m.index;
    // Guard against an empty match (a pattern that matches a position).
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return found;
}

export function readScreenTurnState(screen: string | null | undefined, decl: ScreenTurnDecl | undefined): ScreenTurnState {
  if (!decl || typeof screen !== "string" || screen.length === 0) return "unknown";
  const workingAt = lastMatchIndex(decl.working, screen);
  const endedAt = lastMatchIndex(decl.ended, screen);
  if (endedAt === -1 && workingAt === -1) return "unknown";
  if (workingAt > endedAt) return "working";
  // The end marker is the last thing seen — also the case where only the end
  // marker exists (`workingAt === -1`).
  return "ended";
}

/** How much of the previous chunk is kept so a marker split across two flushes
 *  is still seen (the longest declared marker is a `Worked for 12h 59m 59s`). */
export const SCREEN_TURN_CARRY_MAX = 200;

/**
 * Folds one more output chunk into a LATCHED state. The 8KB tail rolls: a TUI
 * that repaints its composer forever pushes the `Worked for …` line out of it
 * in well under a minute, and a state read from the tail would decay to
 * `unknown` while the card is plainly parked. The latch keeps the last
 * recognised state until a marker FLIPS it — a chunk with no marker leaves it
 * alone. Pure; the PTY registry owns the per-card `state` and `carry`.
 *
 * Trade-off, stated: a latched `ended` stays ended until a working marker is
 * seen, so a provider whose working marker is not on screen during a turn
 * would be read as parked. That is why the markers are declared per provider
 * and measured, and why the watchdog also needs the state to hold for a floor.
 */
export function foldScreenTurn(
  prev: ScreenTurnState,
  carry: string,
  chunk: string,
  decl: ScreenTurnDecl,
): { state: ScreenTurnState; carry: string } {
  const combined = carry + chunk;
  const seen = readScreenTurnState(combined, decl);
  return { state: seen === "unknown" ? prev : seen, carry: combined.slice(-SCREEN_TURN_CARRY_MAX) };
}
