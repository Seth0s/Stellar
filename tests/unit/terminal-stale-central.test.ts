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
  it("defers to central when central shortcut claims a stale key", () => {
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
    // Rodada 5: defer-central (não none, não swallow). none deixava o
    // xterm emitir \x03; swallow engolia o central. defer-central bubbla
    // sem stopImmediate e o customKeyEventHandler barra o xterm.
    expect(res.action).toBe("defer-central");
    expect(res.consume).toBe(false);
  });

  // Matriz completa (rodadas 4–5): stale só engole tecla órfã; dono
  // terminal / central / tecla comum têm cada um o seu destino.
  describe("stale ownership matrix", () => {
    it("tecla órfã de verdade (sigint/eof rebindados, ninguém pegou o default): swallow", () => {
      // card.duplicate default é Ctrl+D — sem afastá-lo, Ctrl+D ainda tem
      // dono central e o stale corretamente devolve defer-central.
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

    it("tecla reivindicada por atalho central: defer-central (bubbla, sem consume)", () => {
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
        "card.duplicate": { key: "c", ctrlOrCmd: true },
      };
      const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "");
      expect(d).toEqual({ consume: false, action: "defer-central" });
    });

    // Rodada 6 — mesma classe do buraco da rodada 5, um nível abaixo:
    // dono native (não central) também precisa de defer-central; none
    // deixava o xterm emitir \x03.
    it("tecla reivindicada por atalho native fora do terminal: defer-central (não none)", () => {
      const overrides: ShortcutOverrides = {
        "terminal.sigint": { key: "q", ctrlOrCmd: true, shift: false },
        "browser.navigate": { key: "c", ctrlOrCmd: true, shift: false },
      };
      const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "");
      expect(d).toEqual({ consume: false, action: "defer-central" });
    });

    it("tecla comum: none (passa)", () => {
      expect(resolveTerminalShortcutKeydown(key({ key: "a" }), {}, "").action).toBe("none");
      expect(resolveTerminalShortcutKeydown(key({ key: "z", ctrlKey: true }), {}, "").action).toBe("none");
    });
  });
});
