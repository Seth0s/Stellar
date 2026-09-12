/**
 * Coalesce decision for FilesCard disk events — same shape as
 * `pty-registry.ts`'s COALESCE_MS / COALESCE_MAX, extracted so the
 * "flush now / arm timer / hold" choice is testable without `fs.watch`
 * or Electron.
 *
 * pty-registry buffers bytes and flushes after 16ms from the FIRST
 * chunk (timer does not reset) or immediately at 64KiB. File events
 * have no payload size, so COALESCE_MAX is a count of events. The
 * timer still does not reset: a `git checkout` or `npm install` that
 * fires thousands of inotify events becomes one IPC every 16ms (or
 * sooner at 64 events), never thousands of `webContents.send`s and
 * never thousands of tree re-renders. FilesCard further serializes
 * reloads so overlapping flushes collapse to one extra pass.
 */

export const COALESCE_MS = 16;
export const COALESCE_MAX = 64;

export type CoalesceState = {
  pending: number;
  paths: Set<string>;
  timerArmed: boolean;
};

export function createCoalesceState(): CoalesceState {
  return { pending: 0, paths: new Set(), timerArmed: false };
}

export type CoalesceAction = "flush" | "arm" | "hold";

export function noteWatchEvent(state: CoalesceState, path: string | undefined): CoalesceAction {
  state.pending += 1;
  if (path) state.paths.add(path);
  if (state.pending >= COALESCE_MAX) return "flush";
  if (!state.timerArmed) {
    state.timerArmed = true;
    return "arm";
  }
  return "hold";
}

export function takeCoalescedFlush(state: CoalesceState): { paths: string[]; pending: number } {
  const paths = [...state.paths];
  const pending = state.pending;
  state.paths.clear();
  state.pending = 0;
  state.timerArmed = false;
  return { paths, pending };
}
