/**
 * Activity-bar state machine for `useTerminal.ts`.
 *
 * Why this is not "any byte lights the bar":
 *   Review of 82d8e39 — `onData` did `setIsActive(true)` on every chunk
 *   and then `armIdleTimer`, which no-ops once the turn signal has been
 *   proven (`hasRealTurnSignal && turnSignalSeen`). A stray byte AFTER
 *   `turn_complete` (shell prompt redraw, spinner, CLI toast) therefore
 *   lit the bar and armed nothing, so it stayed on until the next
 *   `turn_complete` or process death. That is the photographed stuck-on
 *   symptom, reintroduced by the latch that correctly refused silence as
 *   proof of idleness.
 *
 * Why silence still cannot win mid-turn (measurement 2026-09-12):
 *   Stop hook `acbridge turn-complete` on card MASTER (53fcab93):
 *   279/279 deliveries, 0% hookErrors, dur_p50 111ms; 93.6% of assistant
 *   turns got Stop before the next prompt. Silence does not distinguish
 *   "agent idle" from "slow silent tool" (sleep, compile with no log).
 *   After the hook has proven itself on this PTY, only the signal (or
 *   exit/interrupt) may turn the bar off during an open turn.
 *
 * The two constraints together force a turn window, not a byte latch:
 *   - `signalProven` — this PTY has delivered a real end-of-turn at
 *     least once. Unlocks "trust the signal, never the silence timer".
 *   - `turnOpen` — a new turn has been opened by INPUT (keystroke via
 *     xterm `onKey`, paste, or a `send_to_card` body delivered from
 *     main) since the last end-of-turn. Output that arrives while the
 *     window is closed is chrome, not work, and must not relight.
 *     Echo, process output, deliverCard's retry Enter, and xterm's
 *     automatic replies (CPR / DSR on `onData` without `onKey`) are
 *     not INPUT.
 *
 * Cards that never prove the signal (the photographed board session
 * had only another tool's on-session-end, never the Stellar Stop hook)
 * stay on the unproven path: 180s silence fallback, same residual as
 * before — one long silent first turn may dim once. After proof, zero
 * fallback.
 *
 * `useTerminal.ts` is a React hook; `document.fonts` at module load
 * makes it unimportable from `tests/unit` (node). This file is the
 * choke point the permanent test can actually call.
 */

/** Providers without a real end-of-turn signal: debounce between chunks. */
export const ACTIVITY_IDLE_MS = 900;

/**
 * Bootstrap-only. Silence is not idleness — this timer only arms while
 * `signalProven` is false. 180s is slack over the sample's MCP max
 * 122.7s. After proof, `armIdleMs` is always null on a signal provider.
 */
export const ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS = 180_000;

export type TerminalActivityEvent =
  | "data"
  | "input"
  | "turn_complete"
  | "exit"
  | "interrupt"
  | "idle_timeout";

export type TerminalActivityState = {
  isActive: boolean;
  /** Latch for the life of this PTY — reset on respawn. */
  signalProven: boolean;
  /** Opened by input (onKey / paste / send_to_card body), closed by turn_complete / exit / interrupt. */
  turnOpen: boolean;
};

/**
 * Where an xterm outgoing chunk came from. The public API already
 * splits this — do not classify by payload bytes:
 *   - `onKey` fires only for a keystroke (has a DOM KeyboardEvent).
 *   - `input(data, wasUserInput)` documents the same split: automatic
 *     replies pass `false` (xterm's InputHandler default).
 *   - `onData` fires for keys, paste, AND those automatic replies
 *     (Cursor Position Report, Device Status Report, DA). Treating
 *     every `onData` as INPUT is the third incarnation of lighting
 *     the bar on any byte: the agent prints a query, xterm answers,
 *     the window reopens with no key, the next output byte sticks.
 *   - Paste is a separate DOM / `term.paste` path, not `onKey`.
 */
export type XtermOutgoingSource = "key" | "paste" | "auto";

export function xtermOutgoingOpensTurn(source: XtermOutgoingSource): boolean {
  return source === "key" || source === "paste";
}

export type TerminalActivityDecision = {
  next: TerminalActivityState;
  /** `null` = do not arm (and clear any pending timer). */
  armIdleMs: number | null;
};

export function initialTerminalActivity(): TerminalActivityState {
  return { isActive: false, signalProven: false, turnOpen: false };
}

function idleMsFor(state: TerminalActivityState, hasRealTurnSignal: boolean): number | null {
  if (hasRealTurnSignal && state.signalProven) return null;
  return hasRealTurnSignal ? ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS : ACTIVITY_IDLE_MS;
}

export function decideTerminalActivity(
  state: TerminalActivityState,
  event: TerminalActivityEvent,
  hasRealTurnSignal: boolean,
): TerminalActivityDecision {
  switch (event) {
    case "turn_complete":
      return {
        next: { isActive: false, signalProven: true, turnOpen: false },
        armIdleMs: null,
      };
    case "exit":
    case "interrupt":
      return {
        next: { ...state, isActive: false, turnOpen: false },
        armIdleMs: null,
      };
    case "idle_timeout":
      return { next: { ...state, isActive: false }, armIdleMs: null };
    case "input": {
      const next = { ...state, isActive: true, turnOpen: true };
      return { next, armIdleMs: idleMsFor(next, hasRealTurnSignal) };
    }
    case "data": {
      // Proven + between turns: prompt redraw / spinner / CLI toast.
      // Lighting here with no timer is the 82d8e39 stuck-on. Do not
      // arm a short timer either — that would be silence-as-idleness
      // on the NEXT real turn's first line + slow tool.
      if (hasRealTurnSignal && state.signalProven && !state.turnOpen) {
        return { next: { ...state, isActive: false }, armIdleMs: null };
      }
      const next = { ...state, isActive: true };
      return { next, armIdleMs: idleMsFor(next, hasRealTurnSignal) };
    }
  }
}
