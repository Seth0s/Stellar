/**
 * Pure decisions behind `typeAndSubmit` (message-bus.ts) — the mechanism
 * that types text into a terminal card and confirms Enter actually
 * submitted it, shared by `send_to_card`, `notifySpawnerOfReport`,
 * `notifySpawnerOfIdleCard`, and the "task moved by hand" notification.
 *
 * DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
 * caixa sem submeter" (relatado ao vivo 2x, 2026-09-11, com `codex`) —
 * *"ao spawn do codex e dando sua task, ... foi preciso eu fazer o
 * 'enter'"*. Not a retry-count problem: the confirm loop already tries
 * Enter up to `SEND_ENTER_MAX_ATTEMPTS` times. Two compounding root causes:
 *
 * 1. No readiness gate before typing at all — `writeToCard` used to fire
 *    the instant the PTY existed, with no wait for the CLI to finish
 *    drawing its TUI. `codex` takes noticeably longer than the ~1.3s the
 *    whole retry window covers, so every attempt could land before there
 *    was even a composer to submit into. `decideWriteReadiness` below
 *    closes this — but see achado 2, which is why closing achado 1 alone
 *    isn't enough.
 *
 * 2. The confirm check couldn't tell "genuinely submitted" from "screen
 *    hasn't rendered anything yet". The old check was a boolean
 *    (`looksUnsent`): true if the typed prefix was still visible on
 *    screen, false otherwise — and "false" was read as "sent". During a
 *    slow boot, the prefix is ABSENT from the screen not because it was
 *    submitted but because nothing has been drawn yet at all — absence of
 *    evidence treated as evidence of success, breaking the retry loop on
 *    attempt 1 in exactly the case that needed the other 3 attempts most.
 *    `decideSubmitCheck` below adds the third state this needs: "unknown"
 *    (keep retrying) — reached only when there's been no NEW pty output at
 *    all since we started, so a missing prefix can't yet be trusted as
 *    real progress. Once the terminal has shown ANY sign of life since we
 *    began (`hasNewActivitySinceWrite`), a missing prefix means the same
 *    thing it always did: genuinely sent.
 *
 * Why the fix needs BOTH: readiness gating alone still lets a card that
 * becomes quiet-but-not-actually-interactive (rare, but possible) fool the
 * confirm loop the old way; the tri-state check alone still means typing
 * lands too early against a slow boot and the composer may drop or garble
 * keystrokes typed before it existed. Together: don't type until there's
 * real reason to believe a UI exists, and don't declare victory until
 * there's real reason to believe something happened.
 *
 * Cost in the common case (a card that's been alive and quiet for a long
 * time — true for `notifySpawnerOfReport`/idle/task-moved's usual target,
 * and for `send_to_card` between two already-running agents): both
 * decisions resolve on their very first synchronous check, no waiting.
 * `decideWriteReadiness` needs only `hasReceivedData` (true forever after
 * the first byte) and a quiescence window measured against the LAST
 * activity, which for a long-idle card is already far past
 * `WRITE_READY_QUIET_MS`. `decideSubmitCheck` only ever gates on
 * `hasNewActivitySinceWrite`, which a live, responsive terminal satisfies
 * immediately (it echoes/reacts to the write) — the new third state never
 * fires for a healthy target, only for one that's gone truly silent since
 * we started typing.
 */

/** Quiescence window after the card's last pty output before typing is
 * considered safe — short on purpose: this isn't discovering a session
 * file (session-watch.ts's `TIMEOUT_MS`, tens of seconds), it's waiting
 * for one more animation frame of TUI redraw to settle. */
export const WRITE_READY_QUIET_MS = 150;

/** Safety cap, measured from the card's spawn, on how long the readiness
 * gate will wait for quiescence before giving up and proceeding anyway.
 * Not the fix itself (that's waiting for a real signal, not a bigger
 * sleep) — a backstop for a card that never goes quiet (e.g. a `bash`
 * target continuously streaming logs), so this gate can't hang a push
 * notification forever. Comfortably above every provider's observed boot
 * time (`codex`'s was the slowest, still well under this). */
export const WRITE_READY_MAX_WAIT_MS = 8_000;

export interface WriteReadinessInput {
  /** Has the card's process emitted at least one chunk of output since it
   * was spawned? `false` for the entire window before the TUI has drawn
   * anything at all. */
  hasReceivedData: boolean;
  /** `now - lastActivityAt` — how long since the LAST pty output, however
   * many chunks there have been. */
  msSinceLastActivity: number;
  /** `now - spawnedAt` — anchors the safety cap in achado 1's own doc
   * comment above. For a card that's been alive a long time, this alone
   * already exceeds `WRITE_READY_MAX_WAIT_MS`, which is exactly why the
   * common case (an old, established card) resolves to `proceed`
   * immediately regardless of which branch fires first. */
  msSinceSpawn: number;
}

export type WriteReadinessDecision =
  | { action: "proceed"; reason: "quiet" | "timeout" }
  | { action: "wait" };

/** Achado 1's decision: is it safe to type into this card yet? */
export function decideWriteReadiness(input: WriteReadinessInput): WriteReadinessDecision {
  if (input.hasReceivedData && input.msSinceLastActivity >= WRITE_READY_QUIET_MS) {
    return { action: "proceed", reason: "quiet" };
  }
  if (input.msSinceSpawn >= WRITE_READY_MAX_WAIT_MS) {
    return { action: "proceed", reason: "timeout" };
  }
  return { action: "wait" };
}

export type SubmitCheckResult = "sent" | "unsent" | "unknown";

export interface SubmitCheckInput {
  /** The screen text read back after this attempt's Enter (already known
   * to be a successful read — `!check.ok` is handled by the caller before
   * this function is ever consulted, unchanged from before this fix: a
   * read failure isn't evidence either way, see this module's top comment
   * and message-bus.ts's own "NÃO REGREDIR" note on that branch). */
  screenText: string;
  /** Normalized prefix of the text that was typed (message-bus.ts already
   * computes this once per `typeAndSubmit` call). */
  sentPrefix: string;
  /** Has the card emitted any NEW pty output since `typeAndSubmit` wrote
   * the text (before this specific attempt's Enter)? The one signal that
   * makes a missing prefix trustworthy — see achado 2 in this module's top
   * comment. */
  hasNewActivitySinceWrite: boolean;
}

function looksUnsentText(screenText: string, sentPrefix: string): boolean {
  if (/pasted text/i.test(screenText)) return true;
  if (sentPrefix.length < 8) return false; // curto demais pra significar algo, evita falso positivo
  return screenText.replace(/\s+/g, " ").includes(sentPrefix);
}

/** Achado 2's decision: given one confirm-loop read, did the text get
 * submitted, is it still visibly sitting unsent, or do we simply not know
 * yet? Only "sent" should ever stop the retry loop — "unsent" AND
 * "unknown" both mean "try the Enter again". */
export function decideSubmitCheck(input: SubmitCheckInput): SubmitCheckResult {
  if (looksUnsentText(input.screenText, input.sentPrefix)) return "unsent";
  if (!input.hasNewActivitySinceWrite) return "unknown";
  return "sent";
}
