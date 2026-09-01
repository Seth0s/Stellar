import { memo } from "react";
import { Icon, type IconName } from "./icons";
import { isInView, type Rect, type WorldTransform } from "./board-model";
import type { Card } from "./card-types";

export type OffscreenPipInfo = {
  card: Card;
  edge: "left" | "right" | "top" | "bottom";
  screenX: number;
  screenY: number;
  icon: IconName;
  label: string;
};

/**
 * D3 — Indicadores de Cards Fora da Tela (Offscreen Pips / Radar):
 * Projeta a direção de cards que estão fora do campo de visão atual
 * na borda da tela e renderiza mini-pills clicáveis para focar no card.
 */
export const OffscreenPips = memo(function OffscreenPips({
  cards,
  visibleRect,
  world,
  viewportSize,
  kindIcon,
  kindLabel,
  onFocusCard,
}: {
  cards: Card[];
  visibleRect: Rect;
  world: WorldTransform;
  viewportSize: { width: number; height: number };
  kindIcon: Record<string, IconName>;
  kindLabel: Record<string, string>;
  onFocusCard: (id: string) => void;
}) {
  const offscreenCards = cards.filter((c) => !isInView(c.rect, visibleRect));
  if (offscreenCards.length === 0) return null;

  const vw = viewportSize.width;
  const vh = viewportSize.height;

  // Limites da calha visível para os pips:
  // minX: 76px (livra a Rail e seu toggle)
  // maxX: vw - 24px
  // minY: 88px (livra a Titlebar e Topbar flutuante)
  // maxY: vh - 24px
  const minX = 76;
  const maxX = Math.max(minX + 40, vw - 24);
  const minY = 88;
  const maxY = Math.max(minY + 40, vh - 24);

  const vpCenterX = (minX + maxX) / 2;
  const vpCenterY = (minY + maxY) / 2;

  const pips: OffscreenPipInfo[] = [];

  for (const card of offscreenCards) {
    const cardCenterX = world.panX + (card.rect.x + card.rect.w / 2) * world.zoom;
    const cardCenterY = world.panY + (card.rect.y + card.rect.h / 2) * world.zoom;

    const dx = cardCenterX - vpCenterX;
    const dy = cardCenterY - vpCenterY;

    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) continue;

    // Interseção raio-caixa a partir do centro
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (maxX - vpCenterX) / dx);
    else if (dx < 0) t = Math.min(t, (minX - vpCenterX) / dx);

    if (dy > 0) t = Math.min(t, (maxY - vpCenterY) / dy);
    else if (dy < 0) t = Math.min(t, (minY - vpCenterY) / dy);

    if (!Number.isFinite(t) || t <= 0) continue;

    const rawX = vpCenterX + dx * t;
    const rawY = vpCenterY + dy * t;

    const screenX = Math.max(minX, Math.min(maxX, rawX));
    const screenY = Math.max(minY, Math.min(maxY, rawY));

    let edge: "left" | "right" | "top" | "bottom" = "right";
    const distToLeft = Math.abs(screenX - minX);
    const distToRight = Math.abs(screenX - maxX);
    const distToTop = Math.abs(screenY - minY);
    const distToBottom = Math.abs(screenY - maxY);

    const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);
    if (minDist === distToLeft) edge = "left";
    else if (minDist === distToRight) edge = "right";
    else if (minDist === distToTop) edge = "top";
    else edge = "bottom";

    const label = card.label ?? kindLabel[card.kind] ?? card.kind;
    const icon = kindIcon[card.kind] ?? "terminal";

    pips.push({ card, edge, screenX, screenY, icon, label });
  }

  return (
    <div className="offscreen-pips-layer" aria-label="Cards fora da tela">
      {pips.map(({ card, edge, screenX, screenY, icon, label }) => {
        const arrowIcon: IconName =
          edge === "left"
            ? "chevronLeft"
            : edge === "right"
            ? "chevronRight"
            : edge === "top"
            ? "chevronUp"
            : "chevronDown";

        return (
          <button
            key={card.id}
            type="button"
            className={`offscreen-pip edge-${edge}`}
            style={{ left: `${screenX}px`, top: `${screenY}px` }}
            title={`Focar em ${label}`}
            aria-label={`Focar em ${label}`}
            onClick={() => onFocusCard(card.id)}
          >
            {edge === "left" && <Icon name={arrowIcon} size={11} />}
            <span className="offscreen-pip-icon">
              <Icon name={icon} size={12} />
            </span>
            <span className="offscreen-pip-label">{label}</span>
            {edge !== "left" && <Icon name={arrowIcon} size={11} />}
          </button>
        );
      })}
    </div>
  );
});
