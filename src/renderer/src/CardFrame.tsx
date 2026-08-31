import { useRef, useState } from "react";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

/**
 * Shared drag/resize/z-order chrome for every board item kind. Pulled out of
 * TerminalCard once files/changes/sticky needed the exact same pointer math —
 * a header drag that moves `rect` in world units (divided by `zoom` so it
 * tracks the mouse 1:1 while zoomed) and a corner handle that resizes it,
 * both committing only on pointerup, never per frame.
 */
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
}) {
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const [dragging, setDragging] = useState(false);

  // Item 2.1 pendente — "piscar durante o drag", reportado ao vivo: raw
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

  function onResizePointerDown(e: React.PointerEvent) {
    if (interactionMode !== "normal") return;
    e.stopPropagation();
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
      if (aspectRatio) {
        // Move pelo maior delta (horizontal ou vertical) dita o tamanho —
        // deixa arrastar em qualquer direção do canto se sentir "natural",
        // não só quando o mouse anda mais rápido no eixo X.
        let w = Math.max(160, startRect.w + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * aspectRatio));
        let h = w / aspectRatio;
        if (h < 120) {
          h = 120;
          w = h * aspectRatio;
        }
        finalRect = { ...startRect, w, h };
      } else {
        finalRect = {
          ...startRect,
          w: Math.max(160, startRect.w + dx),
          h: Math.max(120, startRect.h + dy),
        };
      }
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
    "spawning",
    dragging && "dragging",
    reflowing && "reflow",
    selected && "selected",
    closing && "closing",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={frameClass}
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex,
        ...(accent ? ({ "--accent": accent } as React.CSSProperties) : {}),
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
      {/* Owns overflow:hidden + border-radius (clips content to the rounded
          card shape). The resize handle below is deliberately OUTSIDE this
          wrapper — it used to be a child of the clipped box itself, which
          clipped away most of its own hit area right in the corner it
          lives in, making cards effectively non-resizable in practice. */}
      <div className="card-clip">
        <div className="card-head" onPointerDown={onHeaderPointerDown}>
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
        {footerContent !== undefined && footerContent !== null && (
          <div className="card-foot">{footerContent}</div>
        )}
      </div>
      <div className="card-resize" onPointerDown={onResizePointerDown}>
        <Icon name="resizeGrip" size={11} />
      </div>
    </div>
  );
}
