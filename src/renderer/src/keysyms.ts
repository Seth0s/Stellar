// X11 keysyms for `NotifyKeyboardKeysym` (see main/remote-input.ts). Chosen
// over `NotifyKeyboardKeycode` to avoid a second table mapping DOM
// `KeyboardEvent.code` to Linux evdev keycodes — every printable character
// already maps directly to its Latin-1/Unicode code point as a keysym, so
// only the named/control keys below need an explicit entry.
const NAMED_KEYSYMS: Record<string, number> = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  CapsLock: 0xffe5,
};

/** Returns null for a key this map has no reasonable keysym for — the
 * caller should let the event fall through unhandled rather than send
 * something wrong. */
export function keyEventToKeysym(key: string): number | null {
  if (key in NAMED_KEYSYMS) return NAMED_KEYSYMS[key];
  if (key.length === 1) {
    const code = key.codePointAt(0);
    if (code !== undefined && code >= 0x20 && code <= 0xff) return code;
  }
  return null;
}
