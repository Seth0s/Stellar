import { useRef, useState } from "react";
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
/** Mesmos mínimos que o punho único já aplicava. */
const MIN_CARD_W = 160;
const MIN_CARD_H = 120;

export function CardFrame({
  rect,
  zoom,
  zIndex,
  className,
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
  screenProjected,
  panX,
  panY,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  className: string;
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
    const throttle = rafThrottleRect(onChange);
    function onMove(ev: PointerEvent) {
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
        if (w < MIN_CARD_W) {
          w = MIN_CARD_W;
          h = w / aspectRatio;
        }
        if (h < MIN_CARD_H) {
          h = MIN_CARD_H;
          w = h * aspectRatio;
        }
      } else {
        w = Math.max(MIN_CARD_W, w);
        h = Math.max(MIN_CARD_H, h);
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
    className,
    chromeless && "chromeless",
    "spawning",
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
          punho sempre ficou: dentro, o `overflow: hidden` recortaria
          justamente a área de acerto nas bordas. O grip visual continua no
          canto inferior-direito (é onde as pessoas já procuram); as outras
          sete são invisíveis, marcadas só pelo cursor. */}
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`card-resize-zone card-resize-${dir}`}
          onPointerDown={(e) => onResizePointerDown(e, dir)}
        />
      ))}
      <div className="card-resize" onPointerDown={(e) => onResizePointerDown(e, "se")}>
        <Icon name="resizeGrip" size={11} />
      </div>
    </>
  );

  // D2 — Compensação de espessura de borda (1/zoom) e sombra de alto contraste em zoom reduzido
  const borderW = zoom < 0.9 ? `${Math.min(3, Math.max(1, 1 / zoom)).toFixed(2)}px` : undefined;
  const cardShadow =
    zoom < 0.6
      ? `0 0 0 ${borderW ?? "1px"} var(--border), 0 ${Math.round(8 / zoom)}px ${Math.round(28 / zoom)}px rgba(0, 0, 0, 0.7)`
      : undefined;

  return (
    <div
      className={frameClass}
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
          style={{ width: rect.w, height: rect.h, transform: `scale(${zoom})` }}
        >
          {cardInner}
        </div>
      ) : (
        cardInner
      )}
    </div>
  );
}
