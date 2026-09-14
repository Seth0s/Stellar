/**
 * What to do when Electron fires `render-process-gone` on the main window.
 *
 * Incident 2026-09-14 (packaged 8dc332c): the renderer died with no
 * Crashpad dump and no kernel OOM. Main kept alive and `safeSend` threw
 * "Render frame was disposed…" on every PTY flush for ~55s — noise that
 * hid the real event. Nobody listened for `render-process-gone`, so
 * `details.reason` / `exitCode` were never recorded.
 *
 * Facts that drive the policy (proved in-tree, not guessed):
 *
 * - PTYs live in main (`pty-registry.ts`) and survive a dead renderer —
 *   React cleanup in `useTerminal.ts` (the only `pty.kill` path) never
 *   runs when the JS context is gone.
 * - A bare `webContents.reload()` is NOT enough to keep those PTYs
 *   attached: remount always calls `pty:spawn`, and `spawn()` has no
 *   early return for an already-alive id — a second process would be
 *   created and `adoptEntry` would orphan the survivor. Reattach is
 *   therefore required at the IPC boundary in `index.ts` (return `{ id }`
 *   when `registry.isAlive(id)`), not a claim that reload alone preserves
 *   terminals.
 * - Pre-crash xterm scrollback lived only in the dead renderer; it cannot
 *   be recovered. Output produced WHILE the frame is dead can still be
 *   held in main and flushed after reload (see hold helpers below) —
 *   discarding that would erase agent work-in-progress.
 *
 * Retry ceiling mirrors the measured cost of unconstrained retry in this
 * repo (`exit-lifetime-decision.ts`: 6 cards for 2 tasks in ~40s). A
 * sliding window of reloads per window, then a clean quit with the reason
 * already on disk, beats an infinite reload loop.
 */

/** Sliding-window ceiling for auto-reload after renderer death. */
export const RENDERER_GONE_RETRY = {
  /** How many reloads are allowed inside `windowMs` before giving up. */
  maxReloads: 2,
  /** Sliding window measured in wall-clock ms (caller stamps `nowMs`). */
  windowMs: 60_000,
} as const;

/** Cap for PTY bytes held in main while the renderer frame is unreachable. */
export const RENDERER_GONE_PTY_HOLD = {
  /** Per card. Tail kept when truncated — newest output is the recovery signal. */
  maxBytesPerCard: 512_000,
} as const;

/** Filename under `app.getPath("userData")` — survives restart; not SQLite. */
export const RENDERER_GONE_LOG_BASENAME = "renderer-gone.log";

export type RendererGoneDecision =
  | { action: "ignore"; record: false; why: "quitting" | "window-dead" | "clean-exit" }
  | {
      action: "reload";
      record: true;
      reloadsInWindow: number;
    }
  | {
      action: "quit";
      record: true;
      why: "retry-limit" | "unrecoverable-reason";
      reloadsInWindow: number;
    };

/**
 * Pure reaction to one `render-process-gone` event.
 * Caller stamps `recentReloadAtMs` only when it actually performs a reload.
 */
export function decideRendererGone(input: {
  reason: string;
  exitCode: number;
  nowMs: number;
  recentReloadAtMs: readonly number[];
  windowAlive: boolean;
  isQuitting: boolean;
  limit?: { maxReloads: number; windowMs: number };
}): RendererGoneDecision {
  void input.exitCode; // recorded by the caller; not used in the branch
  if (input.isQuitting) return { action: "ignore", record: false, why: "quitting" };
  if (!input.windowAlive) return { action: "ignore", record: false, why: "window-dead" };
  if (input.reason === "clean-exit") {
    return { action: "ignore", record: false, why: "clean-exit" };
  }

  const limit = input.limit ?? RENDERER_GONE_RETRY;
  const windowStart = input.nowMs - limit.windowMs;
  const recent = input.recentReloadAtMs.filter((t) => t >= windowStart);
  const reloadsInWindow = recent.length;

  if (input.reason === "launch-failed" || input.reason === "integrity-failure") {
    return {
      action: "quit",
      record: true,
      why: "unrecoverable-reason",
      reloadsInWindow,
    };
  }

  if (reloadsInWindow >= limit.maxReloads) {
    return {
      action: "quit",
      record: true,
      why: "retry-limit",
      reloadsInWindow,
    };
  }

  return { action: "reload", record: true, reloadsInWindow };
}

/** Drop timestamps that can no longer affect the sliding-window ceiling. */
export function pruneRendererGoneReloads(
  recentReloadAtMs: readonly number[],
  nowMs: number,
  windowMs: number = RENDERER_GONE_RETRY.windowMs,
): number[] {
  const windowStart = nowMs - windowMs;
  return recentReloadAtMs.filter((t) => t >= windowStart);
}

export type RendererGoneLogLine = {
  at: string;
  reason: string;
  exitCode: number;
  action: "reload" | "quit";
  why?: "retry-limit" | "unrecoverable-reason";
  reloadsInWindow: number;
};

export function formatRendererGoneLogLine(input: {
  atMs: number;
  reason: string;
  exitCode: number;
  decision: Extract<RendererGoneDecision, { record: true }>;
}): string {
  const line: RendererGoneLogLine = {
    at: new Date(input.atMs).toISOString(),
    reason: input.reason,
    exitCode: input.exitCode,
    action: input.decision.action,
    reloadsInWindow: input.decision.reloadsInWindow,
  };
  if (input.decision.action === "quit") line.why = input.decision.why;
  return `${JSON.stringify(line)}\n`;
}

export type SafeSendGate =
  | { action: "send" }
  | { action: "skip"; reason: "window-destroyed" | "contents-destroyed" | "renderer-unreachable" };

/**
 * Pre-send gate. `rendererReachable` is the sticky flag cleared on
 * `render-process-gone` and set again on `did-finish-load` — covers the
 * "window alive, frame dead" case that `isDestroyed()` misses.
 */
export function decideSafeSend(input: {
  windowDestroyed: boolean;
  contentsDestroyed: boolean;
  rendererReachable: boolean;
}): SafeSendGate {
  if (input.windowDestroyed) return { action: "skip", reason: "window-destroyed" };
  if (input.contentsDestroyed) return { action: "skip", reason: "contents-destroyed" };
  if (!input.rendererReachable) return { action: "skip", reason: "renderer-unreachable" };
  return { action: "send" };
}

/**
 * What still belongs in the log after `safeSend` catches.
 * Frame-disposed streaks are the 2026-09-14 noise — log the first only.
 * Any other error stays visible (silencing everything recreates blindness).
 */
export function decideSafeSendErrorLog(input: {
  errorMessage: string;
  /** How many consecutive frame-disposed errors were already logged/skipped
   * in this streak BEFORE this one (0 = first). */
  consecutiveFrameDisposed: number;
}): { log: boolean; kind: "frame-disposed" | "other" } {
  const kind = isFrameDisposedError(input.errorMessage) ? "frame-disposed" : "other";
  if (kind === "other") return { log: true, kind };
  return { log: input.consecutiveFrameDisposed === 0, kind };
}

export function isFrameDisposedError(message: string): boolean {
  return /render frame was disposed|frame.*disposed|WebFrameMain/i.test(message);
}

export type PtyHoldAppendDecision =
  | { action: "append"; nextBytes: number }
  | { action: "append-truncate-head"; keepFrom: number; nextBytes: number };

/**
 * Hold PTY output while the frame is dead. Prefer keeping the TAIL when
 * over cap — recovery should show what the agent was producing last, not
 * the oldest bytes of a runaway stream. Pausing the PTY was rejected:
 * node-pty already drains into JS; a pause would stall agent writers on a
 * full TTY buffer. Discarding was rejected: scrollback is the agents'
 * work record.
 */
export function decidePtyHoldAppend(input: {
  existingBytes: number;
  incoming: string;
  maxBytes?: number;
}): PtyHoldAppendDecision {
  const maxBytes = input.maxBytes ?? RENDERER_GONE_PTY_HOLD.maxBytesPerCard;
  const incomingBytes = input.incoming.length;
  const nextBytes = input.existingBytes + incomingBytes;
  if (nextBytes <= maxBytes) {
    return { action: "append", nextBytes };
  }
  // Keep a suffix of the joined buffer of length maxBytes. Caller applies
  // by joining, slicing from keepFrom, and replacing chunks.
  const overflow = nextBytes - maxBytes;
  return {
    action: "append-truncate-head",
    keepFrom: overflow,
    nextBytes: maxBytes,
  };
}
