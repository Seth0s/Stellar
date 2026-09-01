import { lazy, Suspense, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

// Mesmo padrão de FilesCard.tsx's CodeEditor — pdf.js só carrega quando
// um card de mídia tipo PDF realmente monta.
const PdfViewer = lazy(() => import("./PdfViewer").then((m) => ({ default: m.PdfViewer })));

const ROTATION_STEPS = [0, 90, 180, 270] as const;
const MEDIA_ZOOM_MIN = 0.25;
const MEDIA_ZOOM_MAX = 6;
// Wheel não tem um "pointerup" natural pra marcar o fim do gesto (ao
// contrário do pan/resize do CardFrame) — este debounce é o equivalente:
// persiste um tempo depois do último evento de scroll, não a cada tick.
const VIEW_COMMIT_IDLE_MS = 400;

export type MediaView = { zoom: number; panX: number; panY: number };

export function MediaCard({
  rect,
  zoom,
  zIndex,
  boardId,
  assetPath,
  mediaType,
  rotation,
  view,
  interactionMode,
  selected,
  reflowing,
  closing,
  label,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onRotateCommit,
  onViewChange,
  onViewCommit,
  onConnectorStart,
  onSelectStart,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  boardId: string;
  assetPath: string;
  mediaType: "image" | "pdf";
  rotation: 0 | 90 | 180 | 270;
  view: MediaView;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  label: string | null;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onRotateCommit: (rotation: 0 | 90 | 180 | 270) => void;
  onViewChange: (view: MediaView) => void;
  onViewCommit: (view: MediaView) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const filename = assetPath.split(/[\\/]/).pop() ?? assetPath;
  // `stellar-asset://asset/<boardId>/<filename>` (main/index.ts's
  // protocol.handle) — carrega direto via fetch/XHR real (streaming), sem
  // empurrar base64 pela IPC a cada render, ver board-assets.ts. boardId
  // vai no PATH, não no host — um board id puramente numérico como host
  // seria reinterpretado como IPv4 pelo parser de URL (ver o comment no
  // protocol.handle).
  const assetUrl = `stellar-asset://asset/${encodeURIComponent(boardId)}/${encodeURIComponent(filename)}`;
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfNumPages, setPdfNumPages] = useState(1);
  const commitTimer = useRef<number | null>(null);

  function scheduleViewCommit(v: MediaView) {
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => onViewCommit(v), VIEW_COMMIT_IDLE_MS);
  }

  function cycleRotation() {
    const idx = ROTATION_STEPS.indexOf(rotation);
    onRotateCommit(ROTATION_STEPS[(idx + 1) % ROTATION_STEPS.length]);
  }

  /** Pan da imagem DENTRO do card — mas só quando há o que panoramizar.
   *
   * Pedido ao vivo (2026-09-01): um card de imagem passou a ser exibido
   * sem chrome nenhum (`chromeless` no CardFrame), e sem header não sobra
   * nenhuma faixa dedicada pra iniciar o arraste de mover o card. Regra
   * confirmada com o usuário: em `view.zoom <= 1` a imagem inteira já
   * cabe no card, então não existe pan possível — o gesto é liberado
   * (nada de `stopPropagation`) e borbulha pro `.card-clip`, que move o
   * card. Ampliada (`view.zoom > 1`) o arraste volta a ser pan, e mover o
   * card se faz pelo overlay do header (que aparece no hover) ou pela
   * borda.
   *
   * Para PDF nada disso vale (o card mantém o frame completo, header
   * incluído), então lá o pan segue exclusivo do corpo como sempre foi. */
  const bodyDragPans = mediaType === "pdf" || view.zoom > 1;

  function onBodyPointerDown(e: React.PointerEvent) {
    if (interactionMode !== "normal") return;
    if (!bodyDragPans) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startView = view;
    let finalView = startView;
    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      finalView = { ...startView, panX: startView.panX + dx, panY: startView.panY + dy };
      onViewChange(finalView);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onViewCommit(finalView);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onBodyWheel(e: React.WheelEvent) {
    if (interactionMode !== "normal") return;
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextView = { ...view, zoom: Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, view.zoom * factor)) };
    onViewChange(nextView);
    scheduleViewCommit(nextView);
  }

  return (
    <CardFrame
      className="media-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      selected={selected}
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      // Resize proporcional (item 57.9) — `rect.w/rect.h` NA HORA do
      // resize é sempre a razão real da mídia (só o próprio resize
      // proporcional deste prop pode mudar w/h de um card de mídia,
      // nunca algo mais), então não precisa de um campo separado
      // guardando "a proporção original".
      aspectRatio={rect.w / rect.h}
      // "O CARD TIPO MEDIA NÃO DEVERIA TER BODY" (2026-09-01) — só para
      // imagem. Um PDF mantém o frame inteiro: a navegação de páginas
      // vive no rodapé e não tem outro lugar razoável pra morar.
      chromeless={mediaType === "image"}
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="fileImage" size={14} />
            <CardTag label={label ?? filename} onRename={onRename} />
          </span>
          <button onClick={cycleRotation} title="Girar 90°">
            <Icon name="rotate" size={12} />
          </button>
          <button onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </>
      }
      // Só o PDF tem rodapé. Para imagem ele mostrava o nome do arquivo,
      // que já é exatamente o rótulo padrão do CardTag no header — linha
      // duplicada, e agora sem lugar nenhum (CardFrame ignora o rodapé em
      // modo chromeless de todo jeito).
      footerContent={
        mediaType === "pdf" ? (
          <span className="media-pdf-nav">
            <span className="media-filename">{filename}</span>
            <button disabled={pdfPage <= 1} onClick={() => setPdfPage((p) => Math.max(1, p - 1))}>
              <Icon name="chevronLeft" size={12} />
            </button>
            <span className="media-pdf-page">
              {pdfPage}/{pdfNumPages}
            </span>
            <button disabled={pdfPage >= pdfNumPages} onClick={() => setPdfPage((p) => Math.min(pdfNumPages, p + 1))}>
              <Icon name="chevronRight" size={12} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="media-viewport" onPointerDown={onBodyPointerDown} onWheel={onBodyWheel}>
        <div
          className="media-content"
          style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom}) rotate(${rotation}deg)` }}
        >
          {mediaType === "image" ? (
            <img src={assetUrl} draggable={false} alt={filename} />
          ) : (
            <Suspense fallback={<div className="media-pdf-loading">carregando PDF…</div>}>
              <PdfViewer url={assetUrl} page={pdfPage} onDocInfo={setPdfNumPages} />
            </Suspense>
          )}
        </div>
      </div>
    </CardFrame>
  );
}
