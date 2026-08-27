import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

export const STICKY_COLORS = ["yellow", "green", "blue", "pink"] as const;
const STICKY_BG: Record<string, string> = {
  yellow: "#4a4520",
  green: "#204a2c",
  blue: "#20304a",
  pink: "#4a2038",
};
const STICKY_ACCENT: Record<string, string> = {
  yellow: "var(--signal)",
  green: "var(--good)",
  blue: "var(--foam)",
  pink: "#e879b8",
};

export function StickyCard({
  rect,
  zoom,
  zIndex,
  content,
  color,
  interactionMode,
  selected,
  reflowing,
  closing,
  label,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onContentChange,
  onContentCommit,
  onColorCommit,
  onConnectorStart,
  onSelectStart,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  content: string;
  color: string;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  label: string | null;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onContentChange: (content: string) => void;
  onContentCommit: (content: string) => void;
  onColorCommit: (color: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  return (
    <CardFrame
      className="sticky-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      selected={selected}
      accent={STICKY_ACCENT[color] ?? STICKY_ACCENT.yellow}
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="sticky" size={14} />
            <CardTag label={label ?? "nota"} onRename={onRename} />
            <span className="swatches">
              {STICKY_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch${c === color ? " active" : ""}`}
                  style={{ background: STICKY_ACCENT[c] }}
                  onClick={() => onColorCommit(c)}
                />
              ))}
            </span>
          </span>
          <button onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </>
      }
    >
      <textarea
        className="sticky-textarea"
        style={{ background: STICKY_BG[color] ?? STICKY_BG.yellow }}
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        onBlur={() => onContentCommit(content)}
      />
    </CardFrame>
  );
}
