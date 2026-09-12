import { describe, it, expect } from "vitest";
import { resolveTerminalShortcutKeydown } from "../../src/renderer/src/terminal-shortcut-dispatch";
import type { ShortcutOverrides } from "../../src/renderer/src/shortcut-registry";

function key(partial: { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }) {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe("resolveTerminalShortcutKeydown — matched ⇒ consume (review adversarial)", () => {
  it("copy com seleção: consume + action copy", () => {
    const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true, shiftKey: true }), {}, "hello");
    expect(d).toEqual({ consume: true, action: "copy", text: "hello" });
  });

  // Achado CRÍTICO do review: copy rebound pra Ctrl+C, seleção vazia —
  // o early-return antigo NÃO consumia, e o xterm spitava `\x03`.
  it("copy SEM seleção ainda consome (copy-noop) — Ctrl+C não vaza pro xterm", () => {
    const overrides: ShortcutOverrides = {
      "terminal.copySelection": { key: "c", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
    };
    const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "");
    expect(d.consume).toBe(true);
    expect(d.action).toBe("copy-noop");
  });

  it("no cenário histórico (copy→Ctrl+C, sigint→Ctrl+X), Ctrl+C vazio NÃO é sigint nem none", () => {
    const overrides: ShortcutOverrides = {
      "terminal.copySelection": { key: "c", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
    };
    const ctrlC = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "");
    const ctrlX = resolveTerminalShortcutKeydown(key({ key: "x", ctrlKey: true }), overrides, "");
    expect(ctrlC).toEqual({ consume: true, action: "copy-noop" });
    expect(ctrlX).toEqual({ consume: true, action: "sigint" });
  });

  it("sigint/eof efetivos consomem; default stale depois de rebind também", () => {
    expect(resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), {}, "").action).toBe("sigint");
    expect(resolveTerminalShortcutKeydown(key({ key: "d", ctrlKey: true }), {}, "").action).toBe("eof");

    // Órfão de verdade: além de afastar sigint/eof, card.duplicate (Ctrl+D
    // central por default) também tem que sair — senão Ctrl+D ainda tem dono
    // no registro e o stale NÃO engole (rodada 4).
    const overrides: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.eof": { key: "e", ctrlOrCmd: true, shift: false, alt: false },
      "card.duplicate": { key: "d", ctrlOrCmd: true, shift: true, alt: false },
    };
    expect(resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "").action).toBe("swallow");
    expect(resolveTerminalShortcutKeydown(key({ key: "d", ctrlKey: true }), overrides, "").action).toBe("swallow");
  });

  // Rodada 3 — buraco negro: stale ANTES de paste engolia Ctrl+C depois
  // de sigint liberar a tecla e paste reivindicá-la. Stale agora é o fim.
  it("tecla liberada por rebind de sigint pode ser reatribuída a paste (não é swallow)", () => {
    const overrides: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.paste": { key: "c", ctrlOrCmd: true, shift: false, alt: false },
    };
    expect(resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true }), overrides, "").action).toBe("paste");
    expect(resolveTerminalShortcutKeydown(key({ key: "x", ctrlKey: true }), overrides, "").action).toBe("sigint");
    // Ctrl+V default de paste ficou stale? paste efetivo é Ctrl+C, então
    // Ctrl+V não casa paste nem sigint/eof stale — none (xterm cola nativo).
    expect(resolveTerminalShortcutKeydown(key({ key: "v", ctrlKey: true }), overrides, "").action).toBe("none");
  });

  it("copy default (Ctrl+Shift+C) vence sigint — nunca o mesmo evento", () => {
    const d = resolveTerminalShortcutKeydown(key({ key: "c", ctrlKey: true, shiftKey: true }), {}, "");
    expect(d.action).toBe("copy-noop");
  });

  it("tecla qualquer sem match: não consome", () => {
    expect(resolveTerminalShortcutKeydown(key({ key: "a" }), {}, "")).toEqual({ consume: false, action: "none" });
  });
});
