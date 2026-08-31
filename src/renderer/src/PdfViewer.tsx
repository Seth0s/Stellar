import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
// Vite `?url` import — the worker script needs its own real URL, not
// bundled inline (pdf.js spins it up as a genuine Worker).
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Item 57.9 — separado de MediaCard.tsx e carregado via `React.lazy`
 * (mesmo padrão de FilesCard.tsx's CodeEditor) só pra manter o import
 * pesado do pdf.js fora do bundle principal — paga o custo só quando um
 * card de mídia tipo PDF realmente monta. `docGen` força o segundo
 * effect a rodar de novo assim que o doc termina de carregar mesmo com
 * `page` parado em 1 — sem ele, o efeito com deps `[page]` nunca
 * dispararia de novo pra renderizar a 1ª página real. `destroy()` mora
 * na `PDFDocumentLoadingTask`, não no `PDFDocumentProxy` resolvido — daí
 * o ref separado. */
export function PdfViewer({
  url,
  page,
  onDocInfo,
}: {
  url: string;
  page: number;
  onDocInfo: (numPages: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const [docGen, setDocGen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjsLib.getDocument({ url });
    taskRef.current = task;
    task.promise
      .then((doc) => {
        if (cancelled) return;
        docRef.current = doc;
        onDocInfo(doc.numPages);
        setDocGen((g) => g + 1);
      })
      .catch(() => {
        // Corrupt/unreadable PDF — leave the canvas blank rather than crash the card.
      });
    return () => {
      cancelled = true;
      docRef.current = null;
      void taskRef.current?.destroy();
      taskRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    let cancelled = false;
    const clampedPage = Math.min(Math.max(1, page), doc.numPages);
    doc.getPage(clampedPage).then((pdfPage) => {
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale: 2 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      void pdfPage.render({ canvas, viewport }).promise;
    });
    return () => {
      cancelled = true;
    };
  }, [page, docGen]);

  return <canvas ref={canvasRef} className="media-pdf-canvas" />;
}
