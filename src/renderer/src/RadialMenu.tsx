import { useState } from "react";
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

// DESIGN-BACKLOG.md item 21, ponto 7 — how wide the ring's "hit band" is
// on either side of RADIUS for tracking the mouse (items are 40px circles
// centered on the circle, so ±20 is their own footprint; the extra margin
// makes the indicator track before the cursor is literally over a button).
const RING_BAND = 32;
// Half-width of the highlighted arc itself, in radians (~16°).
const ARC_HALF_ANGLE = 0.28;
// SVG overlay padding beyond RADIUS, room for the arc's stroke width.
const OVERLAY_PAD = 12;
const OVERLAY = RADIUS + OVERLAY_PAD;

function arcPath(radius: number, centerAngle: number) {
  const start = centerAngle - ARC_HALF_ANGLE;
  const end = centerAngle + ARC_HALF_ANGLE;
  const cx = OVERLAY;
  const cy = OVERLAY;
  const sx = cx + Math.cos(start) * radius;
  const sy = cy + Math.sin(start) * radius;
  const ex = cx + Math.cos(end) * radius;
  const ey = cy + Math.sin(end) * radius;
  return `M ${sx} ${sy} A ${radius} ${radius} 0 0 1 ${ex} ${ey}`;
}

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
  // DESIGN-BACKLOG.md item 21, ponto 7 — "uma linha acompanhando o mouse
  // em volta do raio (estritamente em volta do raio, não uma linha reta
  // até o cursor)": an arc that tracks the pointer's angle along the
  // ring, not a straight line to the cursor. `null` means the pointer
  // has never gotten near the ring since the menu opened — nothing
  // renders. Once it has, moving away from the ring band (back toward
  // the center, or out past the items) leaves the angle exactly where it
  // last was instead of resetting — "fica presa no último botão que
  // estava perto" — only `onPointerMove` updates it, so there's no
  // separate leave handler resetting anything.
  const [indicatorAngle, setIndicatorAngle] = useState<number | null>(null);

  function handlePointerMove(e: React.PointerEvent) {
    const dx = e.clientX - x;
    const dy = e.clientY - y;
    const dist = Math.hypot(dx, dy);
    if (Math.abs(dist - RADIUS) > RING_BAND) return;
    setIndicatorAngle(Math.atan2(dy, dx));
  }

  return (
    // `onPointerMove` lives here, not on `.radial-menu` — that div is
    // `width:0; height:0` (its children escape the box via `position:
    // absolute`/`transform`, same trick the items themselves use), so
    // IT only ever receives a pointer event when the cursor happens to
    // land exactly on a rendered child (a button, or the indicator once
    // it exists) — everywhere else in the ring's gaps, the event lands
    // directly on this backdrop instead and never bubbles down into a
    // sibling. The backdrop covers the full viewport, so it sees every
    // move regardless of where in the ring the cursor actually is.
    <div
      className="radial-backdrop"
      onPointerDown={onClose}
      onPointerMove={handlePointerMove}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="radial-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
        {indicatorAngle !== null && (
          <svg
            className="radial-indicator"
            width={OVERLAY * 2}
            height={OVERLAY * 2}
            style={{ left: -OVERLAY, top: -OVERLAY }}
          >
            <path d={arcPath(RADIUS, indicatorAngle)} />
          </svg>
        )}
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
