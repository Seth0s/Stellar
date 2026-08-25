import { useRef, useState } from "react";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

/**
 * Shared drag/resize/z-order chrome for every board item kind. Pulled out of
 * TerminalCard once files/changes/sticky needed the exact same pointer math —
 * a header drag that moves `rect` in world units (divided by `zoom` so it
 * tracks the mouse 1:1 while zoomed) and a corner handle that resizes it,
 * both committing only on pointerup, never per frame.
 */
export function CardFrame({
  rect,
  zoom,
  zIndex,
  className,
  headerContent,
  children,
  interactionMode = "normal",
  selected = false,
  accent,
  reflowing,
  onChange,
  onCommit,
  onRaise,
  onResizeSettled,
  onConnectorStart,
  onSelectStart,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  className: string;
  headerContent: React.ReactNode;
  children: React.ReactNode;
  /** "connector"/"select" both disable the normal drag/resize gestures below
   * so a click anywhere on the card starts a connector drag or a selection
   * toggle instead — see App.tsx. */
  interactionMode?: "normal" | "connector" | "select";
  /** Outline highlight while multi-selected (item 4) — see cards.css. */
  selected?: boolean;
  /** CSS color value for the card's left accent bar (see cards.css's ::before) — omitted means no accent. */
  accent?: string;
  /** True for ~300ms right after an "organizar automaticamente" — animates the position change instead of jumping. */
  reflowing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onResizeSettled?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const [dragging, setDragging] = useState(false);

  function onHeaderPointerDown(e: React.PointerEvent) {
    if (interactionMode !== "normal") return;
    if ((e.target as HTMLElement).closest("button, select, input")) return;
    onRaise();
    setDragging(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = rectRef.current;
    let finalRect = startRect;
    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      finalRect = { ...startRect, x: startRect.x + dx, y: startRect.y + dy };
      onChange(finalRect);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      onCommit(finalRect);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onResizePointerDown(e: React.PointerEvent) {
    if (interactionMode !== "normal") return;
    e.stopPropagation();
    onRaise();
    setDragging(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = rectRef.current;
    let finalRect = startRect;
    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      finalRect = {
        ...startRect,
        w: Math.max(160, startRect.w + dx),
        h: Math.max(120, startRect.h + dy),
      };
      onChange(finalRect);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      onCommit(finalRect);
      onResizeSettled?.();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const frameClass = [
    "card-frame",
    className,
    "spawning",
    dragging && "dragging",
    reflowing && "reflow",
    selected && "selected",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={frameClass}
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        ...(accent ? ({ "--accent": accent } as React.CSSProperties) : {}),
      }}
      onPointerDown={(e) => {
        onRaise();
        if (interactionMode === "connector") onConnectorStart?.(e);
        if (interactionMode === "select") onSelectStart?.(e);
      }}
    >
      {/* Owns overflow:hidden + border-radius (clips content to the rounded
          card shape). The resize handle below is deliberately OUTSIDE this
          wrapper — it used to be a child of the clipped box itself, which
          clipped away most of its own hit area right in the corner it
          lives in, making cards effectively non-resizable in practice. */}
      <div className="card-clip">
        <div className="card-head" onPointerDown={onHeaderPointerDown}>
          {headerContent}
        </div>
        {children}
      </div>
      <div className="card-resize" onPointerDown={onResizePointerDown}>
        <Icon name="resizeGrip" size={11} />
      </div>
    </div>
  );
}
