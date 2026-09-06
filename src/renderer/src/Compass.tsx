import { memo, useState } from "react";
import { Icon, type IconName } from "./icons";
import { isInView, type Rect } from "./board-model";
import type { Card } from "./card-types";

/**
 * Guia de localização de cards (2026-09-04, ideia do usuário) — substitui
 * `OffscreenPips` (D3, "radar" espalhado nas calhas laterais). Pedido ao
 * vivo (2026-09-06): "aceito a bússola centralizada, será organizado —
 * antes ficava espalhado pela tela". Um único pill na topbar, sempre no
 * mesmo lugar, em vez de uma pilha por lado que cresce com o board.
 *
 * Com vários cards fora da tela: aponta pro mais PRÓXIMO do centro da
 * viewport primeiro; cada clique foca o alvo atual (via `jumpToCard`,
 * pan+raise) e avança pro próximo — visita todos em sequência sem abrir
 * lista nenhuma (decisão do usuário, 2026-09-06).
 */
export const Compass = memo(function Compass({
  cards,
  visibleRect,
  kindIcon,
  kindLabel,
  onFocusCard,
}: {
  cards: Card[];
  visibleRect: Rect;
  kindIcon: Record<string, IconName>;
  kindLabel: Record<string, string>;
  onFocusCard: (id: string) => void;
}) {
  // Conta cliques, não um índice direto — a lista de candidatos muda de
  // tamanho a cada render (cards saem/entram de vista, fecham), então o
  // módulo é tirado NA HORA do render atual em vez de guardar um índice
  // que ficaria fora dos limites assim que a lista encolhesse.
  const [cycle, setCycle] = useState(0);

  const vpCenterX = visibleRect.x + visibleRect.w / 2;
  const vpCenterY = visibleRect.y + visibleRect.h / 2;

  // `visibleRect` e `card.rect` já vivem no mesmo espaço (mundo) —
  // diferente do OffscreenPips (que precisava de posição EXATA em pixels
  // de tela pra empilhar pips), aqui só o RUMO importa, e um zoom/pan
  // uniforme não muda ângulo nenhum, então nem precisa do `world`.
  const candidates = cards
    .filter((c) => !isInView(c.rect, visibleRect))
    .map((card) => {
      const cx = card.rect.x + card.rect.w / 2;
      const cy = card.rect.y + card.rect.h / 2;
      const dx = cx - vpCenterX;
      const dy = cy - vpCenterY;
      return { card, dx, dy, dist: Math.hypot(dx, dy) };
    })
    // Um card exatamente sob o centro não tem direção pra apontar.
    .filter(({ dx, dy }) => Math.abs(dx) >= 0.001 || Math.abs(dy) >= 0.001)
    .sort((a, b) => a.dist - b.dist);

  if (candidates.length === 0) return null;

  const activeIndex = cycle % candidates.length;
  const { card, dx, dy } = candidates[activeIndex];
  const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
  const label = card.label ?? kindLabel[card.kind] ?? card.kind;

  return (
    <button
      type="button"
      className="compass"
      data-role="compass"
      title={`Focar em ${label}${candidates.length > 1 ? ` — ${activeIndex + 1}/${candidates.length} cards fora da tela` : " — fora da tela"}`}
      aria-label={`Focar em ${label}, fora da tela`}
      onClick={() => {
        onFocusCard(card.id);
        setCycle((c) => c + 1);
      }}
    >
      <span className="compass-arrow" style={{ transform: `rotate(${bearing}deg)` }}>
        <Icon name="chevronRight" size={13} />
      </span>
      <span className="compass-icon">
        <Icon name={kindIcon[card.kind] ?? "terminal"} size={13} />
      </span>
      <span className="compass-label">{label}</span>
      {candidates.length > 1 && <span className="compass-count">{candidates.length}</span>}
    </button>
  );
});
