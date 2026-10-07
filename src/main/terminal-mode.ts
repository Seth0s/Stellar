/**
 * The terminal MODES a program has switched on, tracked from its raw output so a
 * replay can put a fresh xterm back in them.
 *
 * Why it exists. The per-card replay ring (`session-scrollback.ts`) is cut from the
 * FRONT at a byte cap. A TUI — every agent CLI is one — enters the alternate screen
 * once (`ESC[?1049h`), turns on mouse tracking and bracketed paste, and from then on
 * only repaints with cursor addressing. When the cut drops that entry, replaying the
 * remaining bytes into a new xterm draws cursor-addressed repaints into its NORMAL
 * buffer, with mouse, paste and cursor-key modes off: the history comes back drawn
 * wrong and the card behaves wrong.
 *
 * What is tracked is DEC private modes (`ESC[?<n>;…h` / `l`), the ones a TUI sets:
 * alternate screen (47 / 1047 / 1049), cursor visibility (25), application cursor keys
 * (1), mouse tracking (9 / 1000 / 1002 / 1003) and its encodings (1005 / 1006 / 1015),
 * focus reports (1004) and bracketed paste (2004). Anything else passes through
 * untouched. Pure — no I/O; the ring owns the state at its cut.
 *
 * Not a terminal emulator: it does not model the screen, only these switches, and
 * a sequence split across the ring's cut boundary is not applied (it is dropped as
 * the partial escape it is).
 */

export type TerminalModes = {
  altScreen: boolean;
  /** `true` when the cursor was hidden (`ESC[?25l`); the default is visible. */
  cursorHidden: boolean;
  appCursorKeys: boolean;
  /** Mouse tracking: any of these may be on; 1000 / 1002 / 1003 are alternatives to the app. */
  mouseX10: boolean;
  mouseNormal: boolean;
  mouseButton: boolean;
  mouseAny: boolean;
  mouseUtf8: boolean;
  mouseSgr: boolean;
  mouseUrxvt: boolean;
  focusReports: boolean;
  bracketedPaste: boolean;
  /** An escape sequence cut at the end of the last chunk, kept to join with the next. */
  pending: string;
};

export function createTerminalModes(): TerminalModes {
  return {
    altScreen: false,
    cursorHidden: false,
    appCursorKeys: false,
    mouseX10: false,
    mouseNormal: false,
    mouseButton: false,
    mouseAny: false,
    mouseUtf8: false,
    mouseSgr: false,
    mouseUrxvt: false,
    focusReports: false,
    bracketedPaste: false,
    pending: "",
  };
}

const ESC = "\u001b";
/** A complete DEC private mode set/reset. Built from a string: a control char in a regex literal trips `no-control-regex`. */
const PRIVATE_MODE = new RegExp(`${ESC}\\[\\?([0-9;]+)([hl])`, "g");
/** An escape sequence that may still be completed by the next chunk. */
const UNFINISHED = new RegExp(`${ESC}(\\[(\\?[0-9;]*)?)?$`);
/** Longest unfinished sequence worth carrying (a real one is ~12 chars). */
const PENDING_MAX = 32;

function applyMode(m: TerminalModes, param: number, on: boolean): void {
  switch (param) {
    case 1:
      m.appCursorKeys = on;
      break;
    case 9:
      m.mouseX10 = on;
      break;
    case 25:
      m.cursorHidden = !on;
      break;
    case 47:
    case 1047:
    case 1049:
      m.altScreen = on;
      break;
    case 1000:
      m.mouseNormal = on;
      break;
    case 1002:
      m.mouseButton = on;
      break;
    case 1003:
      m.mouseAny = on;
      break;
    case 1004:
      m.focusReports = on;
      break;
    case 1005:
      m.mouseUtf8 = on;
      break;
    case 1006:
      m.mouseSgr = on;
      break;
    case 1015:
      m.mouseUrxvt = on;
      break;
    case 2004:
      m.bracketedPaste = on;
      break;
    default:
      break;
  }
}

/** The modes after `chunk`, given the modes before it. Never mutates `state`. */
export function trackTerminalModes(state: TerminalModes, chunk: string): TerminalModes {
  if (chunk.length === 0) return state;
  const text = state.pending + chunk;
  const next: TerminalModes = { ...state, pending: "" };
  for (const match of text.matchAll(PRIVATE_MODE)) {
    const on = match[2] === "h";
    for (const part of match[1].split(";")) {
      const param = Number(part);
      if (Number.isInteger(param)) applyMode(next, param, on);
    }
  }
  const tail = text.slice(-PENDING_MAX);
  const unfinished = tail.match(UNFINISHED);
  if (unfinished) next.pending = tail.slice(unfinished.index);
  return next;
}

/** True when the state differs from a fresh terminal in any tracked mode. */
export function hasNonDefaultModes(m: TerminalModes): boolean {
  const d = createTerminalModes();
  return (Object.keys(d) as Array<keyof TerminalModes>).some((k) => k !== "pending" && m[k] !== d[k]);
}

/**
 * The escape sequences that put a fresh terminal into `modes`, to be written BEFORE
 * the replayed bytes. Empty for the defaults. The alternate screen comes first, so
 * the repaints that follow land in it; its entry clears it, which is what an app
 * that just entered it would see anyway.
 */
export function modesReplayPrefix(m: TerminalModes): string {
  const set = (n: number) => `${ESC}[?${n}h`;
  const out: string[] = [];
  if (m.altScreen) out.push(set(1049));
  if (m.appCursorKeys) out.push(set(1));
  if (m.mouseX10) out.push(set(9));
  if (m.mouseNormal) out.push(set(1000));
  if (m.mouseButton) out.push(set(1002));
  if (m.mouseAny) out.push(set(1003));
  if (m.focusReports) out.push(set(1004));
  if (m.mouseUtf8) out.push(set(1005));
  if (m.mouseSgr) out.push(set(1006));
  if (m.mouseUrxvt) out.push(set(1015));
  if (m.bracketedPaste) out.push(set(2004));
  if (m.cursorHidden) out.push(`${ESC}[?25l`);
  return out.join("");
}
