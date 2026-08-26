import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Generic anchored popover — every popover in this app (terminal-creation
 * form, AI actions) uses this instead of inventing its own overlay/close
 * logic. Positioned from the anchor's own screen rect; closes on outside
 * pointerdown (Escape is handled by the caller, since App.tsx already owns
 * one global Escape listener for tool state).
 */
export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  side = "right",
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** DESIGN-BACKLOG.md item 12, achado 6 (zoom-pill) — every caller so far
   * sat near the left edge, so opening rightward (the default) always
   * fit. The zoom-pill sits at `.topbar`'s far right instead; "left"
   * grows the popover leftward off the anchor's left edge via CSS
   * `right` (not `left`) positioning, so it never needs to measure its
   * own width to avoid overflowing off-screen. */
  side?: "left" | "right";
}) {
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener("pointerdown", onDocPointerDown, true);
    return () => window.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  const anchor = anchorRef.current?.getBoundingClientRect();
  // DESIGN-BACKLOG.md item 12, achado 5 — 8px read as "cola quase direto
  // na régua" (the rail's own popovers, the most common case). 14px gives
  // real breathing room without drifting the popover noticeably far from
  // its anchor.
  const style: React.CSSProperties = anchor
    ? side === "left"
      ? { top: anchor.top, right: window.innerWidth - anchor.left + 14 }
      : { top: anchor.top, left: anchor.right + 14 }
    : { top: 60, left: 80 };

  // Every caller anchors this from inside a `position: absolute` toolbar
  // (Rail, Topbar) — a plain nested <div> would have that toolbar's own
  // (tiny) box as its CSS containing block, so the viewport-relative
  // top/left above would land relative to the toolbar instead of the
  // window, and `.rail`'s own `overflow-y: auto` clips the mispositioned
  // result away entirely (this is the real cause behind "the terminal
  // button doesn't work" — the popover was opening, just invisible).
  // Portaling straight to <body> makes the viewport the containing block
  // again, matching what the top/left math already assumed.
  return createPortal(
    <div className="popover" ref={popRef} style={style} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}
