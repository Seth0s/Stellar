import { describe, it, expect } from "vitest";
import { resolveTerminalShortcutKeydown } from "../../src/renderer/src/terminal-shortcut-dispatch";
import { findShortcutClaimingKey } from "../../src/renderer/src/shortcut-registry";
import type { ShortcutKeyEvent, ShortcutOverrides } from "../../src/renderer/src/shortcut-registry";

describe("stale + dono native (não central)", () => {
  // Rodada 6 — mesma classe do buraco da rodada 5: filtrar só
  // GLOBAL_SHORTCUTS_BY_ID deixava browser.* no Ctrl+C livre cair em
  // none → xterm emitia \x03. Qualquer dono → defer-central.
  it("browser.navigate no Ctrl+C liberado por sigint: defer-central (não none, não swallow)", () => {
    const e: ShortcutKeyEvent = {
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      code: "KeyC",
      key: "c",
    };

    const overrides: ShortcutOverrides = {
      "terminal.sigint": { key: "q", ctrlOrCmd: true, shift: false },
      "browser.navigate": { key: "c", ctrlOrCmd: true, shift: false },
    };

    expect(findShortcutClaimingKey(e, overrides)).toBe("browser.navigate");

    const dispatch = resolveTerminalShortcutKeydown(e, overrides, "");
    // none = xterm manda \x03; swallow = mata o bubble do dono.
    expect(dispatch).toEqual({ consume: false, action: "defer-central" });
  });
});
