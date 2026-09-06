import { memo } from "react";
import { Icon, type IconName } from "./icons";
import { isInView, type Rect } from "./board-model";
import type { Card } from "./card-types";

/** Largura da fita (cards.css/layout.css). */
const STRIP_WIDTH = 460;
/** Espaço mínimo entre dois ícones vizinhos antes de empurrar um pra não
 * sobrepor o outro — mesmo espírito do `centeredSlot`'s ring search
 * (board-model.ts), só que numa fita 1D em vez de um plano 2D. */
const MIN_GAP = 50;
/** Além disso, mostra "+N" em vez de espalhar dezenas de ícones minúsculos. */
const MAX_ICONS = 8;

type Candidate = { card: Card; dx: number; dy: number; dist: number; bearing: number };

/**
 * Guia de localização de cards (2026-09-04, ideia do usuário), estilo
 * bússola horizontal de jogo — pedido ao vivo (2026-09-06), depois de uma
 * 1ª versão (pill único, cicla um alvo por vez) não ser o que o usuário
 * tinha em mente: "um estilo que você encontra em jogos, uma bússola
 * horizontal com níveis de distância [...] ícones clicáveis (e setas
 * direcionando mostrando nome)".
 *
 * A fita representa o círculo de 360° inteiro dobrado numa linha —
 * `bearing` 0° (rumo "leste"/direita, mesma convenção de `Math.atan2` já
 * usada aqui) cai no CENTRO da fita; ±180° (rumo "oeste"/esquerda) cai nas
 * DUAS pontas — a mesma direção física, só que a linha reta não tem como
 * representar um círculo sem abrir ele em algum ponto (mesma ideia da
 * bússola horizontal de um jogo: o que está "atrás" aparece nas pontas).
 * Cada ícone carrega uma seta girada pro rumo EXATO (não só a posição na
 * fita, que já é contínua mas fica apertada visualmente) e um selo de
 * anéis pra distância (mais anéis preenchidos = mais perto, como barras de
 * sinal), medida sempre a partir do centro da viewport ATUAL — pedido
 * explícito do usuário, não do centro fixo do board inteiro.
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
  const vpCenterX = visibleRect.x + visibleRect.w / 2;
  const vpCenterY = visibleRect.y + visibleRect.h / 2;
  const vpDiagonal = Math.hypot(visibleRect.w, visibleRect.h);

  const all: Candidate[] = cards
    .filter((c) => !isInView(c.rect, visibleRect))
    .map((card) => {
      const cx = card.rect.x + card.rect.w / 2;
      const cy = card.rect.y + card.rect.h / 2;
      const dx = cx - vpCenterX;
      const dy = cy - vpCenterY;
      return { card, dx, dy, dist: Math.hypot(dx, dy), bearing: (Math.atan2(dy, dx) * 180) / Math.PI };
    })
    // Um card exatamente sob o centro não tem direção pra apontar.
    .filter(({ dx, dy }) => Math.abs(dx) >= 0.001 || Math.abs(dy) >= 0.001)
    .sort((a, b) => a.dist - b.dist);

  if (all.length === 0) return null;

  const shown = all.slice(0, MAX_ICONS);
  const hiddenCount = all.length - shown.length;

  // `bearing` 0° -> t=0.5 (centro), +180°/-180° -> t=1/t=0 (as duas
  // pontas, mesma direção física "oeste").
  const positioned = shown
    .map((c) => ({ ...c, x: (0.5 + c.bearing / 360) * STRIP_WIDTH }))
    .sort((a, b) => a.x - b.x);

  // Varredura simples esquerda->direita: empurra pra direita quando dois
  // ícones vizinhos ficariam mais perto que MIN_GAP, clampando na borda da
  // fita. Só resolve sobreposição LOCAL (não reabre espaço pro anterior),
  // suficiente pro tanto de ícones que MAX_ICONS já limita.
  for (let i = 1; i < positioned.length; i++) {
    const min = positioned[i - 1].x + MIN_GAP;
    if (positioned[i].x < min) positioned[i].x = Math.min(STRIP_WIDTH, min);
  }

  function distanceTier(dist: number): 1 | 2 | 3 {
    if (dist <= vpDiagonal) return 3;
    if (dist <= vpDiagonal * 2.5) return 2;
    return 1;
  }

  return (
    <div className="compass-strip" data-role="compass" aria-label="Cards fora da tela">
      {positioned.map(({ card, dist, bearing, x }) => {
        const label = card.label ?? kindLabel[card.kind] ?? card.kind;
        const tier = distanceTier(dist);
        return (
          <button
            key={card.id}
            type="button"
            className="compass-chip"
            data-role="compass-chip"
            style={{ left: `${x}px` }}
            title={`Focar em ${label}`}
            aria-label={`Focar em ${label}, fora da tela`}
            onClick={() => onFocusCard(card.id)}
          >
            <span className="compass-arrow" style={{ transform: `rotate(${bearing}deg)` }}>
              <Icon name="chevronRight" size={11} />
            </span>
            <span className="compass-icon">
              <Icon name={kindIcon[card.kind] ?? "terminal"} size={12} />
            </span>
            <span className="compass-label">{label}</span>
            <span className="compass-rings" aria-hidden="true">
              {[1, 2, 3].map((n) => (
                <span key={n} className={`compass-ring${n <= tier ? " filled" : ""}`} />
              ))}
            </span>
          </button>
        );
      })}
      {hiddenCount > 0 && (
        <span className="compass-more" title={`+${hiddenCount} card(s) fora da tela, não mostrados`}>
          +{hiddenCount}
        </span>
      )}
    </div>
  );
});
