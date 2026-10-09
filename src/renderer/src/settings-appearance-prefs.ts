/**
 * Appearance prefs that Settings writes and the app shell reads.
 * Kept in localStorage so no main IPC is required for this V7 slice.
 */

export type ReduceMotionPref = "system" | "on" | "off";

const FONT_KEY = "stellar.terminalFontSize";
const MOTION_KEY = "stellar.reduceMotion";

export function readTerminalFontSize(): 13 | 14 | 15 {
  const raw = Number(localStorage.getItem(FONT_KEY));
  if (raw === 13 || raw === 14 || raw === 15) return raw;
  return 15;
}

export function writeTerminalFontSize(px: 13 | 14 | 15): void {
  localStorage.setItem(FONT_KEY, String(px));
  window.dispatchEvent(new CustomEvent("stellar:terminal-font-size", { detail: px }));
}

export function readReduceMotionPref(): ReduceMotionPref {
  const raw = localStorage.getItem(MOTION_KEY);
  if (raw === "on" || raw === "off" || raw === "system") return raw;
  return "system";
}

export function writeReduceMotionPref(pref: ReduceMotionPref): void {
  localStorage.setItem(MOTION_KEY, pref);
  applyReduceMotionPref(pref);
}

/** Effective reduced-motion for CSS / animations. */
export function resolveReduceMotion(pref: ReduceMotionPref = readReduceMotionPref()): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function applyReduceMotionPref(pref: ReduceMotionPref = readReduceMotionPref()): void {
  document.documentElement.dataset.reduceMotion = resolveReduceMotion(pref) ? "1" : "0";
}
