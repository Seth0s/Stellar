/* eslint-disable no-control-regex -- este arquivo interpreta sequencias de
 * escape de terminal (ESC, CSI, DECSET 2004h/l, RIS, DECSTR). O caractere de
 * controle DENTRO da expressao regular e o objeto do trabalho, nao um
 * descuido: e exatamente o byte que precisamos reconhecer no fluxo do PTY.
 * Desligado no arquivo inteiro, e nao linha a linha, porque toda a familia de
 * padroes aqui tem o mesmo motivo. */
/**
 * Pure decisions behind `typeAndSubmit` (message-bus.ts) — the mechanism
 * that types text into a terminal card and confirms Enter actually
 * submitted it, shared by `send_to_card`, `notifySpawnerOfReport`,
 * `notifySpawnerOfIdleCard`, and the "task moved by hand" notification.
 *
 * DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
 * caixa sem submeter" + "Cards recebem a mesma task duas vezes" +
 * cursor-agent follow-ups queue (owner 2026-09-11: 5× paste chip → exit 143)
 * + rodada 4 (`49ae26b7`): bracketed paste cego + âncora que escorrega.
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
 * a match's stabilized left neighborhood is new vs that baseline (or the
 * raw count rises). Digit runs in the prefix are collapsed so a ticking
 * timer (`[10s]` → `[11s]`) cannot rewrite an old hit as new. Count-only
 * arithmetic still fails when an 8-line window drops an old `Working` in
 * the same tick a new one with an identical non-digit prefix enters —
 * known limit, see `appearedSinceBaseline`.
 *
 * Paste chip in the composer (no NEW follow-ups / NEW Working) → `"unsent"`
 * (retry Enter). Order: delta signals first, then chip/needle.
 *
 * Bracketed Paste (CSI 200~/201~): only when the PTY peer requested
 * DECSET `2004h`. Blind wrapping poisons CLIs that never asked — they
 * echo the raw escapes as text. When unknown, send raw.
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

/**
 * Kind of byte `deliverCard` writes through the shared PTY write.
 * `"body"` is the one new turn. `"enter"` is the submit / retry.
 * `"composer_clear"` is give-up Ctrl+U — leftover text, not a turn.
 */
export type DeliveryWriteKind = "body" | "enter" | "composer_clear";

/**
 * Which programmatic writes open the activity-bar turn window.
 *
 * Why this is not `pty-registry.write` and not `typeAndSubmit`:
 *   `write()` is the sink for human keys, the delivery body, retry Enter,
 *   composer clear, interrupt, and deferred human flush. Even filtered
 *   to origin `"delivery"`, retry Enter and composer clear would fire.
 *   After `turn_complete`, that reopens the window; the next chrome
 *   byte (`data`) then keeps the bar on — the 1fcd36b stuck-on class.
 *   `typeAndSubmit` is only the FIFO: notifying on enqueue lights the
 *   bar during readiness/human-input gates; notifying after await is
 *   too late (the agent may already have finished).
 *
 * `deliverCard` is the only caller that knows the body from the retries.
 * The renderer still has one activity truth: this maps to the existing
 * `"input"` event in `terminal-activity-decision.ts`, same as a keystroke.
 * Echo and process output never go through here — they arrive as `data`.
 */
export function deliveryWriteOpensTurn(kind: DeliveryWriteKind): boolean {
  return kind === "body";
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
  /**
   * Padrão de vocabulário específico do provider que indica o início de um turno.
   * Se ausente (não aplicável ou não medido), a verificação afirmativa de início de turno
   * é pulada, e a decisão degrada para os testes de needle e atividade genérica.
   */
  submitStartedPattern?: RegExp;
}

export function countPatternMatches(text: string, pattern: RegExp): number {
  const flags = pattern.global ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** Chars of context BEFORE a match that identify WHICH occurrence it is.
 * Prefix-only on purpose: appending below an already-visible hit (paste
 * chip, prompt chrome, `> new`) must not rewrite that hit's identity and
 * false-positive `"sent"`. Scroll-swap still changes the left context
 * (`prose Working yesterday` → `  Working` under a new brief). */
export const MATCH_NEIGHBORHOOD_PREFIX = 24;

/** Local slice around a match used as a positional identity — the match
 * itself plus left context. No right context: a suffix would treat any
 * append below the hit as a "new" occurrence. */
export function matchNeighborhood(text: string, matchIndex: number, matchLength: number): string {
  const left = Math.max(0, matchIndex - MATCH_NEIGHBORHOOD_PREFIX);
  return text.slice(left, matchIndex + matchLength);
}

/**
 * Collapse self-updating chrome so neighborhood identity survives a
 * redraw that only retimes the same hit. cursor-agent prints elapsed
 * time beside Working (`[10s]` → `[11s]`); without this, the 24-char
 * prefix changes, `!before.includes(neighborhood)` fires, and an OLD
 * match is judged new → `"sent"` while Enter is still needed (review
 * rodada 4, achado A). Digits are the measured volatile; anything
 * non-numeric in the prefix still distinguishes scroll-swap.
 */
export function stabilizeNeighborhood(text: string): string {
  return text.replace(/\d+/g, "#");
}

/**
 * True when `after` shows a `pattern` hit that was not already on screen
 * in `before`. Prefers count increase (cheap, unambiguous). When the
 * count is flat — the sliding-window scroll case — falls back to
 * stabilized neighborhood identity: a match whose (digit-collapsed) left
 * context is absent from `before` is a NEW hit, not the old one that
 * scrolled away, and not the same hit with a ticking timer.
 *
 * KNOWN LIMIT (review rodada 4, achado C — do not invent a defense):
 * when a new turn's match has the same stabilized 24-char prefix as the
 * hit that just scrolled off, count stays flat and the prefix is still
 * "present" → we read a real submit as not-appeared → `"unsent"` → an
 * Extra Enter. Symmetric false negative; accepting it is cheaper than
 * guessing `"sent"`.
 */
export function appearedSinceBaseline(before: string, after: string, pattern: RegExp): boolean {
  if (countPatternMatches(after, pattern) > countPatternMatches(before, pattern)) return true;

  const beforeStable = stabilizeNeighborhood(before);
  const flags = pattern.global ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(after)) !== null) {
    const neighborhood = stabilizeNeighborhood(matchNeighborhood(after, m.index, m[0].length));
    if (!beforeStable.includes(neighborhood)) return true;
  }
  return false;
}

export function submitStartedAppearedSince(before: string, after: string, pattern: RegExp): boolean {
  return appearedSinceBaseline(before, after, pattern);
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

  // NEW since write only — leftover "Working" from the prior
  // turn must not count (review: false positive on prose / stale box).
  // Regra do Vazio: se o provider não definiu vocabulário (ou não medimos), pula essa verificação.
  if (input.submitStartedPattern && submitStartedAppearedSince(before, after, input.submitStartedPattern)) return "sent";

  // Collapsed paste chip still in the COMPOSER (no NEW queue/Working).
  // Fix: distinguishing history vs composer zone avoids returning "unsent"
  // when an old "[Pasted text]" chip is just sitting in the history while
  // the TUI legitimately accepted the input.
  //
  // Heurística Declarada: `message-bus.ts` invoca `readCardText(8)`, então
  // a tela (`after`) tem no máximo 8 linhas. Recortar as últimas 6
  // (`slice(-6)`) cria uma margem de 2 linhas: se o chip "[Pasted text]"
  // subiu o suficiente para sair das últimas 6 linhas visíveis, assumimos
  // que ele não está mais prendendo o cursor (foi pro histórico). É frouxo,
  // mas funciona na mecânica visual de TUI sem depender de âncoras frágeis.
  const tail = after.split(/\r?\n/).slice(-6).join("\n");
  if (/pasted text/i.test(tail)) return "unsent";

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
 * Bracketed Paste Mode envelope (CSI 200~ … CSI 201~). TUIs that requested
 * DECSET 2004 collapse large pastes into a `[Pasted text #N +M lines]`
 * chip — the right way to deliver multi-line briefs without mid-text
 * newlines being treated as submits. Never send this envelope unless the
 * peer asked (`bracketedPasteMode === true`).
 */
export function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** Multi-line or long bodies — short system notices stay raw keystrokes. */
export function shouldUseBracketedPaste(text: string): boolean {
  return text.includes("\n") || text.length >= 120;
}

/**
 * Bytes actually written for the delivery body (Enter stays separate).
 * `bracketedPasteMode` must reflect a real DECSET `2004h` from the PTY
 * stream. Default / unknown → raw (never invent the envelope).
 */
export function deliveryTextBytes(text: string, bracketedPasteMode = false): string {
  if (!bracketedPasteMode) return text;
  return shouldUseBracketedPaste(text) ? wrapBracketedPaste(text) : text;
}

/** Tracked DECSET 2004 state, updated from raw PTY output chunks. */
export interface BracketedPasteModeState {
  enabled: boolean;
  /** Incomplete CSI private-mode prefix split across chunks. */
  carry: string;
}

export function initialBracketedPasteModeState(): BracketedPasteModeState {
  return { enabled: false, carry: "" };
}

/** Incomplete ESC suffix that may continue in the next chunk — private
 * mode CSI (`\x1b[?…`), RIS (`\x1bc`), or DECSTR (`\x1b[!p`). */
export function incompletePrivateModeSuffix(text: string): string {
  const idx = text.lastIndexOf("\x1b");
  if (idx < 0) return "";
  const tail = text.slice(idx);
  // Complete sequences we care about — consume and look further.
  if (/^\x1bc/.test(tail)) return incompletePrivateModeSuffix(tail.slice(2));
  if (/^\x1b\[!p/.test(tail)) return incompletePrivateModeSuffix(tail.slice(4));
  if (/^\x1b\[\?[0-9;]+[hl]/.test(tail)) {
    const done = /^\x1b\[\?[0-9;]+[hl]/.exec(tail)!;
    return incompletePrivateModeSuffix(tail.slice(done[0].length));
  }
  // Partial: bare ESC, ESC [, ESC [?, ESC [! , ESC [?digits, ESC [!
  if (/^\x1b(?:\[(?:\?|[!]?)?[0-9;]*)?$/.test(tail)) return tail;
  return "";
}

/**
 * Fold one PTY output chunk into DECSET 2004 state. Handles combined
 * modes (`\x1b[?1000;2004h`), sequences split across chunks via `carry`,
 * and terminal resets that clear private modes: RIS (`\x1bc`) and
 * DECSTR (`\x1b[!p`). Without the resets, a soft/hard reset leaves
 * `enabled` stuck true and the next bracketed envelope is echoed as
 * garbage (review rodada 4, achado B). Events are applied in stream
 * order so `RIS` then `2004h` correctly re-enables. Pure — the registry
 * just stores the returned state.
 *
 * Resume/restart of a card spawns a NEW PTY process that re-announces
 * 2004h if it wants it — there is no inherited mode to preserve. Default
 * remains disabled (raw), the safe side.
 */
export function updateBracketedPasteMode(state: BracketedPasteModeState, chunk: string): BracketedPasteModeState {
  const text = state.carry + chunk;
  let enabled = state.enabled;

  type Ev = { index: number; kind: "reset" | "on" | "off" };
  const events: Ev[] = [];

  for (const m of text.matchAll(/\x1bc/g)) {
    events.push({ index: m.index!, kind: "reset" });
  }
  for (const m of text.matchAll(/\x1b\[!p/g)) {
    events.push({ index: m.index!, kind: "reset" });
  }
  const modeRe = /\x1b\[\?([0-9;]+)([hl])/g;
  let m: RegExpExecArray | null;
  while ((m = modeRe.exec(text)) !== null) {
    if (m[1]!.split(";").includes("2004")) {
      events.push({ index: m.index, kind: m[2] === "h" ? "on" : "off" });
    }
  }

  events.sort((a, b) => a.index - b.index);
  for (const ev of events) {
    if (ev.kind === "on") enabled = true;
    else enabled = false; // reset or 2004l
  }

  return { enabled, carry: incompletePrivateModeSuffix(text) };
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
