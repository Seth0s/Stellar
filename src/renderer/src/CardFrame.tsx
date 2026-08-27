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
  footerContent,
  onFocus,
  children,
  interactionMode = "normal",
  selected = false,
  accent,
  reflowing,
  closing,
  onChange,
  onCommit,
  onRaise,
  onResizeSettled,
  onConnectorStart,
  onSelectStart,
  onCloseAnimationEnd,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  className: string;
  headerContent: React.ReactNode;
  /** One-line strip at the bottom of the card (cwd, root path, URL, ...) —
   * reported live (2026-08-27) as inconsistent: each card kind that
   * wanted one duplicated its own `<div className="card-foot">`, and two
   * kinds (sticky, browser) had none at all. Owning the slot/styling here
   * means any future card kind gets the same footer "for free" just by
   * passing this prop, instead of re-implementing it. Omit for a card
   * with nothing meaningful to show there (sticky notes have no
   * comparable single-line metadata). */
  footerContent?: React.ReactNode;
  /** "Ajustar à tela" (DESIGN-BACKLOG.md item 21, ponto 2) — used to live
   * as a global "fit every card" button in Topbar's zoom-pill, right next
   * to the real fullscreen button added in item 19; the user reported
   * confusing the two ("ícone extra de fullscreen que não remove o
   * header") and, once told which button it actually was, asked for it
   * to live per-card instead ("acho válido estar no header do card, não
   * na topbar") — this is that: focuses/zooms the view onto THIS card
   * (reuses useWorldTransform's existing `focusCard`, already built for
   * the rail's jump-to-card popover). Lives here, not in each card's own
   * `headerContent`, so every kind gets it automatically — same slot
   * pattern as `footerContent` above. */
  onFocus?: () => void;
  children: React.ReactNode;
  /** "connector"/"select" both disable the normal drag/resize gestures below
   * so a click anywhere on the card starts a connector drag or a selection
   * toggle instead — see App.tsx. */
  interactionMode?: "normal" | "connector" | "select";
  /** Outline highlight while multi-selected (item 4) — see cards.css. */
  selected?: boolean;
  /** CSS color value for the card's left accent bar — unused today (the
   * bar itself was removed), kept only as the source for .card-tag's
   * per-provider/kind tint. */
  accent?: string;
  /** True for ~300ms right after an "organizar automaticamente" — animates the position change instead of jumping. */
  reflowing?: boolean;
  /** True while playing the close-out animation, right before removal — see App.tsx's closeCard/finalizeCloseCard split. */
  closing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onResizeSettled?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  onCloseAnimationEnd?: () => void;
}) {
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const [dragging, setDragging] = useState(false);

  function onHeaderPointerDown(e: React.PointerEvent) {
    if (interactionMode !== "normal") return;
    // [data-no-drag]: the header's editable title (CardTag) — an inline
    // <input> only while actively editing, but the double-click that
    // enters edit mode has to survive its own first pointerdown too, so the
    // plain (non-editing) tag span carries the same attribute.
    if ((e.target as HTMLElement).closest("button, select, input, [data-no-drag]")) return;
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
    closing && "closing",
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
        if (closing) return;
        onRaise();
        if (interactionMode === "connector") onConnectorStart?.(e);
        if (interactionMode === "select") onSelectStart?.(e);
      }}
      onAnimationEnd={(e) => {
        if (closing && e.currentTarget === e.target) onCloseAnimationEnd?.();
      }}
    >
      {/* Owns overflow:hidden + border-radius (clips content to the rounded
          card shape). The resize handle below is deliberately OUTSIDE this
          wrapper — it used to be a child of the clipped box itself, which
          clipped away most of its own hit area right in the corner it
          lives in, making cards effectively non-resizable in practice. */}
      <div className="card-clip">
        <div className="card-head" onPointerDown={onHeaderPointerDown}>
          {/* Wrapping div, not headerContent's own two-item space-between
              row directly — keeps every card kind's own internal layout
              (label ↔ actions) untouched; the focus button below is
              appended as a separate, always-last flex item instead of a
              3rd competitor for that space-between pair. */}
          <div className="card-head-inner">{headerContent}</div>
          {onFocus && (
            <button
              type="button"
              className="card-focus-btn"
              title="Focar nesse card (ajustar zoom pra ele)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onFocus}
            >
              <Icon name="fit" size={12} />
            </button>
          )}
        </div>
        {children}
        {footerContent !== undefined && footerContent !== null && (
          <div className="card-foot">{footerContent}</div>
        )}
      </div>
      <div className="card-resize" onPointerDown={onResizePointerDown}>
        <Icon name="resizeGrip" size={11} />
      </div>
    </div>
  );
}
