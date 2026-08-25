import { useEffect, useRef } from "react";

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
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
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
  const style: React.CSSProperties = anchor ? { top: anchor.top, left: anchor.right + 8 } : { top: 60, left: 80 };

  return (
    <div className="popover" ref={popRef} style={style} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
