import { memo } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

export const STROKE_COLORS = ["#f5f5f5", "#ff6b6b", "#6bc5ff", "#6bff9d"] as const;

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function StrokeCardInner({
  rect,
  zoom,
  zIndex,
  points,
  color,
  width = 3,
  style = "solid",
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
  rect: Rect;
  zoom: number;
  zIndex: number;
  points: [number, number][];
  color: string;
  /** In the 0–100 normalized viewBox unit, not px — see App.tsx's parseStroke. */
  width?: number;
  style?: "solid" | "marker";
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const polyline = points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");
  return (
    <CardFrame
      className="stroke-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      selected={selected}
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      headerContent={
        <button className="stroke-card-close" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      }
    >
      <svg className="stroke-card-body" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline
          points={polyline}
          fill="none"
          stroke={color}
          strokeWidth={style === "marker" ? width * 1.8 : width}
          strokeOpacity={style === "marker" ? 0.55 : 1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </CardFrame>
  );
}

export const StrokeCard = memo(StrokeCardInner);
