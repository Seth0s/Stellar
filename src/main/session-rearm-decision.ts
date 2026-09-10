/**
 * Pure decision logic for whether (and how) a single input line should
 * (re)arm a card's `watchForSession` poller (`pty-registry.ts`'s
 * `rearmSessionWatch`) — extracted out of `write()`'s input-buffering
 * loop, same category as `connector-label-throttle.ts`/
 * `keyboard-shortcut-guard.ts` (this repo's precedent for pulling a
 * synchronous decision out of code that also does real I/O, so the
 * decision itself is testable without mocking the I/O).
 *
 * Review adversarial RODADA 5 (2026-09-10) — the reviewer's "não dá pra
 * testar write() sem PTY" is false: everything that decides WHETHER (and
 * with what floor) to rearm runs synchronously, before
 * `entry.proc.write(data)` ever touches the real process. This module
 * only ever answers that question — every side effect (starting/stopping
 * the real poller, mutating `entry.*`) stays in `pty-registry.ts`.
 *
 * RODADA 6 (2026-09-10) — RODADA 5 gated the explicit `/resume` trigger on
 * `sessionFound`, which permanently disabled `/resume` on any card that
 * had already resolved a session (every `claude` card, always). Fixed:
 * the trigger always rearms, `sessionFound` or not, and resets it — a
 * real `/resume` IS "forget the current session".
 *
 * RODADA 7 (2026-09-10) — two more real problems, one of them the
 * reviewer overturning RODADA 6's OWN recommendation:
 *
 * Achado 1 — RODADA 6 pinned the scan floor to the card's ORIGINAL spawn
 * time forever. Correct for "two fast submits in the same poll window"
 * (the file the first submit already wrote must stay discoverable), wrong
 * for "card idle for 2h, user opens a session by hand outside Stellar,
 * then types one line in the card": the rearm would scan from spawn time
 * (hours ago) and hijack that external session on the spot — trading a
 * 1.5s race for an hours-wide one. The floor may only stay pinned while a
 * watcher is GENUINELY still in flight (not found, not expired, not
 * cancelled) — that's the "two fast submits" case, where whatever a
 * still-running watcher would have discovered anyway must not be
 * orphaned by moving the goalposts. With no watcher in flight (expired
 * from idling, or never started), a rearm is really starting a NEW
 * attempt and must use a fresh floor — "now" — so anything created during
 * the idle stretch (a real external session) is correctly excluded.
 * `watcherInFlight` (caller-computed from `entry.stopWatch !== null`,
 * itself only reliable now that `watchForSession` reports its own natural
 * expiration — see `session-watch.ts`'s `onTimeout`) is what this
 * function branches on; `nowMs` is supplied by the caller (never read via
 * `Date.now()` here) so the floor choice stays a pure function of its
 * inputs.
 *
 * Achado 3 — `claude` has no `REARM_ON_INPUT_PROVIDERS` entry (its
 * session resolves at spawn, and `RESUME_TRIGGER_COMMANDS` covers the
 * deliberate-switch case on its own) — so the ONE watcher a `/resume`
 * trigger starts is the ONLY chance to catch the resumed session. If the
 * interactive picker takes longer than `TIMEOUT_MS` (30s) to resolve, the
 * watcher dies before the file is ever written and the switch is silently
 * lost. Rather than guessing a bigger timeout, a trigger match now also
 * opens a temporary "rearm on ANY input" window (`awaitingResumeAnyInput`,
 * caller-tracked, cleared by the caller once the session is actually
 * found — or once the caller's watcher times out again while still
 * unresolved, RODADA 8 achado 3, so an abandoned `/resume` — Esc out of
 * the picker — doesn't leave this window stuck open forever) — every
 * subsequent qualifying line, on ANY provider, keeps extending the
 * deadline (via achado 1's own floor rule: a watcher still in flight when
 * the next line arrives keeps the SAME floor, so this never widens the
 * floor).
 *
 * RODADA 8 (2026-09-10), achado 4 — "every subsequent qualifying line"
 * above used to mean strictly non-empty. Wrong: `write()` trims each line
 * before this function ever sees it, and the picker's own confirmation
 * keystroke is a bare `\r`/`\n` with nothing typed since the last one —
 * trimmed, that's `""`. RODADA 7's own reasoning ("the confirmation
 * keystroke crosses the PTY as a real `\r`, so it counts as activity") was
 * right about the byte, wrong about surviving `.trim()` — the mechanism it
 * described literally could not fire. A bare Enter only ever counts as
 * qualifying activity while `awaitingResumeAnyInput` is true (that IS the
 * picker-confirmation gesture, the whole reason this window exists); an
 * empty line outside that window still never counts, same as always
 * (`REARM_ON_INPUT_PROVIDERS`' own "an empty Enter isn't real activity"
 * intent, untouched for the ordinary automatic path).
 */
export interface RearmLineInput {
  /** The input line, already trimmed of its trailing \r/\n — the exact
   * value `pty-registry.ts`'s `write()` buffering loop already computes
   * before deciding anything. */
  line: string;
  /** `RESUME_TRIGGER_COMMANDS[providerId]` (session-watch.ts) —
   * `undefined` for a provider with no confirmed resume slash command. */
  trigger: string | undefined;
  /** `REARM_ON_INPUT_PROVIDERS.includes(providerId)` (session-watch.ts). */
  rearmsOnInput: boolean;
  /** `entry.sessionFound` (pty-registry.ts). Gates the automatic
   * (`rearmsOnInput`/`awaitingResumeAnyInput`) paths — the explicit
   * trigger path ignores it (see this module's own doc comment for why). */
  sessionFound: boolean;
  /** RODADA 7, achado 3 — `entry.awaitingResumeAnyInput`: `true` from the
   * moment an explicit trigger fires until the session is found. While
   * true, ANY non-empty line rearms, even on a provider with neither a
   * trigger nor `rearmsOnInput` membership for THIS line (the picker
   * confirmation itself, on `claude`). */
  awaitingResumeAnyInput: boolean;
  /** RODADA 7, achado 1 — `entry.stopWatch !== null` at decision time: is
   * there a watcher genuinely still polling right now (not found, not
   * expired, not cancelled)? Decides whether a rearm may keep the current
   * floor (`currentFloorMs`) or must start a fresh one (`nowMs`). */
  watcherInFlight: boolean;
  /** The floor currently in effect (`entry.scanFloorMs`) — reused
   * verbatim when `watcherInFlight` is true. */
  currentFloorMs: number;
  /** `Date.now()` at decision time, supplied by the caller (never read
   * here) so this stays a pure function of its inputs. Used as the NEW
   * floor only when `watcherInFlight` is false. */
  nowMs: number;
}

export type RearmDecision =
  | { action: "none" }
  | {
      action: "rearm";
      /** `true` only for the explicit trigger path — the caller must set
       * `entry.sessionFound = false` before rearming (a real session
       * switch). The automatic paths never need this: they only ever
       * fire while `sessionFound` is already `false`. */
      resetSessionFound: boolean;
      /** RODADA 7, achado 3 — `true` only for the explicit trigger path:
       * the caller must set `entry.awaitingResumeAnyInput = true`. Never
       * cleared here — only the caller's own "found" callback clears it,
       * once the switch actually completes. */
      enterAwaitingResumeAnyInput: boolean;
      /** RODADA 7, achado 1 — the floor the caller must pass to
       * `watchForSession` for this rearm, and must also persist back to
       * `entry.scanFloorMs` so the NEXT decision reads the right
       * "current" floor. Either `currentFloorMs` (watcher still in
       * flight) or `nowMs` (nothing in flight — a fresh attempt). */
      floorMs: number;
    };

export function decideRearmOnLine(input: RearmLineInput): RearmDecision {
  const floorMs = input.watcherInFlight ? input.currentFloorMs : input.nowMs;

  // Explicit trigger (e.g. claude's "/resume") — the user is asking to
  // switch sessions. Always rearms, regardless of `sessionFound`, resets
  // it (this IS the "forget the current session" signal — RODADA 6), and
  // opens the "rearm on any input" window (RODADA 7, achado 3) so a slow
  // picker can't outlast a single 30s watcher.
  if (input.trigger && input.line === input.trigger) {
    return { action: "rearm", resetSessionFound: true, enterAwaitingResumeAnyInput: true, floorMs };
  }

  // Automatic rearm — either this provider rearms on every input line
  // (antigravity), or this card is inside a post-trigger "any input"
  // window (RODADA 7, achado 3, any provider). Either way, only while the
  // session hasn't been found yet; once it has, every line is a no-op
  // (RODADA 5's original fix, still correct for both these paths).
  const automaticEligible = input.rearmsOnInput || input.awaitingResumeAnyInput;
  // RODADA 8, achado 4 — a bare Enter (trimmed to "") only counts as
  // qualifying activity INSIDE the post-resume window: that IS the
  // picker's own confirmation gesture. Outside it (the ordinary
  // `rearmsOnInput` path, e.g. antigravity), an empty line still never
  // counts — unchanged from RODADA 3's original intent.
  const countsAsActivity = input.line.length > 0 || input.awaitingResumeAnyInput;
  if (automaticEligible && !input.sessionFound && countsAsActivity) {
    return { action: "rearm", resetSessionFound: false, enterAwaitingResumeAnyInput: false, floorMs };
  }

  return { action: "none" };
}
