import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

export const STROKE_COLORS = ["#f5f5f5", "#ff6b6b", "#6bc5ff", "#6bff9d"] as const;

export function StrokeCard({
  rect,
  zoom,
  zIndex,
  points,
  color,
  interactionMode,
  reflowing,
  onChange,
  onCommit,
  onRaise,
  onClose,
  onConnectorStart,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  points: [number, number][];
  color: string;
  interactionMode?: "normal" | "connector";
  reflowing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onClose: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
}) {
  const polyline = points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");
  return (
    <CardFrame
      className="stroke-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      reflowing={reflowing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onConnectorStart={onConnectorStart}
      headerContent={
        <button className="stroke-card-close" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      }
    >
      <svg className="stroke-card-body" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={polyline} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </CardFrame>
  );
}
