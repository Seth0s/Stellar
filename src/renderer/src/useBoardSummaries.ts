import { useEffect, useState } from "react";
import type { BoardBackgroundStatus, BoardRow, BoardSummary } from "../../preload/index";

/**
 * The Home aggregate: provider mix and tasks by phase, per saved board. Read
 * on mount and whenever the set of boards changes, plus on window focus, so
 * the sessions screen never shows a stale count after work happened elsewhere.
 */
export function useBoardSummaries(boards: BoardRow[]): Record<string, BoardSummary> {
  const [summaries, setSummaries] = useState<Record<string, BoardSummary>>({});
  const key = boards.map((b) => b.id).join(",");

  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.store
        .boardSummaries()
        .then((s) => {
          if (alive) setSummaries(s);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, [key]);

  return summaries;
}

/**
 * Fired when the set of live background sessions may have changed (e.g. a
 * session was stopped). `useBoardBackgroundStatus` re-reads on it, so the Home
 * indicator disappears after a "Stop session" without a window focus.
 */
export const BACKGROUND_CHANGED_EVENT = "stellar:background-changed";

/**
 * Per-session BACKGROUND state (running / N agents / waiting on you) plus the
 * ceiling. Same shape as `useBoardSummaries`: open gesture, focus, and an
 * explicit change event (a stop must clear the indicator immediately).
 */
export function useBoardBackgroundStatus(boards: BoardRow[]): BoardBackgroundStatus | null {
  const [status, setStatus] = useState<BoardBackgroundStatus | null>(null);
  const key = boards.map((b) => b.id).join(",");

  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.store
        .boardBackgroundStatus()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    window.addEventListener(BACKGROUND_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.removeEventListener(BACKGROUND_CHANGED_EVENT, load);
    };
  }, [key]);

  return status;
}
