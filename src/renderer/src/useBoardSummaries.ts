import { useEffect, useState } from "react";
import type { BoardRow, BoardSummary } from "../../preload/index";

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
