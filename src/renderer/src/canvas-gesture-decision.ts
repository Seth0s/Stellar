/**
 * Who gets a wheel turn or a drag that starts over a card: the canvas, or the
 * card's own content?
 *
 * The canvas modifier is Ctrl (Cmd on macOS) — the same key as the canvas zoom
 * shortcuts (`canvas.zoomIn` / `canvas.zoomOut`, Ctrl/Cmd +/-). Without it nothing
 * changes: the wheel scrolls what is under the pointer (the page of a browser
 * card, the scrollback of a terminal) and a drag on the card's bar moves the card.
 * With it, the gesture belongs to the canvas EVEN over a browser card, whose page
 * would otherwise swallow it:
 *   - Ctrl/Cmd + wheel anywhere over a card zooms the canvas, anchored at the pointer;
 *   - Ctrl/Cmd + drag, or a middle-button drag, started anywhere over a card — its
 *     page, its bar or its border — pans the canvas.
 * Pure: the decision only, so it is testable without a DOM.
 */

export type GestureOwner = "canvas" | "content";

/** Ctrl, or Cmd on macOS — the key the canvas zoom shortcuts use. */
export function hasCanvasModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
}

export function decideWheelOwner(e: { ctrlKey: boolean; metaKey: boolean }): GestureOwner {
  return hasCanvasModifier(e) ? "canvas" : "content";
}

/** Middle mouse button (`PointerEvent.button`). */
export const MIDDLE_BUTTON = 1;

/**
 * A pointerdown that lands over a card. Only in the normal pointer mode: the
 * select / connector / pen tools already give the same gesture a different job.
 */
export function decidePointerDownOwner(input: {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  /** The tool mode (`interactionMode` in App.tsx): "normal" is the pointer tool. */
  mode: string;
}): GestureOwner {
  if (input.mode !== "normal") return "content";
  if (input.button === MIDDLE_BUTTON) return "canvas";
  if (input.button === 0 && hasCanvasModifier(input)) return "canvas";
  return "content";
}
