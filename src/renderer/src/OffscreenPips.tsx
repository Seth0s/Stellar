import { memo } from "react";
import { Icon, type IconName } from "./icons";
import { isInView, type Rect, type WorldTransform } from "./board-model";
import type { Card } from "./card-types";

export type OffscreenPipInfo = {
  card: Card;
  edge: "left" | "right";
  /** Distância até a borda da calha que o pip ocupa — vira `left` na calha
   * esquerda e `right` na direita. Ancorar pelo lado certo, em vez de
   * empurrar com `translateX(-100%)`, é o que mantém a pílula dentro da
   * janela: ver o comentário sobre a matriz travada mais abaixo. */
  inset: number;
  screenY: number;
  /** Rumo REAL até o card, em graus, 0° apontando pra direita — a seta é
   * girada por ele. Pedido ao vivo (2026-09-01): empilhar nas laterais
   * "mas com setas indicativas na direção exata". Sem isto, encostar tudo
   * na lateral perderia a única informação de direção que o pip carrega. */
  bearing: number;
  icon: IconName;
  label: string;
};

/** Altura do pill (cards.css) e respiro entre eles na trilha. */
const PIP_HEIGHT = 26;
const PIP_GAP = 8;

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

  /**
   * Pedido ao vivo (2026-09-01): "os indicadores de card devem ficar no
   * canto da tela e não flutuando no meio".
   *
   * O desenho anterior era um radar de verdade — interseção raio-caixa a
   * partir do centro do viewport, então o pip parava EXATAMENTE onde a
   * direção do card cruzava a moldura. Geometricamente correto e, na
   * prática, ruim: um card acima da tela cai na borda de cima com um x
   * qualquer, ou seja, uma pílula pousada no meio horizontal, por cima do
   * conteúdo do card que a pessoa está lendo. Com vários, viram uma fileira
   * de balões atravessando a tela (foi assim que apareceu no relato).
   *
   * Agora cada pip vai pra trilha lateral do lado em que o card está e
   * empilha ali. O que se perde da posição exata volta pela SETA, girada
   * pelo rumo real até o card — a direção continua legível, só deixa de
   * custar o meio da tela.
   */
  const candidates = offscreenCards
    .map((card) => {
      const cardCenterX = world.panX + (card.rect.x + card.rect.w / 2) * world.zoom;
      const cardCenterY = world.panY + (card.rect.y + card.rect.h / 2) * world.zoom;
      const dx = cardCenterX - vpCenterX;
      const dy = cardCenterY - vpCenterY;
      return { card, dx, dy, cardCenterY };
    })
    // Um card exatamente sob o centro não tem direção pra apontar.
    .filter(({ dx, dy }) => Math.abs(dx) >= 0.001 || Math.abs(dy) >= 0.001);

  // Empate em dx === 0 (card puramente acima/abaixo) vai pra direita, que é
  // o lado sem a Rail — mesma razão de `minX` existir.
  const rails: Record<"left" | "right", typeof candidates> = {
    left: candidates.filter(({ dx }) => dx < 0),
    right: candidates.filter(({ dx }) => dx >= 0),
  };

  const pips: OffscreenPipInfo[] = [];

  for (const edge of ["left", "right"] as const) {
    const rail = rails[edge].slice().sort((a, b) => a.cardCenterY - b.cardCenterY);
    if (rail.length === 0) continue;
    // Passo comprimido quando não cabe: melhor uma trilha densa do que
    // pílulas escapando pra fora da área útil (ou empilhadas no mesmo px).
    const available = maxY - minY - PIP_HEIGHT;
    const wanted = PIP_HEIGHT + PIP_GAP;
    const step = rail.length > 1 ? Math.min(wanted, available / (rail.length - 1)) : 0;

    rail.forEach(({ card, dx, dy }, i) => {
      pips.push({
        card,
        edge,
        inset: edge === "left" ? minX : vw - maxX,
        screenY: minY + PIP_HEIGHT / 2 + i * step,
        bearing: (Math.atan2(dy, dx) * 180) / Math.PI,
        icon: kindIcon[card.kind] ?? "terminal",
        label: card.label ?? kindLabel[card.kind] ?? card.kind,
      });
    });
  }

  return (
    <div className="offscreen-pips-layer" aria-label="Cards fora da tela">
      {pips.map(({ card, edge, inset, screenY, bearing, icon, label }) => {
        // `chevronRight` aponta pra 0°, então o rumo entra como rotação
        // direta. Uma seta girada diz mais que quatro chevrons fixos: um
        // card acima e à esquerda aponta pra cima-esquerda de verdade.
        const arrow = (
          <span className="offscreen-pip-arrow" style={{ transform: `rotate(${bearing}deg)` }}>
            <Icon name="chevronRight" size={11} />
          </span>
        );
        return (
          <button
            key={card.id}
            type="button"
            className={`offscreen-pip edge-${edge}`}
            /* Ancora pelo lado da própria calha. A versão anterior punha
               tudo em `left` e corrigia com `translateX` num
               `var(--pip-shift)`, e o Chromium deixava a matriz travada no
               valor antigo quando a var mudava com `transform` na lista de
               `transition`: computed `--pip-shift: -100%` e, ao mesmo
               tempo, `matrix(1, 0, 0, 1, 0, -13)`. Na prática, todo pip que
               trocava de calha ficava 94px pra fora da janela. Ancorar por
               `left`/`right` não tem esse estado intermediário pra errar. */
            style={{ ...(edge === "left" ? { left: `${inset}px` } : { right: `${inset}px` }), top: `${screenY}px` }}
            title={`Focar em ${label}`}
            aria-label={`Focar em ${label}`}
            onClick={() => onFocusCard(card.id)}
          >
            {edge === "left" && arrow}
            <span className="offscreen-pip-icon">
              <Icon name={icon} size={12} />
            </span>
            <span className="offscreen-pip-label">{label}</span>
            {edge === "right" && arrow}
          </button>
        );
      })}
    </div>
  );
});
