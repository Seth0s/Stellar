import { useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import { clampBrowserBounds, worldRectToScreen, type Rect, type WorldTransform } from "./board-model";
import { useChromeOccluded } from "./occlusion";

// Must match the titlebar + floating topbar's combined height, and the
// rail's width (app.css) — a WebContentsView paints above every DOM
// element regardless of z-index, so without this clamp a browser card
// panned/zoomed underneath any of those would cover it.
const CHROME_INSETS = { top: 82, left: 72 };

export function BrowserCard({
  id,
  rect,
  zoom,
  zIndex,
  world,
  viewportOrigin,
  viewportSize,
  visible,
  url,
  ownerCardId,
  interactionMode,
  selected,
  reflowing,
  closing,
  onChange,
  onCommit,
  onRaise,
  onClose,
  onCloseAnimationEnd,
  onConnectorStart,
  onSelectStart,
}: {
  id: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  world: WorldTransform;
  viewportOrigin: { x: number; y: number };
  viewportSize: { width: number; height: number };
  visible: boolean;
  url: string;
  ownerCardId: string | null;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  /** Note: only the DOM chrome fades — a WebContentsView paints above every
   * DOM element and has no CSS-driven opacity of its own, so the actual
   * page content just sits there unfaded for the animation's ~160ms before
   * this card (and the native view under it) are actually removed. */
  closing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const [bar, setBar] = useState(url);
  const occluded = useChromeOccluded();
  const createdRef = useRef(false);

  useEffect(() => {
    if (!createdRef.current) {
      createdRef.current = true;
      void window.browser.create(id, url);
    }
    return () => {
      void window.browser.destroy(id);
    };
    // Create/destroy are keyed to the card's identity only — navigating
    // later (address bar, ask-modal Allow) must never re-create the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const offNav = window.browser.onNavigate((navId, navUrl) => {
      if (navId === id) setBar(navUrl);
    });
    return () => {
      offNav();
    };
  }, [id]);

  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      if (!visible || occluded) {
        void window.browser.setVisible(id, false);
        return;
      }
      const screenRect = worldRectToScreen(rect, world, viewportOrigin);
      const clamped = clampBrowserBounds(
        screenRect,
        { x: viewportOrigin.x, y: viewportOrigin.y, w: viewportSize.width, h: viewportSize.height },
        CHROME_INSETS,
      );
      if (!clamped) {
        void window.browser.setVisible(id, false);
        return;
      }
      void window.browser.setBounds(id, clamped);
      void window.browser.setVisible(id, true);
    });
    return () => cancelAnimationFrame(rafId);
  }, [id, rect, world, viewportOrigin, viewportSize, visible, occluded]);

  return (
    <CardFrame
      className="browser-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      selected={selected}
      accent="var(--accent-browser)"
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onRaise={() => {
        onRaise();
        void window.browser.raise(id);
      }}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      headerContent={
        <div className="browser-card-address">
          <button onClick={() => window.browser.back(id)}>
            <Icon name="back" size={12} />
          </button>
          <button onClick={() => window.browser.forward(id)}>
            <Icon name="forward" size={12} />
          </button>
          <button onClick={() => window.browser.reload(id)}>
            <Icon name="reload" size={12} />
          </button>
          <input
            value={bar}
            onChange={(e) => setBar(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void window.browser.navigate(id, bar);
            }}
          />
          {ownerCardId && (
            <span className="browser-card-owner" title={`aberto por card #${ownerCardId}`}>
              #{ownerCardId}
            </span>
          )}
          <button onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>
      }
    >
      <div className="browser-card-body" />
    </CardFrame>
  );
}
