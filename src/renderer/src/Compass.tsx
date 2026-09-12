import { memo, useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import { Icon, type IconName } from "./icons";
import { isInView, type Rect } from "./board-model";
import type { Card } from "./card-types";

/** SEM teto estético de largura (decisão do dono do repo, 2026-09-09,
 * revertendo uma tentativa anterior de teto "justificado" em 960px): a
 * fita usa TODO o espaço realmente livre entre os vizinhos da topbar
 * (`availableRight - availableLeft`, só limitado por `MIN_STRIP_WIDTH`
 * como piso e pelo clamp contra os vizinhos — nenhum limite superior).
 * Razão do próprio dono: a fita representa 360° dobrados numa linha, e
 * largura É resolução angular — mais largo separa melhor rumos parecidos,
 * que é a razão de existir de uma bússola. Antes disso existiu uma
 * constante fixa (460, depois 960) que travava a fita mesmo com a topbar
 * cheia de espaço vazio dos dois lados — era exatamente o sintoma
 * relatado ao vivo (2026-09-09, screenshot com ~2400px livres).
 *
 * Não há teto nem mesmo de SANIDADE (ex. pra telas ultrawide de 5000px+):
 * o custo de `computeCompassLayout` é O(candidatos mostrados), não O(px)
 * — os loops de empacotamento abaixo iteram sobre `positioned.length`
 * (no máximo dezenas de chips), nunca sobre a largura em pixels. Uma fita
 * de 5000px não custa mais CPU que uma de 500px, então não há cálculo
 * "absurdo" a evitar; um teto artificial só reintroduziria o problema que
 * acabou de ser removido. */
/** Piso pra fita nunca desaparecer de vez numa janela genuinamente
 * apertada — cabe pelo menos ~3 chips compactos + o "+N". */
export const MIN_STRIP_WIDTH = 110;
/** Respiro entre a fita e o vizinho mais próximo de cada lado. */
export const OUTER_GAP = 16;
/** Respiro mínimo entre as BORDAS reais de dois chips vizinhos (não entre
 * os centros — largura de chip varia com o rótulo, então um respiro fixo
 * de centro-a-centro só funciona por acaso; foi o que colidiu no relato
 * ao vivo, 2026-09-06: 2 chips de rótulo comprido se sobrepunham quase
 * inteiros com um "gap" de centro fixo). */
export const GAP = 6;
/** Teto absoluto de chips no modo completo, mesmo que a soma de larguras
 * ainda coubesse — muitos chips completos ficam ilegíveis bem antes de
 * genuinamente não caberem mais (mesmo espírito de um jogo real: a
 * bússola limita quantos pontos de interesse mostra em detalhe). */
export const FULL_HARD_CAP = 6;
/** Modo compacto: chip circular de largura fixa — permite calcular quantos
 * cabem na fita sem depender de medir texto nenhum. */
export const COMPACT_CHIP_W = 26;
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

export type Positioned<T> = T & { x: number; w: number };

export interface CompassLayoutOptions {
  titleRight: number | null;
  zoomPillLeft: number | null;
  windowInnerWidth: number;
}

export interface CompassLayoutResult<T> {
  stripWidth: number;
  stripLeft: number;
  compact: boolean;
  positioned: Positioned<T>[];
  hiddenCount: number;
}

/**
 * Núcleo PURO da geometria da bússola — sem DOM, sem React. Recebe os
 * candidatos já ordenados por distância (mais perto primeiro, cada um com
 * `bearing` e `label` resolvidos) e as bordas livres da topbar, e decide:
 * largura/posição da fita, modo (completo/compacto), quantos chips cabem,
 * e a posição X final de cada um já sem sobreposição (empacotamento
 * "bolinha de gude" com clamps de borda). Extraído do corpo do componente
 * pra poder testar esse cálculo — inclusive o uso do espaço livre inteiro
 * (sem teto, ver comentário acima de `MIN_STRIP_WIDTH`) e a decisão de
 * modo que isso afeta — sem montar React nem abrir o app
 * (mesmo motivo de `board-model.ts`/`mask-buffer.ts`: `vitest` roda em
 * `environment: node`, sem DOM).
 */
export function computeCompassLayout<T extends { bearing: number; label: string }>(
  all: T[],
  { titleRight, zoomPillLeft, windowInnerWidth }: CompassLayoutOptions,
): CompassLayoutResult<T> {
  // Espaço realmente livre entre os vizinhos da topbar (ou a janela
  // inteira, se algum dos dois ainda não montou). `stripWidth` é o teto
  // que TODO o resto da função usa em vez da constante fixa antiga —
  // encolhe sozinho quando o breadcrumb ou a área de zoom crescem, em
  // vez de desenhar por cima deles. `stripLeft` centraliza a fita dentro
  // desse espaço livre (não mais 50% da JANELA) — o mesmo empacotamento
  // "bolinha de gude" abaixo (empurra + clampa nas duas pontas) já lida
  // com acumulação quando `stripWidth` encolhe o bastante pra apertar os
  // chips, sem nunca invadir o vizinho.
  const availableLeft = (titleRight ?? 0) + OUTER_GAP;
  const availableRight = (zoomPillLeft ?? windowInnerWidth) - OUTER_GAP;
  const stripWidth = Math.max(MIN_STRIP_WIDTH, availableRight - availableLeft);
  const idealLeft = (windowInnerWidth - stripWidth) / 2;
  const stripLeft = Math.min(Math.max(idealLeft, availableLeft), Math.max(availableLeft, availableRight - stripWidth));

  // Decide o modo pela largura REAL projetada, não só pela contagem — um
  // punhado de rótulos compridos pode não caber mesmo sendo "poucos"
  // (achado ao vivo, 2026-09-06: 4 chips, 2 com rumo próximo, já
  // colidiam). Testa o modo completo com os `FULL_HARD_CAP` mais
  // próximos: só usa completo se ELES cabem de verdade lado a lado.
  const fullCandidates = all.slice(0, FULL_HARD_CAP);
  const fullTotalWidth =
    fullCandidates.reduce((sum, c) => sum + estimateFullChipWidth(c.label), 0) + Math.max(0, fullCandidates.length - 1) * GAP;
  const compact = all.length > FULL_HARD_CAP || fullTotalWidth > stripWidth;

  // Quantos cabem na fita, dado o modo: completo usa os candidatos já
  // testados acima; compacto tem largura uniforme, então dá pra calcular
  // direto quantos cabem — os mais próximos entram primeiro (`all` já
  // ordenado por `dist`).
  const maxShown = compact ? Math.floor((stripWidth - MORE_CHIP_RESERVED) / (COMPACT_CHIP_W + GAP)) : fullCandidates.length;
  const shown = all.slice(0, Math.max(1, maxShown));
  const hiddenCount = all.length - shown.length;
  const effectiveWidth = hiddenCount > 0 ? stripWidth - MORE_CHIP_RESERVED : stripWidth;

  // `bearing` 0° -> t=0.5 (centro), +180°/-180° -> t=1/t=0 (as duas
  // pontas, mesma direção física "oeste").
  const positioned: Positioned<T>[] = shown
    .map((c) => ({
      ...c,
      x: (0.5 + c.bearing / 360) * effectiveWidth,
      w: compact ? COMPACT_CHIP_W : estimateFullChipWidth(c.label),
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

  return { stripWidth, stripLeft, compact, positioned, hiddenCount };
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
 * - **Compacto** (muitos cards): botão circular de largura FIXA — sem
 *   largura fixa, calcular quantos cabem na fita exigiria medir texto
 *   renderizado de verdade (layout em duas passagens). Decisão do
 *   coordenador (2026-09-09, revisão do pedido ao vivo): o conteúdo
 *   visual é a SETA girada pro rumo exato, mesma convenção de rotação do
 *   modo completo — antes era só o ícone do tipo de card, sem seta
 *   nenhuma, o que tira de uma bússola compacta exatamente a informação
 *   que a define (a direção). O tipo de card sai do visual e vai pro
 *   `title`/`aria-label` junto do nome — continua acessível, só não ocupa
 *   espaço no chip. Distância continua opacidade (perto = opaco, longe =
 *   apagado) em vez de anéis, pra não gastar largura nenhuma. Mesmo
 *   assim, com MUITOS cards (20+) ainda cabe só um tanto — o resto vira
 *   um chip "+N" de resumo, igual ao modo completo.
 */
/** Mede a borda real dos dois vizinhos que compartilham a linha da topbar
 * com a bússola — `.topbar-title` (breadcrumb + contagem de agentes, à
 * esquerda) e `.zoom-pill` (aviso de CLI + zoom, à direita) — pra nunca
 * desenhar a fita por cima deles. Um `ResizeObserver` em cada um cobre
 * tanto resize de janela quanto o texto do próprio breadcrumb mudando de
 * largura (nome de board editado, contagem de agentes ganhando um
 * dígito, badge "autônomo" aparecendo) sem precisar re-medir a cada
 * render da bússola. Ausência de qualquer um dos dois (DOM ainda não
 * montado, ou um teste isolado sem Topbar real) degrada pra `null` —
 * tratado como "sem vizinho para evitar" nos limites abaixo. */
function useTopbarNeighborBounds(): { titleRight: number | null; zoomPillLeft: number | null } {
  const [bounds, setBounds] = useState<{ titleRight: number | null; zoomPillLeft: number | null }>({
    titleRight: null,
    zoomPillLeft: null,
  });

  useEffect(() => {
    const titleEl = document.querySelector(".topbar-title");
    const zoomEl = document.querySelector(".zoom-pill");
    const measure = () => {
      setBounds({
        titleRight: titleEl ? titleEl.getBoundingClientRect().right : null,
        zoomPillLeft: zoomEl ? zoomEl.getBoundingClientRect().left : null,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (titleEl) ro.observe(titleEl);
    if (zoomEl) ro.observe(zoomEl);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return bounds;
}

export const Compass = memo(function Compass({
  cards,
  visibleRect,
  kindIcon,
  kindLabel,
  cardLabel,
  onFocusCard,
}: {
  cards: Card[];
  visibleRect: Rect;
  kindIcon: Record<string, IconName>;
  kindLabel: Record<string, string>;
  /** Same display-only identity shown in CardFrame/Rail. Keeping this as a
   * callback avoids Compass inventing a third fallback for unnamed cards. */
  cardLabel?: (id: string) => string;
  onFocusCard: (id: string) => void;
}) {
  const { titleRight, zoomPillLeft } = useTopbarNeighborBounds();
  const vpCenterX = visibleRect.x + visibleRect.w / 2;
  const vpCenterY = visibleRect.y + visibleRect.h / 2;
  const vpDiagonal = Math.hypot(visibleRect.w, visibleRect.h);

  const all = cards
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
    .sort((a, b) => a.dist - b.dist)
    // `label` resolvido aqui, uma vez, pra `computeCompassLayout` (função
    // PURA, sem acesso a `kindLabel`) poder medir largura de chip sem
    // conhecer a forma de `Card`.
    .map((c): Candidate & { label: string } => ({
      ...c,
      label: cardLabel?.(c.card.id) ?? c.card.label ?? kindLabel[c.card.kind] ?? c.card.kind,
    }));

  if (all.length === 0) return null;

  const { stripWidth, stripLeft, compact, positioned, hiddenCount } = computeCompassLayout(all, {
    titleRight,
    zoomPillLeft,
    windowInnerWidth: window.innerWidth,
  });

  return (
    <div
      className="compass-strip"
      data-role="compass"
      data-compact={compact}
      aria-label={t("compass.offscreen")}
      style={{ left: `${stripLeft}px`, width: `${stripWidth}px` }}
    >
      {positioned.map(({ card, dist, bearing, x, label }) => {
        const tier = distanceTier(dist, vpDiagonal);
        const icon = kindIcon[card.kind] ?? "terminal";
        const kindName = kindLabel[card.kind] ?? card.kind;
        return compact ? (
          <button
            key={card.id}
            type="button"
            className="compass-chip compass-chip-compact"
            data-role="compass-chip"
            style={{ left: `${x}px`, opacity: tier === 3 ? 1 : tier === 2 ? 0.7 : 0.45 }}
            title={t("compass.focus", { label, kind: kindName })}
            aria-label={t("compass.focusOff", { label, kind: kindName })}
            onClick={() => onFocusCard(card.id)}
          >
            <span className="compass-arrow compass-arrow-compact" style={{ transform: `rotate(${bearing}deg)` }}>
              <Icon name="chevronRight" size={13} />
            </span>
          </button>
        ) : (
          <button
            key={card.id}
            type="button"
            className="compass-chip"
            data-role="compass-chip"
            style={{ left: `${x}px` }}
            title={t("compass.focusSimple", { label })}
            aria-label={t("compass.focusSimpleOff", { label })}
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
        <span className="compass-more" title={t("compass.moreHidden", { count: hiddenCount })}>
          +{hiddenCount}
        </span>
      )}
    </div>
  );
});
