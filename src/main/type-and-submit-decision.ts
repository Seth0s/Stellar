/**
 * Pure decisions behind `typeAndSubmit` (message-bus.ts) — the mechanism
 * that types text into a terminal card and confirms Enter actually
 * submitted it, shared by `send_to_card`, `notifySpawnerOfReport`,
 * `notifySpawnerOfIdleCard`, and the "task moved by hand" notification.
 *
 * DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
 * caixa sem submeter" + "Cards recebem a mesma task duas vezes" +
 * cursor-agent follow-ups queue (owner 2026-09-11: 5× paste chip → exit 143).
 *
 * Screen text is a HISTORY window, not "what just happened". Matching
 * `Working` / `follow-ups` / `Thinking` by mere presence false-positives
 * on prose and chrome from the PREVIOUS turn (adversarial review): Enter
 * swallowed → check reads old words → `"sent"` → text stuck. Same class:
 * a leftover follow-ups box from an earlier turn must not mark a NEW
 * paste as submitted.
 *
 * Anchor: `screenTextBeforeWrite` (same line window, read BEFORE the
 * delivery write). Submit-started / follow-ups only count as `"sent"` when
 * their match COUNT increases vs that baseline — "appeared after my
 * write", not "was already on screen".
 *
 * Paste chip in the composer (no NEW follow-ups / NEW Working) → `"unsent"`
 * (retry Enter). Order: delta signals first, then chip/needle.
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

/** DESIGN-BACKLOG.md §0 "Push de report atropela o humano que está
 * digitando" / "O porteiro de entrega libera cedo demais" — quanto tempo
 * SEM tecla humana nova (não desde o início da linha) uma linha pendente
 * pode impedir uma entrega automática. Cada tecla humana renova o
 * relógio; o teto só corre quando o humano de fato para. Depois deste
 * idle a linha é tratada como abandonada: a entrega prossegue,
 * preservando o aviso na fila, mas o draft que ainda estiver no composer
 * não é apagado nem pode ser separado magicamente do texto entregue pelo
 * PTY. O chamador registra esse fallback explícito. */
export const HUMAN_INPUT_GATE_MAX_AGE_MS = 30_000;

/** Origin mark threaded through `pty-registry.write` — kept local so this
 * module stays free of a runtime import from the registry. `"human"` is
 * a real keystroke (or deferred human bytes flushed after a delivery);
 * `"delivery"` is programmatic `typeAndSubmit` text/Enter. */
export type DeliveryWriteOrigin = "human" | "delivery";

/** Only human keystrokes renew the abandoned-line clock. Programmatic
 * delivery must not — an agent writing continuously into a card would
 * otherwise hold every other queued notice behind that card forever. */
export function renewsHumanInputGateClock(origin: DeliveryWriteOrigin): boolean {
  return origin === "human";
}

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

export interface DeliveryGateInput {
  /** Há uma linha humana iniciada que ainda não atravessou Enter. */
  hasPendingHumanInput: boolean;
  /** Momento da ÚLTIMA tecla humana nesta linha pendente, ou `null`
   * quando não há relógio confiável. Contar do início da linha era o
   * bug: composição longa (>30s) expirava no meio da digitação. */
  pendingHumanInputLastAtMs: number | null;
  nowMs: number;
}

export type DeliveryGateDecision =
  | { action: "proceed"; reason: "empty" | "expired" | "unknown-age" }
  | { action: "wait"; reason: "human-input" };

/** Decide se uma entrega pode atravessar o PTY sem atropelar o composer
 * humano. A decisão é pura para que o limite e o fallback de relógio sejam
 * testados sem Electron, PTY ou timers reais. A idade é idle desde a
 * última tecla humana — não desde o começo da linha. */
export function decideDeliveryGate(input: DeliveryGateInput): DeliveryGateDecision {
  if (!input.hasPendingHumanInput) return { action: "proceed", reason: "empty" };

  // Um estado pendente sem timestamp não pode bloquear uma fila para sempre.
  // A implementação real sempre fornece o timestamp; este fallback também
  // mantém compatibilidade segura com callers antigos/test doubles.
  if (input.pendingHumanInputLastAtMs === null) return { action: "proceed", reason: "unknown-age" };

  const ageMs = Math.max(0, input.nowMs - input.pendingHumanInputLastAtMs);
  if (ageMs >= HUMAN_INPUT_GATE_MAX_AGE_MS) return { action: "proceed", reason: "expired" };
  return { action: "wait", reason: "human-input" };
}

export type SubmitCheckResult = "sent" | "unsent" | "unknown";

export interface SubmitCheckInput {
  /** The screen text read back after this attempt's Enter (already known
   * to be a successful read — `!check.ok` is handled by the caller before
   * this function is ever consulted). */
  screenText: string;
  /**
   * Same line-window snapshot taken BEFORE the delivery text was written.
   * Submit-started / follow-ups only fire when match counts rise vs this
   * baseline — so leftover prose/chrome from the previous turn cannot
   * mark a swallowed Enter as `"sent"`.
   */
  screenTextBeforeWrite: string;
  /**
   * Normalized needle to look for on screen. Caller passes the FULL
   * trimmed text when short (<8 chars — system notices like `ok`), else
   * a 24-char prefix. Short needles are matched only in the screen tail
   * so UI chrome can't false-positive them into `"sent"`.
   */
  sentNeedle: string;
  /** Has the card emitted any NEW pty output since BEFORE we wrote the
   * text? Boot-silence signal only — NOT used to distinguish echo from
   * a real response (see module doc). */
  hasNewActivitySinceWrite: boolean;
}

/**
 * Content signal that the CLI accepted the submit and started a turn.
 * Deliberately patterns of RESPONSE, not of echo. Shared across
 * cursor-agent, claude, codex, agy TUIs as observed live.
 */
export const SUBMIT_STARTED_PATTERN =
  /\b(Working|Thinking|Generating|Calculating|Swooping|Finagling|Cogitat(?:ed|ing)?|Moseying|Esc to interrupt)\b/i;

/** cursor-agent follow-ups box heading — CLI-specific. */
export const FOLLOW_UPS_HEADING_PATTERN = /\bfollow-ups\b/i;

/** Rows inside the follow-ups box (○ queued / → processing). */
export const FOLLOW_UP_ROW_PATTERN = /[○●→]\s*\[Pasted text[^\]]*\]/gi;

export function countPatternMatches(text: string, pattern: RegExp): number {
  const flags = pattern.global ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** True when `pattern` matches MORE times in `after` than in `before`. */
export function appearedSinceBaseline(before: string, after: string, pattern: RegExp): boolean {
  return countPatternMatches(after, pattern) > countPatternMatches(before, pattern);
}

export function looksLikeFollowUpsQueued(screenText: string): boolean {
  return FOLLOW_UPS_HEADING_PATTERN.test(screenText);
}

export function looksLikeSubmitStarted(screenText: string): boolean {
  return SUBMIT_STARTED_PATTERN.test(screenText);
}

/**
 * New follow-up activity since baseline: heading newly appeared, or more
 * paste-chip rows under the box (the owner symptom — each extra Enter
 * adds a row while the turn runs).
 */
export function followUpsAppearedSince(before: string, after: string): boolean {
  if (appearedSinceBaseline(before, after, FOLLOW_UPS_HEADING_PATTERN)) return true;
  return countPatternMatches(after, FOLLOW_UP_ROW_PATTERN) > countPatternMatches(before, FOLLOW_UP_ROW_PATTERN);
}

export function submitStartedAppearedSince(before: string, after: string): boolean {
  return appearedSinceBaseline(before, after, SUBMIT_STARTED_PATTERN);
}

/** Is `sentNeedle` still visible on screen? Long needles: anywhere.
 * Short needles (<8): only the last few lines (composer zone) — a short
 * notice must not be declared `"sent"` just because activity exists. */
export function needleVisibleOnScreen(screenText: string, sentNeedle: string): boolean {
  const needle = sentNeedle.trim().replace(/\s+/g, " ");
  if (!needle) return false;
  if (needle.length < 8) {
    const tail = screenText.split(/\r?\n/).slice(-6).join(" ").replace(/\s+/g, " ");
    return tail.includes(needle);
  }
  return screenText.replace(/\s+/g, " ").includes(needle);
}

/**
 * Decide whether the typed text has been submitted.
 *
 * Caller contract (`deliverCard`):
 *  - `"unsent"` → press Enter again
 *  - `"unknown"` → wait/re-read, do NOT press Enter
 *  - `"sent"` → stop
 */
export function decideSubmitCheck(input: SubmitCheckInput): SubmitCheckResult {
  const before = input.screenTextBeforeWrite;
  const after = input.screenText;

  // NEW since write only — leftover "Working"/"follow-ups" from the prior
  // turn must not count (review: false positive on prose / stale box).
  if (followUpsAppearedSince(before, after)) return "sent";
  if (submitStartedAppearedSince(before, after)) return "sent";

  // Collapsed paste chip still in the COMPOSER (no NEW queue/Working).
  if (/pasted text/i.test(after)) return "unsent";

  const visible = needleVisibleOnScreen(after, input.sentNeedle);

  if (visible) {
    // Still on screen and no NEW submit signal — stuck in composer. Retry.
    return "unsent";
  }

  if (!input.hasNewActivitySinceWrite) return "unknown";
  return "sent";
}

/** Whether this confirm-loop iteration should press Enter. First attempt
 * always does; later attempts only on `"unsent"`. `"unknown"` waits. */
export function shouldPressEnterOnAttempt(attemptIndex: number, previousResult: SubmitCheckResult | null): boolean {
  if (attemptIndex === 0) return true;
  return previousResult === "unsent";
}

/**
 * Bracketed Paste Mode envelope (CSI 200~ … CSI 201~). cursor-agent (and
 * other TUIs) collapse large bracketed pastes into a `[Pasted text #N +M
 * lines]` chip — required to reproduce the follow-ups bug and the right
 * way to deliver multi-line briefs without the TUI treating mid-text
 * newlines as submits.
 */
export function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** Multi-line or long bodies — short system notices stay raw keystrokes. */
export function shouldUseBracketedPaste(text: string): boolean {
  return text.includes("\n") || text.length >= 120;
}

/** Bytes actually written for the delivery body (Enter stays separate). */
export function deliveryTextBytes(text: string): string {
  return shouldUseBracketedPaste(text) ? wrapBracketedPaste(text) : text;
}

/**
 * Bytes to clear a leftover composer line when a delivery gives up
 * without `"sent"`. Ctrl+U (kill-to-start-of-line) twice — works on
 * readline-style composers and is a no-op on many TUIs that ignore it
 * when the composer is already empty. Not Ctrl+C: that can abort a live
 * agent turn. Pure so tests lock the sequence.
 *
 * Does NOT undo cursor-agent follow-ups already queued — once an entry
 * is in that box, clearing the composer cannot dequeue it. Caller only
 * invokes this on give-up (`previousResult !== "sent"`), so a live turn
 * that reached `"sent"` never receives Ctrl+U. Kept to stop abandoned
 * unsent text from concatenating into the next delivery (review achado 4).
 */
export function composerClearSequence(): string {
  return "\x15\x15";
}
