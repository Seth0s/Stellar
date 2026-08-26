import { Icon, type IconName } from "./icons";

/**
 * Alternate spawn path (DESIGN-BACKLOG.md item 1) — right-click (or
 * press-hold, see App.tsx's long-press timer) on empty canvas opens this
 * instead of using the linear rail. Deliberately additive: the rail stays
 * exactly as it is, this is a second way to the same six actions, anchored
 * at the click instead of the rail's fixed position.
 */
export type RadialAction = "terminal" | "files" | "changes" | "sticky" | "browser" | "remote-window";

const ACTIONS: { action: RadialAction; icon: IconName; label: string }[] = [
  { action: "terminal", icon: "terminal", label: "Terminal" },
  { action: "files", icon: "files", label: "Arquivos" },
  { action: "changes", icon: "changes", label: "Changes" },
  { action: "sticky", icon: "sticky", label: "Nota" },
  { action: "browser", icon: "browser", label: "Navegador" },
  { action: "remote-window", icon: "remoteWindow", label: "Janela externa" },
];

const RADIUS = 88;

export function RadialMenu({
  x,
  y,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  onSelect: (action: RadialAction) => void;
  onClose: () => void;
}) {
  return (
    <div className="radial-backdrop" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div className="radial-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
        {ACTIONS.map(({ action, icon, label }, i) => {
          const angle = (i / ACTIONS.length) * Math.PI * 2 - Math.PI / 2;
          const dx = Math.cos(angle) * RADIUS;
          const dy = Math.sin(angle) * RADIUS;
          return (
            <button
              key={action}
              className="radial-item"
              title={label}
              // Custom properties, not a plain `transform` — the open
              // animation (layout.css) also animates `transform` (a scale
              // pop), and setting the position via `transform` directly
              // here would get clobbered by the keyframe for the
              // animation's duration, making every item flash at the
              // menu's center before snapping to its real spot.
              style={{ "--tx": `${dx}px`, "--ty": `${dy}px` } as React.CSSProperties}
              onClick={() => onSelect(action)}
            >
              <Icon name={icon} size={18} />
            </button>
          );
        })}
        <div className="radial-center" />
      </div>
    </div>
  );
}
