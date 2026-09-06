import { memo } from "react";
import { Icon, type IconName } from "./icons";
import { isInView, type Rect } from "./board-model";
import type { Card } from "./card-types";

/** Largura da fita (cards.css/layout.css). */
const STRIP_WIDTH = 460;
/** Respiro mínimo entre as BORDAS reais de dois chips vizinhos (não entre
 * os centros — largura de chip varia com o rótulo, então um respiro fixo
 * de centro-a-centro só funciona por acaso; foi o que colidiu no relato
 * ao vivo, 2026-09-06: 2 chips de rótulo comprido se sobrepunham quase
 * inteiros com um "gap" de centro fixo). */
const GAP = 6;
/** Teto absoluto de chips no modo completo, mesmo que a soma de larguras
 * ainda coubesse — muitos chips completos ficam ilegíveis bem antes de
 * genuinamente não caberem mais (mesmo espírito de um jogo real: a
 * bússola limita quantos pontos de interesse mostra em detalhe). */
const FULL_HARD_CAP = 6;
/** Modo compacto: chip circular de largura fixa — permite calcular quantos
 * cabem na fita sem depender de medir texto nenhum. */
const COMPACT_CHIP_W = 26;
/** Espaço reservado pro chip "+N" quando a lista trunca, pra ele nunca
 * ficar em cima do último chip real (ambos são `position: absolute`
 * dentro da mesma fita, ver layout.css). */
const MORE_CHIP_RESERVED = 40;

type Candidate = { card: Card; dx: number; dy: number; dist: number; bearing: number };
type Tier = 1 | 2 | 3;

/** Estimativa de largura (px) de um chip NO MODO COMPLETO, sem medir o DOM
 * de verdade — precisa só ser boa o bastante pra espaçar sem sobrepor,
 * não pixel-perfect. Termos correspondem 1:1 aos elementos renderizados
 * abaixo (seta, ícone, rótulo até `.compass-label`'s max-width real de
 * 80px, selo de anéis) mais o padding horizontal do `.compass-chip`. */
function estimateFullChipWidth(label: string): number {
  const PADDING = 16; // 8px de cada lado
  const ARROW = 15; // ícone (11) + gap (4)
  const ICON = 16; // ícone (12) + gap (4)
  const LABEL = Math.min(label.length * 6, 80) + 4; // ~6px/char, teto = max-width real da CSS
  const RINGS = 16; // 3 bolinhas de 4px + 2 gaps de 2px
  return PADDING + ARROW + ICON + LABEL + RINGS;
}

function distanceTier(dist: number, vpDiagonal: number): Tier {
  if (dist <= vpDiagonal) return 3;
  if (dist <= vpDiagonal * 2.5) return 2;
  return 1;
}

/**
 * Guia de localização de cards (2026-09-04, ideia do usuário), estilo
 * bússola horizontal de jogo — pedido ao vivo (2026-09-06): "um estilo
 * que você encontra em jogos, uma bússola horizontal com níveis de
 * distância [...] ícones clicáveis (e setas direcionando mostrando
 * nome)", depois ajustada de novo no mesmo dia pra escalar com muitos
 * cards fora da tela ao mesmo tempo ("imagina pra 20 cards diferentes,
 * deve ter uma organização") — ver `FULL_HARD_CAP` acima.
 *
 * A fita representa o círculo de 360° inteiro dobrado numa linha —
 * `bearing` 0° (rumo "leste"/direita, mesma convenção de `Math.atan2` já
 * usada aqui) cai no CENTRO da fita; ±180° (rumo "oeste"/esquerda) cai nas
 * DUAS pontas — a mesma direção física, só que a linha reta não tem como
 * representar um círculo sem abrir ele em algum ponto (mesma ideia da
 * bússola horizontal de um jogo: o que está "atrás" aparece nas pontas).
 *
 * Dois modos, escolhidos pela QUANTIDADE de cards fora da tela (não por
 * card individual — a fita inteira troca junto, senão a mistura de
 * tamanhos de chip complica o espaçamento em vez de simplificar):
 * - **Completo** (poucos cards): ícone + seta girada pro rumo EXATO +
 *   nome + selo de anéis pra distância (mais anéis preenchidos = mais
 *   perto, como barras de sinal). Medida sempre a partir do centro da
 *   viewport ATUAL — pedido explícito do usuário, não do centro fixo do
 *   board inteiro.
 * - **Compacto** (muitos cards): só o ícone do tipo de card, num botão
 *   circular de largura FIXA — sem isso, calcular quantos cabem na fita
 *   exigiria medir texto renderizado de verdade (layout em duas
 *   passagens). Distância vira opacidade do ícone (perto = opaco, longe =
 *   apagado) em vez de anéis, pra não gastar largura nenhuma; nome
 *   continua acessível no tooltip (`title`) ao passar o mouse. Mesmo
 *   assim, com MUITOS cards (20+) ainda cabe só um tanto — o resto vira
 *   um chip "+N" de resumo, igual ao modo completo.
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

  // Decide o modo pela largura REAL projetada, não só pela contagem — um
  // punhado de rótulos compridos pode não caber mesmo sendo "poucos"
  // (achado ao vivo, 2026-09-06: 4 chips, 2 com rumo próximo, já
  // colidiam). Testa o modo completo com os `FULL_HARD_CAP` mais
  // próximos: só usa completo se ELES cabem de verdade lado a lado.
  const fullCandidates = all.slice(0, FULL_HARD_CAP);
  const fullTotalWidth =
    fullCandidates.reduce((sum, c) => sum + estimateFullChipWidth(c.card.label ?? kindLabel[c.card.kind] ?? c.card.kind), 0) +
    Math.max(0, fullCandidates.length - 1) * GAP;
  const compact = all.length > FULL_HARD_CAP || fullTotalWidth > STRIP_WIDTH;

  // Quantos cabem na fita, dado o modo: completo usa os candidatos já
  // testados acima; compacto tem largura uniforme, então dá pra calcular
  // direto quantos cabem — os mais próximos entram primeiro (`all` já
  // ordenado por `dist`).
  const maxShown = compact ? Math.floor((STRIP_WIDTH - MORE_CHIP_RESERVED) / (COMPACT_CHIP_W + GAP)) : fullCandidates.length;
  const shown = all.slice(0, Math.max(1, maxShown));
  const hiddenCount = all.length - shown.length;
  const effectiveWidth = hiddenCount > 0 ? STRIP_WIDTH - MORE_CHIP_RESERVED : STRIP_WIDTH;

  // `bearing` 0° -> t=0.5 (centro), +180°/-180° -> t=1/t=0 (as duas
  // pontas, mesma direção física "oeste").
  const positioned = shown
    .map((c) => ({
      ...c,
      x: (0.5 + c.bearing / 360) * effectiveWidth,
      w: compact ? COMPACT_CHIP_W : estimateFullChipWidth(c.card.label ?? kindLabel[c.card.kind] ?? c.card.kind),
    }))
    .sort((a, b) => a.x - b.x);

  // Empacotamento em 1D com largura REAL de cada chip (não um espaço fixo
  // de centro-a-centro, que foi exatamente o bug relatado ao vivo — 2
  // chips de rótulo comprido se sobrepondo quase inteiros). Duas
  // varreduras, técnica padrão pra "n itens, respiro mínimo, encaixar num
  // intervalo": só uma passada (empurra pra direita) resolve a
  // sobreposição local mas pode estourar a borda direita se os itens
  // já nasceram perto dela; um clamp por-item DEPOIS disso (a versão
  // anterior) desfaz o espaçamento e reintroduz a MESMA sobreposição que
  // deveria evitar — foi o bug real visto ao vivo.
  //
  // 1) esquerda -> direita: empurra o de trás quando encostaria no da
  //    frente.
  for (let i = 1; i < positioned.length; i++) {
    const prev = positioned[i - 1];
    const cur = positioned[i];
    const minCenter = prev.x + prev.w / 2 + GAP + cur.w / 2;
    if (cur.x < minCenter) cur.x = minCenter;
  }
  // 2) clamp só o ÚLTIMO na borda direita, se a varredura acima o
  //    empurrou além dela.
  const lastIdx = positioned.length - 1;
  if (lastIdx >= 0) positioned[lastIdx].x = Math.min(positioned[lastIdx].x, effectiveWidth - positioned[lastIdx].w / 2);
  // 3) direita -> esquerda: propaga essa borda de volta pra trás,
  //    puxando qualquer chip que ainda encostaria no vizinho já
  //    ajustado — sem isso, um item no meio da fita ficaria colado no
  //    último em vez de manter o respiro mínimo.
  for (let i = lastIdx - 1; i >= 0; i--) {
    const next = positioned[i + 1];
    const cur = positioned[i];
    const maxCenter = next.x - next.w / 2 - GAP - cur.w / 2;
    if (cur.x > maxCenter) cur.x = maxCenter;
  }
  // 4) só resta o PRIMEIRO poder ter sido puxado além da borda esquerda —
  //    acontece apenas se a soma total de larguras genuinamente não
  //    coubesse na fita (o teste de largura acima deveria ter trocado
  //    pro modo compacto antes disso; este é só o último resort).
  if (positioned.length > 0) positioned[0].x = Math.max(positioned[0].x, positioned[0].w / 2);

  return (
    <div className="compass-strip" data-role="compass" data-compact={compact} aria-label="Cards fora da tela">
      {positioned.map(({ card, dist, bearing, x }) => {
        const label = card.label ?? kindLabel[card.kind] ?? card.kind;
        const tier = distanceTier(dist, vpDiagonal);
        const icon = kindIcon[card.kind] ?? "terminal";
        return compact ? (
          <button
            key={card.id}
            type="button"
            className="compass-chip compass-chip-compact"
            data-role="compass-chip"
            style={{ left: `${x}px`, opacity: tier === 3 ? 1 : tier === 2 ? 0.7 : 0.45 }}
            title={`Focar em ${label}`}
            aria-label={`Focar em ${label}, fora da tela`}
            onClick={() => onFocusCard(card.id)}
          >
            <Icon name={icon} size={13} />
          </button>
        ) : (
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
              <Icon name={icon} size={12} />
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
