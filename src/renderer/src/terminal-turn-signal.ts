/**
 * Who can CLOSE a turn (activity bar off) by a real signal, not silence.
 *
 * Start-of-turn vocabulary lives on `capacity.delivery.submitStartedPattern`
 * in `providers.ts` (main). That is a different question — "has the CLI
 * accepted the prompt?" — and is intentionally not reused here. Cursor
 * declares a start pattern (braille + Running/Reading/Grepping) and has
 * no end marker in this table: while it keeps printing, `isActive` stays
 * true, which is correct. After output stops, cursor falls through to
 * the 900ms silence timer like bash.
 *
 * Only `codex` has a confirmed on-screen end marker. `claude` uses the
 * Stop hook (`pty:turn-complete`), not a regex. cursor / antigravity /
 * opencode stay unproven until a marker is photographed.
 */

export const TURN_END_PATTERNS: Partial<Record<string, RegExp>> = {
  codex: /Worked for (?:\d+h\s*)?(?:\d+m\s*)?\d+s/,
};

/** Rolling window that keeps a split marker intact across `pty:data` chunks. */
export const TURN_END_BUFFER_MAX = 500;

export function providerHasRealTurnSignal(providerId: string): boolean {
  return providerId === "claude" || TURN_END_PATTERNS[providerId] !== undefined;
}
