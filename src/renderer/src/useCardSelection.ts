import { useState } from "react";
import { rectsOverlap, type Point, type Rect } from "./board-model";
import type { Card } from "./card-types";
import { toast } from "./useToast";
import type { CardRow } from "../../preload/index";

/**
 * Multi-select state and gestures (item 4: marquee, group/ungroup) —
 * item 5 of DESIGN-BACKLOG.md, phase 2 (hook extraction out of
 * `App.tsx`). Takes card mutation as parameters rather than owning card
 * state — same boundary `useWorldTransform`/`useConnectorDrag` already
 * established (`groupSelected`/`ungroupSelected` mutate `cards`, but
 * that's board/store concern, not this hook's).
 */
export function useCardSelection(
  cardsRef: React.RefObject<Card[]>,
  setCards: (updater: (prev: Card[]) => Card[]) => void,
  activeBoardIdRef: React.RefObject<string | null>,
  nextId: React.RefObject<number>,
  clientToWorld: (clientX: number, clientY: number) => Point,
  toRow: (card: Card, boardId: string) => CardRow,
) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<Rect | null>(null);

  /** Rubber-band marquee (item 4) — a dedicated tool, deliberately not
   * reusing the pointer tool's own background-drag (that's pan, already
   * fixed/validated in an earlier round — see AGENTS.md). A click without a
   * real drag clears the selection instead of selecting an empty rect. */
  function startMarqueeSelect(e: React.PointerEvent) {
    const startPoint = clientToWorld(e.clientX, e.clientY);
    let currentRect: Rect = { x: startPoint.x, y: startPoint.y, w: 0, h: 0 };
    setMarquee(currentRect);
    function onMove(ev: PointerEvent) {
      const p = clientToWorld(ev.clientX, ev.clientY);
      currentRect = {
        x: Math.min(startPoint.x, p.x),
        y: Math.min(startPoint.y, p.y),
        w: Math.abs(p.x - startPoint.x),
        h: Math.abs(p.y - startPoint.y),
      };
      setMarquee(currentRect);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
      if (currentRect.w < 3 && currentRect.h < 3) {
        setSelectedIds(new Set());
        return;
      }
      const hits = cardsRef.current.filter((c) => rectsOverlap(currentRect, c.rect)).map((c) => c.id);
      setSelectedIds(new Set(hits));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** A click (not drag) directly on a card while the select tool is active —
   * CardFrame routes this here instead of starting its normal drag (see its
   * `interactionMode === "select"` guard). Shift/ctrl adds to the existing
   * selection instead of replacing it. */
  function selectCard(id: string, e: React.PointerEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  }

  /** Group/ungroup (item 4) — organizational only, no containment or shared
   * rect: grouping just stamps a shared `groupId` (reusing the same global
   * id counter every other id in this app already shares) so a drag on any
   * member moves the rest together (see App.tsx's changeRect). */
  function groupSelected() {
    if (selectedIds.size < 2) return;
    const groupId = String(nextId.current++);
    const next = cardsRef.current.map((c) => (selectedIds.has(c.id) ? { ...c, groupId } : c));
    setCards(() => next);
    for (const c of next) if (selectedIds.has(c.id)) void window.store.upsert(toRow(c, activeBoardIdRef.current!));
    toast("cards agrupados");
  }

  function ungroupSelected() {
    const next = cardsRef.current.map((c) => (selectedIds.has(c.id) ? { ...c, groupId: null } : c));
    setCards(() => next);
    for (const c of next) if (selectedIds.has(c.id)) void window.store.upsert(toRow(c, activeBoardIdRef.current!));
    toast("grupo desfeito");
  }

  return { selectedIds, setSelectedIds, marquee, startMarqueeSelect, selectCard, groupSelected, ungroupSelected };
}
