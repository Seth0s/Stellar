import { memo } from "react";
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
// Pedido ao vivo (2026-08-28): "cores das notes" pouco amigáveis aos
// olhos. Antes reusava tokens semânticos do app inteiro em saturação
// máxima (--signal #e8c547, --good #4ad87a, --foam #45c8ff, mais um
// magenta cru #e879b8) — não é só o swatch em si: `--accent` também vira
// `color` direto de `.card-tag` (o texto do rótulo, em maiúsculas,
// pequeno e em negrito — CSS cards.css), então um neon saturado ali é
// literalmente texto neon pra ler, não só um ponto decorativo. Paleta
// nova: mesma família de matiz, dessaturada pra tom pastel/empoeirado —
// ainda distinguível entre si, mas sem doer nos olhos como texto nem
// como acento de card, e desacoplada dos tokens semânticos (que
// continuam existindo pra status/perigo em outro lugar do app).
const STICKY_ACCENT: Record<string, string> = {
  yellow: "#d4b876",
  green: "#82c79a",
  blue: "#7ab8dd",
  pink: "#d192b3",
};

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function StickyCardInner({
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

export const StickyCard = memo(StickyCardInner);
