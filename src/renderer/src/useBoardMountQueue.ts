import { useCallback, useEffect, useMemo, useState } from "react";
import { isInView, type Rect } from "./board-model";
import {
  BOARD_MOUNT_CEILING,
  nextMountReleases,
  orderBoardMount,
} from "./board-mount-order";

export type BoardMountProgress = {
  ready: number;
  total: number;
  /** True while at least one card is still waiting on the mount queue. */
  active: boolean;
};

/**
 * Releases board cards for heavy mount in priority order, at most
 * BOARD_MOUNT_CEILING at a time. Every card stays as a skeleton until
 * `isReleased(id)` flips true; the card then calls `markReady(id)` when its
 * expensive work (PTY replay, browser create, …) has settled.
 */
export function useBoardMountQueue(
  boardId: string | null,
  cards: readonly { id: string; rect: Rect }[],
  order: readonly string[],
  visibleRect: Rect,
): {
  isReleased: (id: string) => boolean;
  markReady: (id: string) => void;
  progress: BoardMountProgress;
} {
  const [released, setReleased] = useState<ReadonlySet<string>>(() => new Set());
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setReleased(new Set());
    setReady(new Set());
  }, [boardId]);

  const cardIdsKey = cards.map((c) => c.id).join("\0");
  useEffect(() => {
    const live = new Set(cards.map((c) => c.id));
    setReleased((prev) => pruneSet(prev, live));
    setReady((prev) => pruneSet(prev, live));
    // cards identity is tracked via cardIdsKey; rect changes must not reset the queue
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardIdsKey]);

  const focusedId = order.length > 0 ? order[order.length - 1]! : null;
  const viewportCenter = useMemo(
    () => ({
      x: visibleRect.x + visibleRect.w / 2,
      y: visibleRect.y + visibleRect.h / 2,
    }),
    [visibleRect.x, visibleRect.y, visibleRect.w, visibleRect.h],
  );

  const ordered = useMemo(() => {
    const candidates = cards.map((c) => ({
      id: c.id,
      rect: c.rect,
      focused: c.id === focusedId,
      inView: isInView(c.rect, visibleRect),
    }));
    return orderBoardMount(candidates, viewportCenter);
  }, [cards, focusedId, visibleRect, viewportCenter]);

  useEffect(() => {
    const next = nextMountReleases(ordered, released, ready, BOARD_MOUNT_CEILING);
    if (next.length === 0) return;
    setReleased((prev) => {
      const n = new Set(prev);
      for (const id of next) n.add(id);
      return n;
    });
  }, [ordered, released, ready]);

  const markReady = useCallback((id: string) => {
    setReady((prev) => {
      if (prev.has(id)) return prev;
      const n = new Set(prev);
      n.add(id);
      return n;
    });
  }, []);

  const isReleased = useCallback((id: string) => released.has(id), [released]);

  const progress: BoardMountProgress = {
    ready: ready.size,
    total: cards.length,
    active: cards.length > 0 && ready.size < cards.length,
  };

  return { isReleased, markReady, progress };
}

function pruneSet(prev: ReadonlySet<string>, live: ReadonlySet<string>): ReadonlySet<string> {
  let changed = false;
  const next = new Set<string>();
  for (const id of prev) {
    if (live.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : prev;
}
