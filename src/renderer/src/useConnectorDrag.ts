import { useState } from "react";
import { hitTest, type BoardItem, type Point } from "./board-model";
import type { Card } from "./card-types";

/**
 * The connector-tool drag gesture — item 5 of DESIGN-BACKLOG.md, phase 2
 * (hook extraction out of `App.tsx`). Deliberately narrow: only the drag
 * itself (draft point while dragging, hit-testing the release point
 * against a card). Persisting the resulting connector (`addConnector`) is
 * board/store concern, not this hook's — same boundary
 * `useWorldTransform` drew for `fitView` needing `cardsRef` without
 * owning card state.
 */
export function useConnectorDrag(
  clientToWorld: (clientX: number, clientY: number) => Point,
  cardsRef: React.RefObject<Card[]>,
  order: string[],
  onConnect: (fromId: string, toId: string) => void,
) {
  const [connectorDraft, setConnectorDraft] = useState<{ fromId: string; point: Point } | null>(null);

  /** Drag from a card, in "connector" tool mode, to another card — released via CardFrame.onConnectorStart. */
  function startConnectorDrag(fromId: string, e: React.PointerEvent) {
    e.stopPropagation();
    setConnectorDraft({ fromId, point: clientToWorld(e.clientX, e.clientY) });
    function onMove(ev: PointerEvent) {
      setConnectorDraft({ fromId, point: clientToWorld(ev.clientX, ev.clientY) });
    }
    function onUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setConnectorDraft(null);
      const releasePoint = clientToWorld(ev.clientX, ev.clientY);
      const target = hitTest(cardsRef.current as BoardItem[], releasePoint, order);
      if (target && target.id !== fromId) onConnect(fromId, target.id);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return { connectorDraft, startConnectorDrag };
}
