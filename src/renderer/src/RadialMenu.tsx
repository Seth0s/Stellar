import { useState } from "react";
import { t, type MessageKey } from "../../shared/i18n";
import type { Tool } from "./card-types";
import { Icon, type IconName } from "./icons";
import { useAgentAvailability, useAvailableAgentProviders } from "./useAgentAvailability";
import { computeIndicator, itemAngle, type IndicatorDisplay } from "./radial-indicator";
import { deriveRadialProviderItems, radialProviderTitle } from "./radial-providers";
import { resolveRingGeometry } from "./radial-ring-geometry";

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
  | "chat"
  | "remote-window"
  | "task";

const ACTIONS: { action: RadialAction; icon: IconName; labelKey: MessageKey; group: "tool" | "spawn"; tool?: Tool }[] = [
  { action: "tool-pointer", icon: "pointer", labelKey: "radial.pointer", group: "tool", tool: "pointer" },
  { action: "tool-pen", icon: "pen", labelKey: "radial.pen", group: "tool", tool: "pen" },
  { action: "tool-connector", icon: "link", labelKey: "radial.connector", group: "tool", tool: "connector" },
  { action: "tool-select", icon: "select", labelKey: "radial.select", group: "tool", tool: "select" },
  { action: "terminal", icon: "terminal", labelKey: "radial.terminal", group: "spawn" },
  { action: "files", icon: "files", labelKey: "radial.files", group: "spawn" },
  { action: "changes", icon: "changes", labelKey: "radial.changes", group: "spawn" },
  { action: "sticky", icon: "sticky", labelKey: "radial.sticky", group: "spawn" },
  { action: "browser", icon: "browser", labelKey: "radial.browser", group: "spawn" },
  { action: "chat", icon: "chat", labelKey: "radial.chat", group: "spawn" },
  { action: "remote-window", icon: "remoteWindow", labelKey: "radial.remoteWindow", group: "spawn" },
  { action: "task", icon: "task", labelKey: "radial.task", group: "spawn" },
];

// How wide the ring's "hit band" is on either side of the ring's radius,
// for both tracking the mouse and deciding what counts as "pointing at an
// item" (items are 40px circles centered on the circle, so ±20 is their
// own footprint; the extra margin makes the indicator track before the
// cursor is literally over a button).
const RING_BAND = 32;
// SVG overlay padding beyond the radius, room for the indicator's stroke
// width.
const OVERLAY_PAD = 12;

/**
 * Duplicated on purpose from ProviderPicker.tsx's `PROVIDER_ICON` — this
 * task's scope is RadialMenu.tsx/Rail.tsx/layout.css only (see the task
 * briefing), not ProviderPicker.tsx, so rather than export/import across
 * that boundary this keeps its own copy. Same fallback rule: a provider
 * id with no entry here still renders something (a bare terminal glyph)
 * instead of crashing.
 */
const PROVIDER_ICON: Record<string, IconName> = {
  bash: "providerBash",
  claude: "providerClaude",
  codex: "providerCodex",
  cursor: "providerCursor",
  antigravity: "providerAntigravity",
  opencode: "providerOpencode",
};

type Level = "root" | "terminal-providers";

export function RadialMenu({
  x,
  y,
  tool,
  providers,
  onSelect,
  onClose,
}: {
  /** Requested open point (e.g. the right-click/long-press position) —
   * NOT necessarily where the ring actually ends up rendering. Review
   * round 3: near a window edge, `resolveRingGeometry`
   * (radial-ring-geometry.ts) clamps the ring's real center inward so
   * the whole ring fits on-screen, same trade-off any context menu makes
   * opening near a screen edge. See that clamp's own doc comment for why
   * — the short version: the item-1 indicator line's start point can
   * end up visibly NOT under the cursor near an edge, on purpose. */
  x: number;
  y: number;
  /** Current active tool — the matching tool-switch item renders as
   * "already selected", same visual language as the rail's own `.active`
   * button. */
  tool: Tool;
  /** Same provider id list Rail.tsx's terminal-config popover already
   * gets from App.tsx's `PROVIDER_OPTIONS` — passed down rather than
   * imported directly to avoid a RadialMenu.tsx -> App.tsx import cycle
   * (App.tsx already imports RadialMenu.tsx). This is the "one real
   * source of providers" the task asked to find, not a new list. */
  providers: string[];
  /** `providerId` is only ever present for `action === "terminal"`, once
   * a provider has actually been picked from the item-2 submenu — see
   * this component's own terminal-submenu handling below. */
  onSelect: (action: RadialAction, providerId?: string) => void;
  onClose: () => void;
}) {
  // --- Item 1 (2026-09-09) -------------------------------------------
  // REVERTED DECISION — history preserved on purpose, this file documents
  // UX calls in place: DESIGN-BACKLOG.md item 21, ponto 7 originally
  // asked for "uma linha acompanhando o mouse em volta do raio
  // (estritamente em volta do raio, não uma linha reta até o cursor)" —
  // an arc riding the ring, never a straight line to the cursor. That's
  // what shipped: an SVG `<path>` arc computed from the pointer's angle.
  //
  // The repo owner changed their mind on 2026-09-09 (with a screen
  // capture): they now want exactly the straight line the original ask
  // explicitly ruled out — a line from the CENTER of the circle, pointing
  // at the cursor, clipped at the ring's radius. What they asked to keep
  // from the old behavior: "mantenha a regra de que a linha fica presa
  // até o raio e se tiver passado por algum objeto antes, volte para ele".
  //
  // Under the old arc, "fica presa" was an ACCIDENT of the code, not a
  // rule: `handlePointerMove` only ever updated the angle while the
  // cursor sat within `RING_BAND` of the ring, so leaving that band froze
  // whatever angle was last computed — there was no leave handler, no
  // memory of "which item", just a stale number nobody reset. A
  // center-line has to track the cursor at every position (including
  // dead center, where the old code never updated anything), so that
  // accident stops existing on its own. `computeIndicator`
  // (radial-indicator.ts) makes it an explicit rule instead: remember the
  // last item the cursor was confirmed near (same `RING_BAND` test, now
  // read as "which item" rather than "should I bother updating"), and
  // when the cursor leaves that band, point the line exactly at that
  // item's own angle — not just wherever the cursor's raw angle happened
  // to be last, the actual bug-shaped behavior before. Before the cursor
  // has ever been in the band, nothing renders, same as before.
  const [indicator, setIndicator] = useState<{ display: IndicatorDisplay; lastPointedIndex: number | null }>({
    display: { visible: false },
    lastPointedIndex: null,
  });
  const [level, setLevel] = useState<Level>("root");

  const { missing } = useAgentAvailability();
  // A lista COMPLETA vem do hook que já existe (não de um segundo caminho): é
  // dela que sai a prontidão de cada provider (task 1777060e).
  const all = useAvailableAgentProviders();
  // A prontidão viaja junto (task 1777060e): `not-ready` NÃO desabilita o item —
  // o humano ainda pode abrir o card e autenticar por dentro; o que muda é a
  // frase, que passa a dizer POR QUE ele não vai funcionar.
  const providerItems = deriveRadialProviderItems(providers, missing, all);

  // Item 2 — "Terminal" no radial precisa de um passo a mais": clicking it
  // no longer fires `onSelect` immediately (which used to spawn a bash
  // terminal straight away) — it swaps the SAME ring into the provider
  // list instead (no concentric outer ring, no separate popover), the
  // rest of the terminal-vs-other-spawn-action flow stays exactly as
  // before once a provider is actually chosen.
  const itemCount = level === "root" ? ACTIONS.length : providerItems.length + 1; // +1 for "voltar"
  // `center` is where the ring ACTUALLY renders — see this component's
  // own `x`/`y` doc comment above and `resolveRingGeometry`'s doc
  // comment (radial-ring-geometry.ts) for why it can differ from the
  // requested `(x, y)` near a window edge. Every use of "the menu's
  // position" below is `center`, never the raw `x`/`y` props.
  const center = resolveRingGeometry(x, y, itemCount, window.innerWidth, window.innerHeight);
  const { radius, itemSize } = center;
  const overlay = radius + OVERLAY_PAD;

  function goToLevel(next: Level) {
    // Sector geometry (item count, angles) changes between levels, so the
    // "last pointed item" from one level has no meaning in the other —
    // reset rather than carry over a stale index into the new ring.
    setIndicator({ display: { visible: false }, lastPointedIndex: null });
    setLevel(next);
  }

  function handlePointerMove(e: React.PointerEvent) {
    const dx = e.clientX - center.x;
    const dy = e.clientY - center.y;
    setIndicator((prev) => {
      const next = computeIndicator(dx, dy, itemCount, radius, RING_BAND, prev.lastPointedIndex);
      return next;
    });
  }

  function renderIndicator() {
    const display = indicator.display;
    if (!display.visible) return null;
    const cx = overlay;
    const cy = overlay;
    const ex = cx + Math.cos(display.angle) * display.length;
    const ey = cy + Math.sin(display.angle) * display.length;
    return (
      <svg className="radial-indicator" width={overlay * 2} height={overlay * 2} style={{ left: -overlay, top: -overlay }}>
        <line x1={cx} y1={cy} x2={ex} y2={ey} />
      </svg>
    );
  }

  function renderRootItems() {
    return ACTIONS.map(({ action, icon, labelKey, group, tool: itemTool }, i) => {
      const angle = itemAngle(i, ACTIONS.length);
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;
      const isActiveTool = group === "tool" && itemTool === tool;
      return (
        <button
          key={action}
          className={`radial-item radial-item--${group}${isActiveTool ? " active" : ""}`}
          title={t(labelKey)}
          // Custom properties, not a plain `transform` — the open
          // animation (layout.css) also animates `transform` (a scale
          // pop), and setting the position via `transform` directly
          // here would get clobbered by the keyframe for the
          // animation's duration, making every item flash at the
          // menu's center before snapping to its real spot. `--item-size`
          // (layout.css's `.radial-item` reads it; computed by
          // `itemSizeFor`, radial-ring-geometry.ts) only shrinks below
          // its default 40px in the rare case where even a CLAMPED,
          // on-screen ring doesn't fit the viewport — a genuinely tiny
          // window, not merely a click near a normal window's edge (that
          // case is handled by moving the ring's center, not shrinking
          // it — see `resolveRingGeometry`'s doc comment).
          style={{ "--tx": `${dx}px`, "--ty": `${dy}px`, "--item-size": `${itemSize}px` } as React.CSSProperties}
          onClick={() => (action === "terminal" ? goToLevel("terminal-providers") : onSelect(action))}
        >
          <Icon name={icon} size={17} />
        </button>
      );
    });
  }

  // Review suggested hiding an uninstalled provider instead to save the
  // ring's space; DELIBERATELY KEPT disabled-but-visible instead (repo
  // owner's call, against that recommendation — flagging it here since
  // it'll get questioned again): hiding a provider changes WHICH ANGLE
  // every provider after it lands on, and a radial menu lives on muscle
  // memory — a stable, inert target beats one that moves depending on
  // what happens to be installed on this machine.
  function renderProviderItems() {
    const items = [...providerItems, null]; // null marks the trailing "voltar" slot
    return items.map((item, i) => {
      const angle = itemAngle(i, items.length);
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;
      if (item === null) {
        return (
          <button
            key="back"
            className="radial-item radial-item--back"
            title={t("radial.back")}
            style={{ "--tx": `${dx}px`, "--ty": `${dy}px`, "--item-size": `${itemSize}px` } as React.CSSProperties}
            onClick={() => goToLevel("root")}
          >
            <Icon name="back" size={17} />
          </button>
        );
      }
      return (
        <button
          key={item.id}
          className={`radial-item radial-item--spawn${item.installed ? "" : " radial-item--disabled"}`}
          title={
            // `null` = nada de especial a dizer, e o tooltip é o id — que é
            // EXATAMENTE o que a tela fazia antes desta task. Todo provider
            // nativo fica em `unknown` (nenhum declara probe), então converter
            // `unknown` em texto encheria o radial de ruído: a propriedade é
            // testada em `radial-providers.test.ts` (radialProviderTitle).
            radialProviderTitle(item, t) ?? item.id
          }
          disabled={!item.installed}
          style={{ "--tx": `${dx}px`, "--ty": `${dy}px`, "--item-size": `${itemSize}px` } as React.CSSProperties}
          onClick={() => item.installed && onSelect("terminal", item.id)}
        >
          <Icon name={PROVIDER_ICON[item.id] ?? "providerBash"} size={17} />
        </button>
      );
    });
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
    //
    // Closing on backdrop click stays the same gesture at BOTH levels
    // (root ring and the item-2 provider submenu) — `onClose` unmounts
    // this whole component regardless of `level`.
    <div
      className="radial-backdrop"
      onPointerDown={onClose}
      onPointerMove={handlePointerMove}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="radial-menu" style={{ left: center.x, top: center.y }} onPointerDown={(e) => e.stopPropagation()}>
        {renderIndicator()}
        {level === "root" ? renderRootItems() : renderProviderItems()}
        <div className="radial-center" />
      </div>
    </div>
  );
}
