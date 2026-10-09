import { CardFrame } from "./CardFrame";
import { t } from "../../shared/i18n";
import type { Rect } from "./board-model";

/**
 * Placeholder chrome for a card waiting on the board mount queue. Uses the
 * real persisted rect so the canvas layout is complete on frame 0 — no
 * jumps when the heavy card replaces this, and no black browser canvas
 * while create/paint are still pending.
 */
export function CardSkeleton({
  kind,
  rect,
  zoom,
  zIndex,
  displayName,
  interactionMode = "normal",
  selected = false,
  reflowing,
  closing,
  screenProjected,
  panX,
  panY,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onCloseAnimationEnd,
  onConnectorStart,
  onSelectStart,
  onRename,
}: {
  kind: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  displayName: string;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus?: () => void;
  onCloseAnimationEnd?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  onRename: (label: string) => void;
}) {
  return (
    <CardFrame
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      className="card-skeleton"
      kind={kind}
      displayName={displayName}
      onRename={onRename}
      headerContent={null}
      headerContext={<span className="card-skeleton-label">{t("card.skeletonLoading")}</span>}
      interactionMode={interactionMode}
      selected={selected}
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
    >
      <div
        className="card-skeleton-body"
        data-role="card-skeleton"
        data-kind={kind}
        aria-busy="true"
        aria-label={t("card.skeletonLoading")}
      >
        <div className="card-skeleton-shimmer" />
      </div>
    </CardFrame>
  );
}
