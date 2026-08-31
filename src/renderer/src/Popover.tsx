import { useEffect, useLayoutEffect, useRef } from "react";
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
  className,
  gap = 14,
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
  /** PathPicker.tsx anchored from inside SessionModal — the base
   * `.popover` z-index (800) sits behind `.modal-root`'s (2000), so that
   * caller passes a class that bumps it back above. */
  className?: string;
  /** Distance from the anchor's own edge — the default 14px assumes the
   * anchor sits flush against whatever visual boundary it's inside (the
   * rail, the topbar). PathPicker.tsx's anchor is a full-width button
   * INSIDE a padded `.modal` (20px), so 14px alone lands the popover a
   * few px inside the modal's own edge, reading as "touching it" — that
   * caller passes a bigger gap to actually clear the modal first. */
  gap?: number;
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

  // DESIGN-BACKLOG.md item 44 — an anchor near the bottom/right edge of
  // the viewport (e.g. TerminalCard's "links vistos" badge, in the
  // card's own footer, for a card that's near the bottom of the board)
  // let the popover's rendered box run past the window's edge. With the
  // CSS below now `position: fixed` that no longer leaks into the
  // document's own scrollable overflow (the actual reported bug — real
  // app-level x/y scrollbars appearing), but an un-clamped popover would
  // still render partly off-screen and be unreachable. Content height is
  // variable (the URL list grows with links seen) and unknown before
  // paint, so this measures the ACTUAL rendered box after layout and
  // nudges it back on-screen — imperative style mutation, not state, so
  // it can't trigger its own re-render loop.
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    if (!el) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const overflowBottom = rect.bottom - (window.innerHeight - margin);
    if (overflowBottom > 0) {
      el.style.top = `${Math.max(margin, rect.top - overflowBottom)}px`;
    }
    // `side="left"` mode positions via CSS `right` (not `left`, see the
    // prop doc below) — nudging the wrong one would set BOTH `left` and
    // `right` on a box with no explicit width, stretching it instead of
    // moving it. Adjust whichever one the current mode actually uses.
    const overflowRight = rect.right - (window.innerWidth - margin);
    if (overflowRight > 0) {
      if (el.style.right) {
        el.style.right = `${Math.max(margin, Number.parseFloat(el.style.right) + overflowRight)}px`;
      } else {
        el.style.left = `${Math.max(margin, rect.left - overflowRight)}px`;
      }
    }
  });

  if (!open) return null;
  const anchor = anchorRef.current?.getBoundingClientRect();
  // DESIGN-BACKLOG.md item 12, achado 5 — 8px read as "cola quase direto
  // na régua" (the rail's own popovers, the most common case). 14px gives
  // real breathing room without drifting the popover noticeably far from
  // its anchor.
  const style: React.CSSProperties = anchor
    ? side === "left"
      ? { top: anchor.top, right: window.innerWidth - anchor.left + gap }
      : { top: anchor.top, left: anchor.right + gap }
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
    <div
      className={`popover${className ? ` ${className}` : ""}`}
      ref={popRef}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
