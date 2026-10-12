/**
 * Hide / reveal rules of the overlay rail. Kept free of React and the DOM so
 * the timings and thresholds are testable without a renderer.
 *
 * The rail floats above the board. The user can hide it for good (persisted);
 * a hidden rail comes back by itself when the pointer reaches the left edge or
 * a touch drag starts there, and leaves again once the pointer is away.
 */

export const RAIL_HIDDEN_KEY = "ac.railHidden";

/** The board-path button in the title strip asks the rail to show its Board panel. */
export const OPEN_BOARD_PANEL_EVENT = "stellar:open-board-panel";

/** Asks the rail to show its session list (the Board panel's "Trocar de sessão…"). */
export const OPEN_SESSIONS_EVENT = "stellar:open-sessions";
/** The session list asks the top bar's modals to open (create / edit / archived). */
export const SESSION_CREATE_EVENT = "stellar:session-create";
export const SESSION_EDIT_EVENT = "stellar:session-edit";
export const ARCHIVED_OPEN_EVENT = "stellar:open-archived";

/** Pointer (mouse/pen) activation band, measured from the window's left edge. */
export const EDGE_POINTER_PX = 12;
/** Touch activation band — wider because a finger is less precise. */
export const EDGE_TOUCH_PX = 16;
/** Dwell time in the band before the rail slides in. */
export const REVEAL_DELAY_MS = 120;
/** Grace period after the pointer leaves before a revealed rail hides again. */
export const HIDE_DELAY_MS = 600;
/** Horizontal travel that turns a touch that began in the band into a reveal. */
export const EDGE_SWIPE_MIN_PX = 24;

export type PointerKind = "mouse" | "pen" | "touch" | string;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readRailHidden(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(RAIL_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeRailHidden(storage: StorageLike | null | undefined, hidden: boolean): void {
  try {
    storage?.setItem(RAIL_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    /* a blocked store only costs the persistence, never the rail */
  }
}

/** Whether a pointer at `clientX` counts as "at the edge" for its kind. */
export function isInRevealZone(pointerType: PointerKind, clientX: number): boolean {
  const limit = pointerType === "touch" ? EDGE_TOUCH_PX : EDGE_POINTER_PX;
  return clientX >= 0 && clientX <= limit;
}

/** A touch that started in the band and travelled far enough to the right. */
export function isEdgeSwipe(startX: number, currentX: number): boolean {
  return isInRevealZone("touch", startX) && currentX - startX >= EDGE_SWIPE_MIN_PX;
}

/**
 * A revealed-but-hidden rail goes away when nothing keeps it: no open panel
 * and the pointer is neither over the rail nor over the edge band.
 */
export function shouldAutoHide(state: {
  hidden: boolean;
  revealed: boolean;
  panelOpen: boolean;
  pointerInside: boolean;
}): boolean {
  return state.hidden && state.revealed && !state.panelOpen && !state.pointerInside;
}

/** The rail strip is on screen: always when not hidden, otherwise only while revealed. */
export function isRailVisible(hidden: boolean, revealed: boolean): boolean {
  return !hidden || revealed;
}
