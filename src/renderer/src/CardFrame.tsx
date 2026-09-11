import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { worldRectToScreen, type Rect } from "./board-model";

/**
 * Shared drag/resize/z-order chrome for every board item kind. Pulled out of
 * TerminalCard once files/changes/sticky needed the exact same pointer math —
 * a header drag that moves `rect` in world units (divided by `zoom` so it
 * tracks the mouse 1:1 while zoomed) and a corner handle that resizes it,
 * both committing only on pointerup, never per frame.
 */
/** As 8 zonas de redimensionamento — 4 bordas e 4 cantos. A letra diz
 * quais bordas se movem: "nw" move a de cima e a da esquerda. */
type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
/** Mesmos mínimos que o punho único já aplicava — usados como piso pra
 * qualquer `kind` sem entrada própria em `KIND_MIN_SIZE` abaixo. */
const MIN_CARD_W = 160;
const MIN_CARD_H = 120;
/** Pendentes #188 — um piso único pra todo `kind` deixava um terminal
 * encolher até ilegível. Cards com conteúdo denso (texto/código, canvas
 * de página real) ganham um piso maior; sticky/stroke (nota solta, forma
 * livre) continuam no mínimo global. */
const KIND_MIN_SIZE: Record<string, { w: number; h: number }> = {
  terminal: { w: 320, h: 200 },
  chat: { w: 280, h: 220 },
  browser: { w: 320, h: 240 },
  files: { w: 240, h: 180 },
  changes: { w: 280, h: 200 },
  "remote-window": { w: 320, h: 200 },
  // DESIGN-BACKLOG.md §2.1 "Card `task`", Fase 2 peça 1 — 4 colunas lado a
  // lado, cada uma precisa de espaço real pra um chip de card não virar
  // sopa de letrinhas.
  task: { w: 560, h: 320 },
};

export function CardFrame({
  rect,
  zoom,
  zIndex,
  className,
  kind,
  baseStyle = true,
  headerContent,
  footerContent,
  onFocus,
  children,
  interactionMode = "normal",
  selected = false,
  accent,
  reflowing,
  closing,
  onChange,
  onCommit,
  onRaise,
  onResizeSettled,
  onConnectorStart,
  onSelectStart,
  onCloseAnimationEnd,
  aspectRatio,
  chromeless = false,
  chromeActive = false,
  onHeaderClick,
  screenProjected,
  panX,
  panY,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  className: string;
  /** Selector estável pra smoke tests, sobrevive a qualquer refactor de
   * CSS (hash de CSS Module incluso) — ver DESIGN-BACKLOG.md item sobre
   * seletores data-kind. Renderizado como `data-kind` na raiz. */
  kind: string;
  /** Aplica a classe global `.card-base` (fundo/borda/sombra padrão de
   * todo card) na raiz. `false` pros kinds que já controlam esse visual
   * inteiramente pelo próprio CSS (hoje só Stroke). */
  baseStyle?: boolean;
  headerContent: React.ReactNode;
  /** One-line strip at the bottom of the card (cwd, root path, URL, ...) —
   * reported live (2026-08-27) as inconsistent: each card kind that
   * wanted one duplicated its own `<div className="card-foot">`, and two
   * kinds (sticky, browser) had none at all. Owning the slot/styling here
   * means any future card kind gets the same footer "for free" just by
   * passing this prop, instead of re-implementing it. Omit for a card
   * with nothing meaningful to show there (sticky notes have no
   * comparable single-line metadata). */
  footerContent?: React.ReactNode;
  /** "Ajustar à tela" (DESIGN-BACKLOG.md item 21, ponto 2) — used to live
   * as a global "fit every card" button in Topbar's zoom-pill, right next
   * to the real fullscreen button added in item 19; the user reported
   * confusing the two ("ícone extra de fullscreen que não remove o
   * header") and, once told which button it actually was, asked for it
   * to live per-card instead ("acho válido estar no header do card, não
   * na topbar") — this is that: focuses/zooms the view onto THIS card
   * (reuses useWorldTransform's existing `focusCard`, already built for
   * the rail's jump-to-card popover). Lives here, not in each card's own
   * `headerContent`, so every kind gets it automatically — same slot
   * pattern as `footerContent` above. */
  onFocus?: () => void;
  children: React.ReactNode;
  /** "connector"/"select" both disable the normal drag/resize gestures below
   * so a click anywhere on the card starts a connector drag or a selection
   * toggle instead — see App.tsx. */
  interactionMode?: "normal" | "connector" | "select";
  /** Outline highlight while multi-selected (item 4) — see cards.css. */
  selected?: boolean;
  /** CSS color value for the card's left accent bar — unused today (the
   * bar itself was removed), kept only as the source for .card-tag's
   * per-provider/kind tint. */
  accent?: string;
  /** True for ~300ms right after an "organizar automaticamente" — animates the position change instead of jumping. */
  reflowing?: boolean;
  /** True while playing the close-out animation, right before removal — see App.tsx's closeCard/finalizeCloseCard split. */
  closing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onResizeSettled?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  onCloseAnimationEnd?: () => void;
  /** Item 57.9 — quando presente (`w / h`), o resize pelo canto deriva a
   * altura a partir do delta de largura em vez de redimensionar os dois
   * eixos livremente — "redimensionamento livre COM preservação de
   * proporção" (MediaCard.tsx), não um resize travado num tamanho fixo.
   * Aditivo: nenhum outro tipo de card passa isso, então o resize livre
   * de sempre continua idêntico pra todos os outros. */
  aspectRatio?: number;
  /** Pedido ao vivo (2026-09-01): "O CARD TIPO MEDIA NÃO DEVERIA TER BODY"
   * — para uma imagem, o card É a imagem: sem header, sem rodapé, sem
   * moldura. O header não some de vez (fechar/girar/renomear precisam
   * continuar alcançáveis), vira um overlay que só aparece no hover e
   * que NÃO ocupa altura de layout — é essa diferença que faz a imagem
   * preencher o card exatamente, já que o `rect` de um card de mídia
   * nasce com a proporção natural da imagem (App.tsx's `fitMediaRect`) e
   * o header/rodapé eram justamente o que quebrava esse encaixe.
   *
   * Consequência que precisa de tratamento no chamador: `.card-head` é o
   * único lugar que inicia o arraste de mover o card. Sem ele em layout,
   * o `pointerdown` que chegar ao `.card-clip` é que passa a mover — o
   * que só funciona porque o corpo da mídia deixa de engolir o evento
   * quando não tem o que panoramizar (MediaCard.tsx). Botões e
   * `[data-no-drag]` continuam excluídos pela mesma checagem de sempre em
   * `onHeaderPointerDown`. */
  chromeless?: boolean;
  /** Pedido ao vivo (2026-09-02): a faixa de chrome de um card `chromeless`
   * deixou de reagir a hover — só a um click de verdade (sem arraste) na
   * área do card, ver `onHeaderClick` abaixo. Este prop é o estado
   * controlado pelo chamador (MediaCard) que decide se essa faixa está
   * visível agora; sem efeito em cards não-chromeless. */
  chromeActive?: boolean;
  /** Disparado em `onHeaderPointerDown`/`.card-clip`'s pointerdown quando o
   * gesto termina SEM ter se movido (abaixo do limiar) — ou seja, um click
   * de verdade, distinto do arraste que move o card. Hoje só o MediaCard
   * chromeless usa isto (pra abrir/fechar a faixa de chrome ao clicar na
   * imagem); outros tipos de card não passam o prop, então nada muda para
   * eles. */
  onHeaderClick?: () => void;
  /** Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — opt-in, additive,
   * same pattern as `aspectRatio` above: when absent/false, behavior is
   * byte-identical to before (`rect` used raw, positioned inside `.world`'s
   * own CSS `scale(zoom)`). When true, this card is rendered by the caller
   * OUTSIDE `.world` (in the sibling `.cards-layer`, no CSS scale) and
   * needs its OWN screen-space rect computed here instead of relying on
   * an ancestor transform. `panX`/`panY` are required when this is true
   * (the world camera's pan, `.world`'s own `translate()`) — omitted
   * otherwise since only the screen-projected branch needs them.
   *
   * Deliberately still positions via `left`/`top` (not `transform:
   * translate3d`, the plan doc's original suggestion) — `animations.css`
   * animates `transform: scale(...)` for spawn/close (`popin`/`popout`)
   * and `left`/`top` for `.reflow`; a CSS animation/transition on
   * `transform` REPLACES the whole computed value rather than composing
   * with a separately-set static `transform`, so a screen-projected card
   * positioned via `translate3d` would visually snap to (0,0) during
   * spawn/close and `.reflow` would silently do nothing (animating a
   * property that no longer positions the card). Keeping `left`/`top`
   * sidesteps this without touching any animation.
   *
   * Found live (`smoke-group-select.mjs` broke — two heavily-overlapped
   * sticky cards zoomed way out, header clicks started landing on the
   * wrong sub-element): resizing only the OUTER box via left/top/width/
   * height is a LAYOUT change, not a visual scale — under the old model
   * `.world`'s `transform: scale(zoom)` shrank/grew the whole card
   * subtree as pure paint, so a card's internal padding/font-size/button
   * sizes visually scaled together with it "for free". Here, without
   * that ancestor transform, internal content would render at its native
   * unscaled size inside a resized box, reflowing/overflowing instead of
   * scaling — completely different geometry at any zoom off 1, worst at
   * extremes. Fixed below by giving the INNER content (`.card-clip` +
   * `.card-resize`) its own wrapper sized to the raw world `rect` with
   * `transform: scale(zoom)` (`transformOrigin: "0 0"` so it grows/shrinks
   * from the same top-left corner `screenRect.x/y` already anchors) —
   * `rect.w*zoom === screenRect.w` by construction, so the scaled inner
   * box exactly fills the outer one, reproducing the old CSS-transform
   * visual behavior without touching the outer positioning or the
   * popin/popout/reflow animations (those still target `.card-frame`
   * itself, untouched by this separate inner transform).
   *
   * KNOWN PERF DEBT (accepted, not fixed — decided live with the user
   * 2026-09-01, `smoke-render-memoization.mjs`'s "panning causes ZERO
   * extra renders" check fails for the browser card, ~9 renders per pan
   * gesture): non-migrated cards never re-render on a pure board pan —
   * their screen position comes entirely from `.world`'s own ambient CSS
   * transform, so `React.memo`'s shallow prop comparison sees nothing
   * changed (that guarantee is the whole point of the "Pre-release audit
   * P1" render-memoization fix this same test file proves). A
   * screen-projected card can't get that for free anymore: `panX`/`panY`
   * are now real props it needs to compute ITS OWN on-screen rect, and
   * they genuinely change every pan tick, so memo correctly re-renders
   * it. Fixing this without regressing correctness means moving pan
   * off React props entirely — a ref/subscription the world-transform
   * hook pushes to directly, read imperatively by CardFrame to update
   * `left`/`top` outside React's render cycle — real new plumbing, not
   * a local tweak, and not worth it for a 2-of-9-card-kinds slice.
   * Revisit if/when more kinds migrate and the cost compounds. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const [dragging, setDragging] = useState(false);

  // Achado ao vivo (2026-09-02, escrevendo o teste de resize/snapshot do
  // navegador) — `"spawning"` (frameClass abaixo) era uma string LITERAL
  // no array, sempre presente em TODO render, não só na montagem inicial.
  // A animação CSS (`popin`, animations.css) só REPETE quando o elemento
  // DOM em si é recriado (React troca de key, ou o pai desmonta/remonta) —
  // o card em uso normal nunca sentia isso, mas um teste medindo
  // `getBoundingClientRect()` logo depois de um evento que causa remount
  // (ex: navegar um browser card) podia pegar o card NO MEIO da animação
  // de entrada de novo, lendo um rect encolhido por `transform: scale()`
  // (0.92 do keyframe inicial) em vez do tamanho real assentado — ficou
  // mais fácil de reproduzir depois do supersample fixo (Item 6) deixar a
  // criação/primeiro paint do navegador mensuravelmente mais lenta,
  // deslocando quando esse remount acontece em relação ao resto. Fix:
  // `isFirstRenderRef` só é `true` na primeira renderização de verdade —
  // `spawning` (abaixo) passa a depender dele em vez de ser incondicional.
  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    isFirstRenderRef.current = false;
  }, []);

  // Item 2.1 — "piscar durante o drag", reportado ao vivo: raw
  // `pointermove` pode disparar bem mais rápido que a taxa de atualização
  // real da tela (não é limitado pelo browser), e cada evento aqui virava
  // seu próprio `onChange` → `setCards` → mutação de `left`/`top` (são
  // propriedades de LAYOUT, não só composição) — ou seja, um layout+paint
  // forçado por evento, sem nenhum coalescing. Conteúdo DOM comum
  // (CodeMirror, markdown) absorve isso sem sintoma visível; o canvas
  // WebGL do xterm.js é exatamente o tipo de camada onde esse
  // paint/composite redundante e não-sincronizado com o refresh real
  // aparece como piscar. `rafThrottleRect` junta múltiplos eventos crus no
  // mesmo frame num único `onChange`, sem mudar a lógica de arraste em si
  // nem a precisão do resultado — só a cadência de quando ele é aplicado.
  function rafThrottleRect(apply: (rect: Rect) => void): {
    schedule: (rect: Rect) => void;
    flushAndCancel: (rect: Rect) => void;
  } {
    let rafId: number | null = null;
    return {
      schedule(rect) {
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            apply(rect);
          });
        }
      },
      flushAndCancel(rect) {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        apply(rect);
      },
    };
  }

  function onHeaderPointerDown(e: React.PointerEvent) {
    if (interactionMode !== "normal") return;
    // [data-no-drag]: the header's editable title (CardTag) — an inline
    // <input> only while actively editing, but the double-click that
    // enters edit mode has to survive its own first pointerdown too, so the
    // plain (non-editing) tag span carries the same attribute.
    if ((e.target as HTMLElement).closest("button, select, input, [data-no-drag]")) return;
    onRaise();
    setDragging(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = rectRef.current;
    let finalRect = startRect;
    // Distingue um click de verdade de um arraste — abaixo do limiar (4px de
    // tela) conta como click e dispara `onHeaderClick` em vez de mover o
    // card. Sem isto, qualquer click no card-clip chromeless (onde este
    // handler dobra de função como "iniciar mover o card") teria sido
    // interpretado como um drag de distância zero, e nunca haveria como
    // distinguir "só clicou" de "arrastou e soltou no mesmo lugar".
    let moved = false;
    const throttle = rafThrottleRect(onChange);
    function onMove(ev: PointerEvent) {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) moved = true;
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      finalRect = { ...startRect, x: startRect.x + dx, y: startRect.y + dy };
      throttle.schedule(finalRect);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      throttle.flushAndCancel(finalRect);
      onCommit(finalRect);
      if (!moved) onHeaderClick?.();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /**
   * Pedido ao vivo (2026-09-01): "gostaria de poder redimensionar o card
   * por qualquer lado do card". Antes existia UM punho, no canto
   * inferior-direito — encolher um card pelo topo ou pela esquerda exigia
   * redimensionar por baixo e depois arrastar o card de volta.
   *
   * Um handler só pras 8 direções em vez de oito variações: a única coisa
   * que muda entre elas é quais bordas se movem. As que incluem `w`/`n`
   * mexem em `x`/`y` junto com `w`/`h` — é isso que faz a borda OPOSTA
   * ficar parada, que é o que a pessoa espera ao puxar um lado.
   */
  function onResizePointerDown(e: React.PointerEvent, dir: ResizeDir) {
    if (interactionMode !== "normal") return;
    e.stopPropagation();
    onRaise();
    setDragging(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = rectRef.current;
    let finalRect = startRect;
    const throttle = rafThrottleRect(onChange);
    const west = dir.includes("w");
    const north = dir.includes("n");
    const horizontal = dir.includes("e") || west;
    const vertical = dir.includes("s") || north;
    const minSize = KIND_MIN_SIZE[kind] ?? { w: MIN_CARD_W, h: MIN_CARD_H };

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      let w = startRect.w + (horizontal ? (west ? -dx : dx) : 0);
      let h = startRect.h + (vertical ? (north ? -dy : dy) : 0);

      if (aspectRatio) {
        // Item 57.9 — mídia redimensiona livre MAS preservando proporção.
        // Numa borda pura só um eixo tem gesto, então ele dita o outro; num
        // canto, o maior delta manda, mesma regra que já valia pro punho
        // único de antes.
        if (horizontal && vertical) {
          if (Math.abs(dx) >= Math.abs(dy)) h = w / aspectRatio;
          else w = h * aspectRatio;
        } else if (horizontal) {
          h = w / aspectRatio;
        } else {
          w = h * aspectRatio;
        }
        if (w < minSize.w) {
          w = minSize.w;
          h = w / aspectRatio;
        }
        if (h < minSize.h) {
          h = minSize.h;
          w = h * aspectRatio;
        }
      } else {
        w = Math.max(minSize.w, w);
        h = Math.max(minSize.h, h);
      }

      // Reancoragem: puxando pelo oeste/norte, é a borda oposta que fica
      // parada, então a origem anda pela diferença de tamanho. Feito DEPOIS
      // dos limites, senão um card no tamanho mínimo continuaria deslizando
      // enquanto o ponteiro anda.
      finalRect = {
        x: west || (aspectRatio && dir === "n") ? startRect.x + (startRect.w - w) : startRect.x,
        y: north || (aspectRatio && dir === "w") ? startRect.y + (startRect.h - h) : startRect.y,
        w,
        h,
      };
      throttle.schedule(finalRect);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      throttle.flushAndCancel(finalRect);
      onCommit(finalRect);
      onResizeSettled?.();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const frameClass = [
    "card-frame",
    baseStyle && "card-base",
    className,
    chromeless && "chromeless",
    chromeless && chromeActive && "chrome-active",
    isFirstRenderRef.current && "spawning",
    dragging && "dragging",
    reflowing && "reflow",
    selected && "selected",
    closing && "closing",
  ]
    .filter(Boolean)
    .join(" ");

  // Trilha B — see `screenProjected`'s doc comment above. `worldRectToScreen`
  // (board-model.ts) already does exactly this projection for the
  // snapshot IPC handler; `viewportOrigin` is zeroed here because
  // `.cards-layer` lives inside `.viewport` itself (same containing
  // block `.world` uses), unlike the snapshot handler's cross-process
  // window-relative use.
  const screenRect = screenProjected ? worldRectToScreen(rect, { panX: panX ?? 0, panY: panY ?? 0, zoom }, { x: 0, y: 0 }) : rect;

  // Owns overflow:hidden + border-radius (clips content to the rounded
  // card shape). The resize handle below is deliberately OUTSIDE this
  // wrapper — it used to be a child of the clipped box itself, which
  // clipped away most of its own hit area right in the corner it
  // lives in, making cards effectively non-resizable in practice.
  const cardInner = (
    <>
      {/* Em modo chromeless o arraste nasce aqui, no clip inteiro — e o
          header abaixo NÃO registra o seu próprio, senão um pointerdown
          sobre ele dispararia os dois handlers (o dele e este, por
          borbulhamento) e iniciaria dois arrastes concorrentes. Parar a
          propagação no header em vez disso não serve: quebraria os modos
          conector/seleção, que dependem do evento chegar ao
          `.card-frame`. */}
      <div className="card-clip" onPointerDown={chromeless ? onHeaderPointerDown : undefined}>
        <div className="card-head" onPointerDown={chromeless ? undefined : onHeaderPointerDown}>
          {/* Wrapping div, not headerContent's own two-item space-between
              row directly — keeps every card kind's own internal layout
              (label ↔ actions) untouched; the focus button below is
              appended as a separate, always-last flex item instead of a
              3rd competitor for that space-between pair. */}
          <div className="card-head-inner">{headerContent}</div>
          {onFocus && (
            <button
              type="button"
              className="card-focus-btn"
              title="Focar nesse card (ajustar zoom pra ele)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onFocus}
            >
              <Icon name="fit" size={12} />
            </button>
          )}
        </div>
        {children}
        {!chromeless && footerContent !== undefined && footerContent !== null && (
          <div className="card-foot">{footerContent}</div>
        )}
      </div>
      {/* As 8 zonas ficam FORA de `.card-clip` pelo mesmo motivo que o
          punho visível sempre ficou: dentro, o `overflow: hidden`
          recortaria justamente a área de acerto nas bordas. Pedido ao vivo
          (2026-09-02): "o ícone de redimensionar não precisaria existir
          (...) agora todos os pontos de um card podem ser redimensionados"
          — o grip visual que antes só existia no canto inferior-direito
          foi removido; as 8 zonas continuam existindo, marcadas só pelo
          cursor (nwse-resize/ns-resize/etc.), sem afordance visual própria. */}
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`card-resize-zone card-resize-${dir}`}
          onPointerDown={(e) => onResizePointerDown(e, dir)}
        />
      ))}
    </>
  );

  // D2 — Compensação de espessura de borda (1/zoom) e sombra de alto contraste em zoom reduzido
  const borderW = zoom < 0.9 ? `${Math.min(3, Math.max(1, 1 / zoom)).toFixed(2)}px` : undefined;
  const cardShadow =
    zoom < 0.6
      ? `0 0 0 ${borderW ?? "1px"} var(--border), 0 ${Math.round(8 / zoom)}px ${Math.round(28 / zoom)}px rgba(0, 0, 0, 0.7)`
      : undefined;

  // Achado ao vivo (2026-09-07, screenshot real a 20% de zoom): `.card-scale`
  // (e por consequência `.card-clip`, 100%/100% dele) media a mesma largura/
  // altura EXTERNA de `.card-frame` (`rect.w`/`rect.h`) sem descontar a
  // borda real que `.card-base` desenha (`box-sizing:border-box`) — ficava
  // maior que a content-box do frame por exatamente a espessura da borda,
  // cobrindo a borda nos lados DIREITO/BAIXO (fundo opaco do `.card-clip`
  // pintando por cima) e deixando só CIMA/ESQUERDA sem cobertura, onde a
  // borda aparecia como uma sombra clara indevida. Imperceptível a zoom
  // normal (borda de 1px quase sub-pixel); o próprio D2 acima (que ENGROSSA
  // a borda pra até 3px abaixo de 90% zoom) foi o que tornou essa divergência
  // sempre presente finalmente visível. Sem borda nenhuma (`baseStyle=false`,
  // ex. StrokeCard) não há nada a descontar.
  //
  // Regressão achada na PRÓPRIA verificação deste fix (`smoke-browser-zoom-
  // resolution.mjs`, 2026-09-07): a primeira versão deste fix encolhia
  // `rect.w`/`rect.h` (as props de largura/altura de `.card-scale`, em
  // unidades de MUNDO) — isso quebra o invariante "resolução real do
  // navegador embutido não muda com o zoom do board", porque `rect.w`/
  // `rect.h` é exatamente o que `BrowserCard.tsx`'s `ResizeObserver` mede
  // pra decidir o tamanho real do `BrowserWindow` offscreen (`ResizeObserver`
  // mede a CAIXA CSS/layout, não afetada por `transform` — mas MEDIDA
  // afetada por uma mudança de tamanho de verdade, que é o que a versão
  // antiga fazia). Fix: nunca tocar `rect.w`/`rect.h` (ficam exatamente
  // como sempre foram, 100% decoupled do zoom) — a compensação de borda
  // vira só um ajuste na TRANSFORM (`scale`), que é puramente visual e
  // nunca aparece pra `ResizeObserver`/`getBoundingClientRect` de um jeito
  // que mude o tamanho de MUNDO de nada. `transform-origin` de `.card-scale`
  // é `0 0` (`cards.css`) — e o canto superior-esquerdo desse `0 0` já cai
  // exatamente na content-box de `.card-frame` (o box model do browser já
  // insere automaticamente um filho em fluxo normal depois da borda do pai,
  // sem precisar de nenhum ajuste manual) — só falta encolher o lado
  // DIREITO/BAIXO, que é a única sobra depois do `scale(zoom)` esticar
  // até preencher a largura/altura EXTERNA (border-box) do frame.
  //
  // Restrito ao mesmo limiar de `borderW`/`cardShadow` acima (`zoom < 0.9`)
  // por um motivo a mais descoberto SÓ agora, testando de novo depois do
  // fix acima: acima desse limiar a borda é sempre 1px fixo (fallback
  // CSS puro, sem D2 nenhum), overflow de exatos 1px sub-pixel, sempre
  // foi assim e nunca foi visível/reportado (só o D2 engrossando a borda
  // embaixo de 0.9 tornou isso visível) — mas COMPENSAR mesmo esse 1px
  // sub-pixel em zoom normal (100%/201%, os dois usados pelos smoke tests
  // deste navegador) reintroduzia um novo problema: `scaleX`/`scaleY`
  // deixam de ser EXATAMENTE `zoom`, e código que lê `getBoundingClientRect`
  // de algo dentro do card pra fazer conta de pixel (`BrowserInspector.tsx`'s
  // `beginFrameResize`, que mede o wrap do device frame) passa a ver uma
  // área ligeiramente menor que o esperado — o suficiente pra um
  // arredondamento de 1-3px aparecer em `smoke-browser-inspector-frame-
  // resize.mjs` (844→843, 3000→2997), que não existia antes. Abaixo de
  // 0.9 (onde o D2 já MUDA várias outras coisas de qualquer forma — borda
  // até 3× mais grossa, sombra de alto contraste) a superfície de teste é
  // outra, sem essa regressão, e é onde o bug original (screenshot a 20%)
  // foi reportado — então a compensação fica restrita a esse mesmo regime.
  const borderPxScreen = baseStyle && zoom < 0.9 ? Math.min(3, Math.max(1, 1 / zoom)) : 0;
  const scaleX = borderPxScreen > 0 && rect.w > 0 ? Math.max(0, zoom - borderPxScreen / rect.w) : zoom;
  const scaleY = borderPxScreen > 0 && rect.h > 0 ? Math.max(0, zoom - borderPxScreen / rect.h) : zoom;

  return (
    <div
      className={frameClass}
      data-kind={kind}
      style={{
        position: "absolute",
        left: screenRect.x,
        top: screenRect.y,
        width: screenRect.w,
        height: screenRect.h,
        zIndex,
        ...(accent ? ({ "--accent": accent } as React.CSSProperties) : {}),
        ...(borderW ? ({ "--card-border-w": borderW } as React.CSSProperties) : {}),
        ...(cardShadow ? ({ "--card-shadow": cardShadow } as React.CSSProperties) : {}),
      }}
      onPointerDown={(e) => {
        if (closing) return;
        onRaise();
        if (interactionMode === "connector") onConnectorStart?.(e);
        if (interactionMode === "select") onSelectStart?.(e);
      }}
      // Pedido ao vivo (2026-08-27): scroll sobre QUALQUER card zoomava o
      // canvas inteiro por baixo — `useWorldTransform.ts`'s `onWheel`
      // está no `.viewport`, sem exceção nenhuma por padrão. O único
      // lugar que já tratava isso era `BrowserCard.tsx` (condicional a
      // ter foco real) — todo o resto (terminal/arquivos/chat/changes)
      // sempre vazava pro zoom, mesmo tendo conteúdo próprio pra rolar.
      // Fix universal, um lugar só (todo card passa por `CardFrame`): o
      // card inteiro vira uma zona onde wheel nunca vaza pro board —
      // scroll dentro dele rola o conteúdo que já tem overflow nativo
      // (`.xterm-viewport` do xterm.js usa `overflow-y: scroll` de
      // verdade, não um scroll virtualizado — confirmado no CSS
      // empacotado da lib), zoom do canvas só acontece no fundo vazio de
      // verdade, fora de qualquer card — mesmo território que o pan
      // (`onBackgroundPointerDown`) já respeita hoje.
      //
      // Mudança de comportamento deliberada, confirmada com o usuário:
      // `BrowserCard` sem foco tinha uma exceção documentada própria
      // ("Unfocused, let it bubble to the board's own zoom as normal")
      // — deixa de existir. Sem foco, rolar sobre um navegador embutido
      // agora não faz nada (em vez de zoomar o canvas por baixo) até um
      // clique focar o card, aí sim rolando a página embutida —
      // consistente com todo o resto, sem exceção por tipo de card.
      onWheel={(e) => e.stopPropagation()}
      onAnimationEnd={(e) => {
        if (closing && e.currentTarget === e.target) onCloseAnimationEnd?.();
      }}
    >
      {/* Trilha B — see `screenProjected`'s doc comment above. Only the
          inner content needs scaling to reproduce the old CSS-transform
          visual behavior; non-migrated cards render `cardInner` as a
          direct child of `.card-frame`, byte-identical to before. */}
      {screenProjected ? (
        <div
          className="card-scale"
          style={{
            width: rect.w,
            height: rect.h,
            transform: `scale(${scaleX}, ${scaleY})`,
          }}
        >
          {cardInner}
        </div>
      ) : (
        cardInner
      )}
    </div>
  );
}
