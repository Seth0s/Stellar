import { describe, it, expect } from "vitest";
import { resolveTerminalShortcutKeydown } from "../../src/renderer/src/terminal-shortcut-dispatch";
import { findShortcutClaimingKey } from "../../src/renderer/src/shortcut-registry";
import type { ShortcutKeyEvent, ShortcutOverrides } from "../../src/renderer/src/shortcut-registry";

describe("stale + dono fora do escopo terminal → swallow (mata nativo)", () => {
  // Rodada 7 — Ctrl+D stale: card.duplicate (default, escopo canvas) NÃO
  // seria despachado com foco no terminal; defer-central deixava o
  // Chromium abrir "adicionar favorito".
  it("Ctrl+D stale com card.duplicate default: swallow (não defer-central)", () => {
    const e: ShortcutKeyEvent = {
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      key: "d",
    };
    const overrides: ShortcutOverrides = {
      "terminal.eof": { key: "e", ctrlOrCmd: true, shift: false },
    };

    // Sem escopo: o registro ainda vê card.duplicate no Ctrl+D.
    expect(findShortcutClaimingKey(e, overrides)).toBe("card.duplicate");
    // Com escopo terminal: ninguém que rodaria aqui.
    expect(findShortcutClaimingKey(e, overrides, "terminal")).toBeNull();

    expect(resolveTerminalShortcutKeydown(e, overrides, "")).toEqual({
      consume: true,
      action: "swallow",
    });
  });

  // Mesma classe: dono de escopo browser/text-input (browser.navigate).
  it("browser.navigate no Ctrl+C liberado por sigint: swallow (não defer-central)", () => {
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
    expect(findShortcutClaimingKey(e, overrides, "terminal")).toBeNull();

    // none = xterm manda \x03; defer-central = nativo do Chromium vaza.
    expect(resolveTerminalShortcutKeydown(e, overrides, "")).toEqual({
      consume: true,
      action: "swallow",
    });
  });
});
