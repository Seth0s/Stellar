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
  it("swallows central shortcuts bound to stale keys", () => {
    const overrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true },
      "card.duplicate": { key: "c", ctrlOrCmd: true }
    };

    const fakeEvent: ShortcutKeyEvent = {
      key: "c",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false
    };

    const res = resolveTerminalShortcutKeydown(fakeEvent, overrides as any, "");
    expect(res.action).toBe("none"); // If it's none, the event bubbles to App.tsx. If it's swallow, it's a bug!
  });

  // Matriz completa (rodada 4): stale só engole tecla órfã de verdade;
  // dono no terminal / no central / tecla comum têm cada um o seu destino.
  describe("stale ownership matrix", () => {
    it("tecla órfã de verdade (sigint/eof rebindados, ninguém pegou o default): swallow", () => {
      // card.duplicate default é Ctrl+D — sem afastá-lo, Ctrl+D ainda tem
      // dono central e o stale corretamente devolve none (não é órfã).
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

    it("tecla reivindicada por atalho central: none (passa / bubbla)", () => {
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
        "card.duplicate": { key: "c", ctrlOrCmd: true },
      };
      expect(resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "").action).toBe("none");
    });

    it("tecla comum: none (passa)", () => {
      expect(resolveTerminalShortcutKeydown(key({ key: "a" }), {}, "").action).toBe("none");
      expect(resolveTerminalShortcutKeydown(key({ key: "z", ctrlKey: true }), {}, "").action).toBe("none");
    });
  });
});
