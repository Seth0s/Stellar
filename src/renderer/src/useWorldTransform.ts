import { useRef, useState } from "react";
import { bboxOf, screenToWorld, viewportWorldRect, type Point, type Rect, type WorldTransform } from "./board-model";
import type { Card } from "./card-types";

/**
 * Pan/zoom state and the pure math around it — extracted out of `App.tsx`
 * (item 5 of DESIGN-BACKLOG.md, phase 2) since this was one of four
 * self-contained pieces tangled into that single ~1600-line component.
 * Takes `cardsRef` as a parameter rather than owning card state itself —
 * `fitView` needs the current cards' bounding box, but this hook has no
 * business owning the cards array; same boundary the backlog entry called
 * for ("nenhum [hook] dependeria de estado interno dos outros, só de
 * `cards`/`world` como valores passados").
 */
export function useWorldTransform(cardsRef: React.RefObject<Card[]>) {
  const [world, setWorld] = useState<WorldTransform>({ panX: 0, panY: 0, zoom: 1 });
  const viewportRef = useRef<HTMLDivElement>(null);
  // Mirrors `world` for the IPC snapshot listener (App.tsx) — that effect
  // is registered once at mount with an empty dep array, so it needs
  // whatever's current at call time, not what was current at registration.
  const worldRef = useRef(world);
  worldRef.current = world;

  /** Screen client coords -> world coords, via the viewport's own current bounding rect (matches onWheel's math). */
  function clientToWorld(clientX: number, clientY: number): Point {
    const rect = viewportRef.current?.getBoundingClientRect();
    return screenToWorld({ x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }, world);
  }

  function zoomBy(factor: number) {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    setWorld((prev) => {
      const newZoom = Math.min(3, Math.max(0.2, prev.zoom * factor));
      const worldX = (vw / 2 - prev.panX) / prev.zoom;
      const worldY = (vh / 2 - prev.panY) / prev.zoom;
      return { zoom: newZoom, panX: vw / 2 - newZoom * worldX, panY: vh / 2 - newZoom * worldY };
    });
  }

  /** DESIGN-BACKLOG.md item 12, achado 6 — zoom-pill gained direct
   * editing (type a %) and a slider; both need to set an absolute zoom
   * level rather than multiply the current one, same viewport-center
   * anchor `zoomBy` already uses. */
  function setZoomAbs(zoomRaw: number) {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    setWorld((prev) => {
      const newZoom = Math.min(3, Math.max(0.2, zoomRaw));
      const worldX = (vw / 2 - prev.panX) / prev.zoom;
      const worldY = (vh / 2 - prev.panY) / prev.zoom;
      return { zoom: newZoom, panX: vw / 2 - newZoom * worldX, panY: vh / 2 - newZoom * worldY };
    });
  }

  function fitView() {
    const vp = viewportRef.current;
    const box = bboxOf(cardsRef.current.map((c) => c.rect));
    if (!vp || !box) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const PAD = 60;
    const scale = Math.min((vw - PAD * 2) / box.w, (vh - PAD * 2) / box.h);
    const zoom = Math.min(3, Math.max(0.2, scale));
    setWorld({
      zoom,
      panX: vw / 2 - (box.x + box.w / 2) * zoom,
      panY: vh / 2 - (box.y + box.h / 2) * zoom,
    });
  }

  /** Jump-to-card (DESIGN-BACKLOG.md item 7) — same centering math as
   * `fitView`, just for one card's rect instead of the whole board's
   * bounding box. Lets "find a specific card among many spread out ones"
   * skip the manual scroll/pan `fitView`'s own doc comment calls out as
   * the gap. */
  function focusCard(id: string) {
    const vp = viewportRef.current;
    const card = cardsRef.current.find((c) => c.id === id);
    if (!vp || !card) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const PAD = 80;
    const box = card.rect;
    const scale = Math.min((vw - PAD * 2) / box.w, (vh - PAD * 2) / box.h);
    const zoom = Math.min(3, Math.max(0.2, scale));
    setWorld({
      zoom,
      panX: vw / 2 - (box.x + box.w / 2) * zoom,
      panY: vh / 2 - (box.y + box.h / 2) * zoom,
    });
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    setWorld((prev) => {
      const newZoom = Math.min(3, Math.max(0.2, prev.zoom * factor));
      const worldX = (screenX - prev.panX) / prev.zoom;
      const worldY = (screenY - prev.panY) / prev.zoom;
      return {
        zoom: newZoom,
        panX: screenX - newZoom * worldX,
        panY: screenY - newZoom * worldY,
      };
    });
  }

  /** The pointer-tool's own background-drag gesture (panning) — a plain
   * pointerdown→window pointermove/up closure, same shape as the other
   * drag gestures in App.tsx (marquee, connector, resize). */
  function startPan(e: React.PointerEvent) {
    const startX = e.clientX;
    const startY = e.clientY;
    const start = world;
    function onMove(ev: PointerEvent) {
      setWorld({ ...start, panX: start.panX + (ev.clientX - startX), panY: start.panY + (ev.clientY - startY) });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const viewportSize = viewportRef.current
    ? { width: viewportRef.current.clientWidth, height: viewportRef.current.clientHeight }
    : { width: window.innerWidth, height: window.innerHeight };
  const visibleRect: Rect = viewportWorldRect(viewportSize, world);
  const viewportOrigin = viewportRef.current
    ? (() => {
        const r = viewportRef.current!.getBoundingClientRect();
        return { x: r.x, y: r.y };
      })()
    : { x: 0, y: 0 };

  return {
    world,
    setWorld,
    worldRef,
    viewportRef,
    viewportSize,
    viewportOrigin,
    visibleRect,
    clientToWorld,
    zoomBy,
    setZoomAbs,
    fitView,
    focusCard,
    onWheel,
    startPan,
  };
}
