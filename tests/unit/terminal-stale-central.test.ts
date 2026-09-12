import { describe, it, expect } from "vitest";
import { resolveTerminalShortcutKeydown } from "../../src/renderer/src/terminal-shortcut-dispatch";
import type { ShortcutKeyEvent, ShortcutOverrides } from "../../src/renderer/src/shortcut-registry";

function key(partial: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe("terminal-shortcut-dispatch", () => {
  // Rodada 7: card.duplicate é canvas — resolveGlobalShortcut rejeitaria
  // no bubble; defer-central deixava o Ctrl+D/C nativo do Chromium vazar.
  it("stale + card.duplicate (escopo canvas): swallow (não defer-central)", () => {
    const overrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true },
      "card.duplicate": { key: "c", ctrlOrCmd: true },
    };

    const fakeEvent: ShortcutKeyEvent = {
      key: "c",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };

    const res = resolveTerminalShortcutKeydown(fakeEvent, overrides as ShortcutOverrides, "");
    expect(res.action).toBe("swallow");
    expect(res.consume).toBe(true);
  });

  describe("stale ownership matrix", () => {
    it("tecla órfã de verdade (sigint/eof rebindados, ninguém pegou o default): swallow", () => {
      // card.duplicate default é Ctrl+D (canvas) — mesmo sem afastá-lo o
      // escopo terminal não o despacha; afastamos só pra órfã total.
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
        "terminal.eof": { key: "e", ctrlOrCmd: true, shift: false },
        "card.duplicate": { key: "d", ctrlOrCmd: true, shift: true },
      };
      expect(resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "").action).toBe("swallow");
      expect(resolveTerminalShortcutKeydown(key({ key: "d", ctrlKey: true }), overrides, "").action).toBe("swallow");
    });

    it("tecla reivindicada por atalho de terminal: ação dele (não swallow)", () => {
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
        "terminal.paste": { key: "c", ctrlOrCmd: true, shift: false },
      };
      expect(resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "").action).toBe("paste");
      expect(resolveTerminalShortcutKeydown(key({ key: "x", ctrlKey: true }), overrides, "").action).toBe("sigint");
    });

    it("tecla reivindicada por atalho central COM escopo terminal: defer-central", () => {
      // tool.escapeReset inclui "terminal" — resolveGlobalShortcut
      // despacharia com foco no terminal; defer-central é correto.
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
        "tool.escapeReset": { key: "c", ctrlOrCmd: true },
      };
      const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "");
      expect(d).toEqual({ consume: false, action: "defer-central" });
    });

    it("tecla reivindicada por atalho central fora do escopo terminal: swallow", () => {
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
        "card.duplicate": { key: "c", ctrlOrCmd: true },
      };
      const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "");
      expect(d).toEqual({ consume: true, action: "swallow" });
    });

    // Rodada 7 — dono native de outro escopo (browser.navigate = text-input)
    // NÃO é despachado no terminal; defer-central vazava o nativo.
    it("tecla reivindicada por atalho native fora do terminal: swallow (não defer-central)", () => {
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "q", ctrlOrCmd: true, shift: false },
        "browser.navigate": { key: "c", ctrlOrCmd: true, shift: false },
      };
      const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "");
      expect(d).toEqual({ consume: true, action: "swallow" });
    });

    it("tecla comum: none (passa)", () => {
      expect(resolveTerminalShortcutKeydown(key({ key: "a" }), {}, "").action).toBe("none");
      expect(resolveTerminalShortcutKeydown(key({ key: "z", ctrlKey: true }), {}, "").action).toBe("none");
    });
  });
});
