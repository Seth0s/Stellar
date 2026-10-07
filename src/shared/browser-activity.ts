/**
 * When does a visible browser card deserve the full paint rate?
 *
 * Measured (isolated instance, five visible cards, four animated): the cost of
 * a browser card is the pipeline per FRAME — a JPEG encode in the main process,
 * the IPC, the decode and draw in the app renderer, the GPU — not the page: the
 * pages themselves added ~3% of a core, the pipeline ~55%. The card that was
 * topmost in the z-order painted at the full rate whether or not anybody was
 * using it, so one idle card always paid 30 fps.
 *
 * A card is ACTIVE when the person is actually on it: the pointer is over it, or
 * its canvas holds the keyboard focus (typing with the mouse parked elsewhere).
 * Being the topmost card is not use. Everything else visible paints at the low
 * rate. Pure, shared by the renderer (which knows hover and focus) and the tests.
 */
export function isBrowserCardActive(input: { hovering: boolean; domFocused: boolean }): boolean {
  return input.hovering || input.domFocused;
}

/**
 * Does the card paint at all? Only while it is inside the board viewport AND the
 * app window itself is visible. A minimised or fully covered window used to keep
 * every on-board browser card compositing, encoding and shipping frames nobody
 * can see; the board viewport alone does not know about that.
 */
export function shouldBrowserCardPaint(input: { inViewport: boolean; windowVisible: boolean }): boolean {
  return input.inViewport && input.windowVisible;
}
