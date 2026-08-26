import type { Tool } from "./card-types";
import { Icon, type IconName } from "./icons";

/**
 * Alternate path to the rail (DESIGN-BACKLOG.md item 1) — right-click (or
 * press-hold, see App.tsx's long-press timer) on empty canvas opens this
 * instead of using the linear rail. Deliberately additive: the rail stays
 * exactly as it is, this is a second way to the same actions, anchored
 * at the click/hold point instead of the rail's fixed position.
 *
 * Scope decided 2026-08-26 (item 1 revisited): originally only the 6
 * spawn actions; now also covers the 4 tool switches (pointer/pen/
 * connector/select) — everything on the rail that's a single click with
 * no popover of its own. Find-card and the AI actions stay rail/popover
 * -only; a radial slot isn't a sensible home for a searchable list.
 */
export type RadialAction =
  | "tool-pointer"
  | "tool-pen"
  | "tool-connector"
  | "tool-select"
  | "terminal"
  | "files"
  | "changes"
  | "sticky"
  | "browser"
  | "remote-window";

const ACTIONS: { action: RadialAction; icon: IconName; label: string; group: "tool" | "spawn"; tool?: Tool }[] = [
  { action: "tool-pointer", icon: "pointer", label: "Ponteiro", group: "tool", tool: "pointer" },
  { action: "tool-pen", icon: "pen", label: "Caneta", group: "tool", tool: "pen" },
  { action: "tool-connector", icon: "link", label: "Conector", group: "tool", tool: "connector" },
  { action: "tool-select", icon: "select", label: "Selecionar", group: "tool", tool: "select" },
  { action: "terminal", icon: "terminal", label: "Terminal", group: "spawn" },
  { action: "files", icon: "files", label: "Arquivos", group: "spawn" },
  { action: "changes", icon: "changes", label: "Changes", group: "spawn" },
  { action: "sticky", icon: "sticky", label: "Nota", group: "spawn" },
  { action: "browser", icon: "browser", label: "Navegador", group: "spawn" },
  { action: "remote-window", icon: "remoteWindow", label: "Janela externa", group: "spawn" },
];

const RADIUS = 88;

export function RadialMenu({
  x,
  y,
  tool,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  /** Current active tool — the matching tool-switch item renders as
   * "already selected", same visual language as the rail's own `.active`
   * button. */
  tool: Tool;
  onSelect: (action: RadialAction) => void;
  onClose: () => void;
}) {
  return (
    <div className="radial-backdrop" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div className="radial-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
        {ACTIONS.map(({ action, icon, label, group, tool: itemTool }, i) => {
          const angle = (i / ACTIONS.length) * Math.PI * 2 - Math.PI / 2;
          const dx = Math.cos(angle) * RADIUS;
          const dy = Math.sin(angle) * RADIUS;
          const isActiveTool = group === "tool" && itemTool === tool;
          return (
            <button
              key={action}
              className={`radial-item radial-item--${group}${isActiveTool ? " active" : ""}`}
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
              <Icon name={icon} size={17} />
            </button>
          );
        })}
        <div className="radial-center" />
      </div>
    </div>
  );
}
