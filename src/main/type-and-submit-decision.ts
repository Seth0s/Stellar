/* eslint-disable no-control-regex -- este arquivo interpreta sequencias de
 * escape de terminal (ESC, CSI, DECSET 2004h/l, RIS, DECSTR). O caractere de
 * controle DENTRO da expressao regular e o objeto do trabalho, nao um
 * descuido: e exatamente o byte que precisamos reconhecer no fluxo do PTY.
 * Desligado no arquivo inteiro, e nao linha a linha, porque toda a familia de
 * padroes aqui tem o mesmo motivo. */
/**
 * Pure decisions behind `typeAndSubmit` (message-bus.ts) — the mechanism
 * that types text into a terminal card and confirms Enter actually
 * submitted it, shared by `send_to_card` and the "task moved by hand"
 * notification. Report / idle / exit-without-report do not type.
 *
 * DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
 * caixa sem submeter" + "Cards recebem a mesma task duas vezes" +
 * cursor-agent follow-ups queue (owner 2026-09-11: 5× paste chip → exit 143;
 * owner 2026-09-14: mid-turn send parks in `follow-ups` / `enter steer`,
 * and `delivered` was wrongly reported — enqueued ≠ agent saw it)
 * + rodada 4 (`49ae26b7`): bracketed paste cego + âncora que escorrega.
 *
 * Screen text is a HISTORY window, not "what just happened". Matching
 * `Working` / `Thinking` by mere presence false-positives on prose and
 * chrome from the PREVIOUS turn (adversarial review): Enter swallowed →
 * check reads old words → `"sent"` → text stuck. Same class: a leftover
 * follow-ups box from an earlier turn must not mark a NEW paste as
 * submitted — and a NEW follow-ups box is `"parked"`, not `"sent"`
 * (the box appearing also shifts the Running neighborhood and used to
 * false-positive submit-started).
 *
 * Anchor: `screenTextBeforeWrite` (same line window, read BEFORE the
 * delivery write). Submit-started only counts as `"sent"` when a match's
 * stabilized left neighborhood is new vs that baseline (or the raw count
 * rises). Digit runs in the prefix are collapsed so a ticking timer
 * (`[10s]` → `[11s]`) cannot rewrite an old hit as new. Count-only
 * arithmetic still fails when an 8-line window drops an old `Working` in
 * the same tick a new one with an identical non-digit prefix enters —
 * known limit, see `appearedSinceBaseline`.
 *
 * Mid-turn queue (provider `capacity.delivery.midTurnQueue`): NEW park
 * chrome → `"parked"` (agent has not seen the text). Paste chip in the
 * composer (no park / no NEW Working) → `"unsent"` (retry Enter). Order:
 * park first, then submit-started, then chip/needle.
 *
 * Bracketed Paste (CSI 200~/201~): only when the PTY peer requested
 * DECSET `2004h`. Blind wrapping poisons CLIs that never asked — they
 * echo the raw escapes as text. When unknown, send raw.
 *
 * Enxutação (2026-09-13, §0 "endurecer a confirmação depois de encolher
 * os chamadores"): the loop's verdict is now RETURNED, not dropped —
 * `DeliveryConfirmation` → `decideDeliveryOutcome` → `get_delivery`
 * says `delivered` / `failed` / `unconfirmed` instead of a blanket
 * `delivered`. And `bash` targets get their own rule
 * (`decideShellSubmitCheck`): readline echoes and keeps the command on
 * screen, so the composer rule read every shell submit as `"unsent"`.
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
 * module stays free of a runtime import from the registry.
 *   - `"human"`: real keystroke / paste (or deferred human bytes flushed
 *     after a delivery). Renews the abandoned-line clock.
 *   - `"delivery"`: programmatic `typeAndSubmit` text/Enter. Does not.
 *   - `"auto"`: xterm automatic replies on `onData` with no matching
 *     keystroke/paste (mouse SGR, focus, CPR/DSR/DA). Does not — those
 *     bytes have no newline, so classifying them as human permanently
 *     jammed the gate on active TUIs (MASTER 330, measured 2026-09-14). */
export type DeliveryWriteOrigin = "human" | "delivery" | "auto";

/** Only human keystrokes renew the abandoned-line clock. Programmatic
 * delivery and xterm auto-replies must not — an agent writing continuously
 * into a card, or a TUI polling the emulator, would otherwise hold every
 * other queued notice behind that card forever. */
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

/**
 * Shared receipt for any programmatic PTY delivery that must not sit
 * inside an RPC. The tool's job is to enqueue; typing is how the FIFO
 * item happens. `queued` is the honest send/spawn-brief return.
 * Same shape as `report` → `seq` + `read_report`: accept now, query later.
 *
 * Settled states carry the confirmation loop's VERDICT, not just "the
 * FIFO item finished" (DESIGN-BACKLOG.md §0, enxutação: "`deliverCard` é
 * o único motor que confirma por leitura de tela... o conserto é a
 * confirmação, não o canal"). Before this, `get_delivery` said
 * `delivered` even when the loop gave up after every Enter, cleared the
 * composer and the text never reached the agent — the one caller that
 * could resend was told everything was fine.
 *  - `delivered`   → `"sent"` confirmed on screen (agent turn has the text).
 *  - `parked`      → `"parked"`: provider mid-turn queue accepted the text
 *                    (cursor `follow-ups`); the agent has NOT seen it yet.
 *                    Distinct from FIFO `queued` (Stellar has not finished
 *                    typing). Resend with `steer:true`, or wait for the
 *                    turn to end.
 *  - `failed`      → text was still visibly in the composer after the
 *                    last Enter; composer cleared; the text did NOT go
 *                    through. Resend (or read_card) is the caller's call.
 *  - `unconfirmed` → no evidence either way (no echo, screen read
 *                    failed, card vanished mid-delivery, or an
 *                    unexpected error). Don't assume; `read_card`.
 *  - `cancelled`   → author died (or explicit cancel) before this FIFO item
 *                    entered `deliverCard`. Not a confirm-loop verdict —
 *                    see delivery-lifecycle-decision.ts. Distinct from
 *                    `failed` (typed, not confirmed) and from `parked`
 *                    (provider queue holds it).
 */
export type CardDeliveryState =
  | "queued"
  | "delivered"
  | "parked"
  | "unconfirmed"
  | "failed"
  | "cancelled";
export type CardDeliveryHoldReason = "human-input" | "card-busy";
export type CardDeliveryReceipt = {
  ok: true;
  delivery: CardDeliveryState;
  reason?: CardDeliveryHoldReason;
  id: string;
};

/** Last thing the confirmation loop learned. `SubmitCheckResult` is the
 * screen verdict; the rest are the ways the loop ends without one. */
export type DeliveryCheckOutcome = SubmitCheckResult | "read-failed" | "card-gone" | "error";

/** What `deliverCard` hands back and `get_delivery` exposes verbatim.
 * `enters` is how many `\r` the loop actually wrote — the number the
 * duplicate-delivery investigations kept asking for and never had. */
export type DeliveryConfirmation = {
  result: DeliveryCheckOutcome;
  attempts: number;
  enters: number;
  composerCleared: boolean;
  /** True when a mid-turn steer key was pressed after a park. */
  steered?: boolean;
};

/** Map the loop's last finding onto the settled delivery state. Pure so
 * the split is locked by tests, not by reading `deliverCard`. */
export function decideDeliveryOutcome(
  result: DeliveryCheckOutcome,
): Exclude<CardDeliveryState, "queued" | "cancelled"> {
  if (result === "sent") return "delivered";
  if (result === "parked") return "parked";
  if (result === "unsent") return "failed";
  return "unconfirmed";
}

/** Which side of the PTY is reading the delivery. `"agent"` is a TUI
 * composer (claude/codex/cursor/...), `"shell"` is readline in a `bash`
 * card. Mirrors `ProviderCapacity.role` — passed in, not imported, so
 * this module stays free of providers.ts. */
export type DeliveryTargetRole = "agent" | "shell";

/**
 * Normalized needle the confirm loop looks for on screen. Short texts
 * (<8 — system notices like `ok`) are matched whole, in the tail only.
 *
 * Agent TUI: a 24-char PREFIX — the composer shows the start of the
 * text (or collapses it into a paste chip), and a submit moves it into
 * history where the prefix is what survives.
 *
 * Shell: a 24-char SUFFIX. readline echoes the whole command and the
 * cursor sits right after its LAST character; a long command wraps onto
 * several rows, so the prefix row can have "rows below it" while the
 * command is still unsubmitted. The suffix is on the cursor's row.
 */
export function deliveryNeedle(text: string, role: DeliveryTargetRole = "agent"): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length < 8) return normalized;
  return role === "shell" ? normalized.slice(-24) : normalized.slice(0, 24);
}

/**
 * Peek — never wait — why a delivery would sit at human/TUI rhythm.
 * Human-input wins over card-busy: it is the 30s gate that timed out MCP.
 * `queueAhead` is another FIFO item already in flight for this card.
 */
export function inspectDeliveryHold(input: {
  writeReadiness: WriteReadinessDecision;
  deliveryGate: DeliveryGateDecision;
  queueAhead: boolean;
}): CardDeliveryHoldReason | undefined {
  if (input.deliveryGate.action === "wait") return "human-input";
  if (input.writeReadiness.action === "wait" || input.queueAhead) return "card-busy";
  return undefined;
}

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

export type SubmitCheckResult = "sent" | "unsent" | "unknown" | "parked";

export interface SubmitCheckInput {
  /** The screen text read back after this attempt's Enter (already known
   * to be a successful read — `!check.ok` is handled by the caller before
   * this function is ever consulted). */
  screenText: string;
  /**
   * Same line-window snapshot taken BEFORE the delivery text was written.
   * Submit-started / mid-turn park only fire when match counts rise vs this
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
  /**
   * Provider mid-turn queue chrome (`capacity.delivery.midTurnQueue.parkedPattern`).
   * NEW since baseline → `"parked"` (not `"sent"`). Checked BEFORE
   * submit-started: the park box shifts Running's neighborhood and used
   * to false-positive delivery.
   */
  midTurnParkedPattern?: RegExp;
  /**
   * `"shell"` switches to the readline rule (`decideShellSubmitCheck`).
   * Omitted / `"agent"` keeps the TUI-composer rule below. The caller
   * derives this from `providerCapacity(provider).role`; a `sentNeedle`
   * built with the matching `deliveryNeedle(text, role)` is expected.
   */
  targetRole?: DeliveryTargetRole;
  /**
   * Shell only. Out-of-screen submit signal from the PTY stream: did the
   * peer emit `2004l` between the body write and this read? `true` →
   * readline accepted the line (bash/zsh/fish emit it on Enter, before
   * the command runs). `false` → the prompt WAS in bracketed-paste mode
   * and no accept happened yet. `null`/absent → no such signal (old
   * shell without bracketed paste, or an opaque foreground program
   * owns stdin) — screen evidence is all there is.
   */
  readlineAccepted?: boolean | null;
}

/**
 * Derive `readlineAccepted` from two `BracketedPasteModeState` snapshots
 * — the one taken right before the body write and the one at check time.
 * Only meaningful when the prompt was in `2004h` before we typed: that is
 * what makes a later `2004l` mean "line accepted" rather than noise.
 */
export function readlineAcceptedSince(
  before: { enabled: boolean; offEvents: number } | null | undefined,
  after: { offEvents: number } | null | undefined,
): boolean | null {
  if (!before || !after || !before.enabled) return null;
  return after.offEvents > before.offEvents;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Row index (in `rows`) holding the END of the LAST needle occurrence,
 * or -1. Rows are whitespace-collapsed individually and the needle's
 * spaces may fall on a row break (a multi-line paste echoes as several
 * rows). Short needles (<8, same cut-off as `needleVisibleOnScreen`)
 * must not be glued to path/word characters — `ls` inside `~/tools$` is
 * the prompt, not the echo. Long needles are plain substrings: a shell
 * suffix needle is routinely cut mid-token, so a left boundary would
 * miss the real echo.
 */
export function lastNeedleRow(rows: readonly string[], needle: string): number {
  const norm = rows.map((r) => r.replace(/\s+/g, " ").trim()).join("\n");
  const trimmed = needle.trim();
  const body = trimmed
    .split(" ")
    .filter((part) => part.length > 0)
    .map(escapeRegExp)
    .join("[ \\n]");
  if (!body) return -1;
  const bounded = trimmed.length < 8;
  const re = new RegExp(bounded ? `(?<![\\w/.\\-])${body}(?![\\w/.\\-])` : body, "g");
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    lastEnd = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (lastEnd < 0) return -1;
  return norm.slice(0, lastEnd).split("\n").length - 1;
}

/**
 * readline rule for `bash` targets — the TUI rule always read these as
 * `"unsent"`: a shell ECHOES the command and leaves it on screen after
 * executing it, so "needle still visible" is true for every submitted
 * command whose output didn't scroll it away. Result before this: four
 * Enters and a Ctrl+U on every `send_to_card` into a bash card (blank
 * lines, harmless — but it also made the honest outcome read `failed`).
 *
 * Strongest signal first — `readlineAccepted` (DECSET 2004 delta on the
 * PTY stream, see `readlineAcceptedSince`): `true` is `"sent"` no matter
 * what the screen shows. This is what covers a SILENT command — `sleep`,
 * `cat > file`, a program waiting on stdin — whose echo is the last row
 * with nothing below it. Measured live (smoke-mcp-delivery-outcome):
 * the screen rule alone read `python3 sink.py` as unsent → 4 Enters →
 * `failed`, for a command that had already been running for a second.
 *
 * Then the screen, for what the shell does that a composer doesn't: on
 * submit it prints SOMETHING below the echoed line — output, or at
 * minimum the next prompt. Needle's row followed by a non-empty row →
 * `"sent"`. Needle gone → output scrolled it out of the window:
 * `"sent"` if the card produced anything since the write, else
 * `"unknown"` (nothing echoed yet — don't press Enter into that).
 *
 * Needle on the last row with nothing below: `"unsent"` only when the
 * prompt was in bracketed-paste mode and never accepted the line
 * (`readlineAccepted === false`) — that is readline holding our text.
 * With no readline signal (`null`) it is an opaque foreground program
 * echoing our bytes: we cannot know what it did with Enter, and feeding
 * it three more is the duplicate-delivery class. `"unknown"`.
 */
export function decideShellSubmitCheck(
  input: Pick<SubmitCheckInput, "screenText" | "sentNeedle" | "hasNewActivitySinceWrite" | "readlineAccepted">,
): SubmitCheckResult {
  if (input.readlineAccepted === true) return "sent";
  const rows = input.screenText.split(/\r?\n/);
  const row = lastNeedleRow(rows, input.sentNeedle);
  if (row < 0) return input.hasNewActivitySinceWrite ? "sent" : "unknown";
  const printedBelow = rows.slice(row + 1).some((r) => r.trim().length > 0);
  if (printedBelow) return "sent";
  return input.readlineAccepted === false ? "unsent" : "unknown";
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

/**
 * True when `after` shows our delivery accepted into the provider's
 * mid-turn park UI. Pattern from `capacity.delivery.midTurnQueue.parkedPattern`.
 *
 * Three honest signals (any one):
 *  1. Park chrome itself is NEW vs baseline (first entry opens the box).
 *  2. Our needle newly appears on a screen that already has park chrome
 *     (second follow-up into an open box — chrome count stays flat).
 *  3. A paste chip newly appears alongside park chrome (multi-line brief
 *     collapsed; needle text is no longer raw on screen).
 */
export function midTurnQueueParkedSince(
  before: string,
  after: string,
  parkedPattern: RegExp,
  sentNeedle?: string,
): boolean {
  if (!parkedPattern.test(after)) return false;
  if (appearedSinceBaseline(before, after, parkedPattern)) return true;
  const needle = sentNeedle?.trim() ?? "";
  if (needle.length > 0) {
    const needleNew = needleVisibleOnScreen(after, needle) && !needleVisibleOnScreen(before, needle);
    if (needleNew) return true;
  }
  const chipNew = /pasted text/i.test(after) && !/pasted text/i.test(before);
  return chipNew;
}

/**
 * After one steer key: did the park release our text into the live turn?
 * Do NOT reuse `decideSubmitCheck` here — a steered message often remains
 * visible as history, which that function would read as `"unsent"`.
 */
export function decideSteerCheck(input: {
  screenTextAfterSteer: string;
  parkedPattern: RegExp;
  sentNeedle: string;
}): SubmitCheckResult {
  const after = input.screenTextAfterSteer;
  if (!input.parkedPattern.test(after)) return "sent";
  // Box still open with our payload → steer did not take.
  if (needleVisibleOnScreen(after, input.sentNeedle)) return "parked";
  if (/pasted text/i.test(after)) return "parked";
  // Box chrome leftover but our entry gone → treated as injected.
  return "sent";
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
 *  - `"unsent"` → press Enter again (composer retry — NOT steer)
 *  - `"parked"` → mid-turn queue; do NOT retry Enter in this loop.
 *                 Caller may press the provider's steer key once.
 *  - `"unknown"` → wait/re-read, do NOT press Enter
 *  - `"sent"` → stop (agent has the text)
 */
export function decideSubmitCheck(input: SubmitCheckInput): SubmitCheckResult {
  // A shell has no composer, no paste chip and no turn vocabulary — the
  // TUI heuristics below are wrong for it, not merely weak. Own rule.
  if (input.targetRole === "shell") return decideShellSubmitCheck(input);

  const before = input.screenTextBeforeWrite;
  const after = input.screenText;

  // PARK BEFORE submit-started. Live 2026-09-14: follow-ups box appearing
  // shifts the existing Running spinner's left neighborhood →
  // `submitStartedAppearedSince` falsely returned `"sent"` while the
  // text sat unread in the queue. Enqueued ≠ delivered.
  if (
    input.midTurnParkedPattern &&
    midTurnQueueParkedSince(before, after, input.midTurnParkedPattern, input.sentNeedle)
  ) {
    return "parked";
  }

  // NEW since write only — leftover "Working" from the prior
  // turn must not count (review: false positive on prose / stale box).
  // Regra do Vazio: se o provider não definiu vocabulário (ou não medimos), pula essa verificação.
  if (input.submitStartedPattern && submitStartedAppearedSince(before, after, input.submitStartedPattern)) return "sent";

  // Collapsed paste chip still in the COMPOSER (no NEW park/Working).
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
 * always does; later attempts only on `"unsent"`. `"parked"` / `"unknown"`
 * wait — steer is a separate single key outside this retry loop. */
export function shouldPressEnterOnAttempt(attemptIndex: number, previousResult: SubmitCheckResult | null): boolean {
  if (attemptIndex === 0) return true;
  return previousResult === "unsent";
}

/**
 * After a park, should the caller press the provider's steer key?
 * Only when the sender asked (`steer`) AND the provider declared one.
 * Never invent a second `\r` for providers without `midTurnQueue`.
 */
export function shouldSteerAfterPark(input: {
  result: SubmitCheckResult;
  steer: boolean;
  steerKey: string | undefined;
}): boolean {
  return input.result === "parked" && input.steer === true && typeof input.steerKey === "string" && input.steerKey.length > 0;
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
  /**
   * Monotonic count of `2004l` / reset events seen on the stream. For a
   * shell at its prompt this is "readline accepted a line": measured
   * against bash 5.3 with TERM=xterm-256color (2026-09-13) — `2004h` at
   * the prompt, `2004l` emitted the instant Enter accepts the line
   * (BEFORE the command runs, even a silent `sleep`), `2004h` again when
   * the prompt returns. The one out-of-screen submit signal a shell
   * gives; `decideShellSubmitCheck` uses the delta across the delivery.
   */
  offEvents: number;
}

export function initialBracketedPasteModeState(): BracketedPasteModeState {
  return { enabled: false, carry: "", offEvents: 0 };
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
  let offEvents = state.offEvents ?? 0;
  for (const ev of events) {
    if (ev.kind === "on") enabled = true;
    else {
      enabled = false; // reset or 2004l
      offEvents++;
    }
  }

  return { enabled, carry: incompletePrivateModeSuffix(text), offEvents };
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
 * invokes this on give-up (`previousResult` is `"unsent"` / `"unknown"`),
 * never on `"sent"` or `"parked"`. Kept to stop abandoned unsent text
 * from concatenating into the next delivery (review achado 4).
 */
export function composerClearSequence(): string {
  return "\x15\x15";
}
