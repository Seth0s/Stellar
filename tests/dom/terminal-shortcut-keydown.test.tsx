/**
 * Achado crítico do review adversarial (follow-up fase C): rebindar
 * `terminal.copySelection` → Ctrl+C e `terminal.sigint` → Ctrl+X, depois
 * apertar Ctrl+C SEM seleção, não pode deixar o keydown alcançar o
 * "xterm" (listener posterior) — senão ele spitava `\x03` e matava o
 * processo, mentindo o rebind.
 *
 * Não monta `useTerminal`/xterm de verdade (pesado demais e flaky em
 * jsdom): aplica o MESMO contrato que `useTerminal` usa
 * (`resolveTerminalShortcutKeydown` + consume ⇒ stopImmediatePropagation)
 * num elemento mínimo, e prova que o listener "xterm" não vê o evento.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveTerminalShortcutKeydown } from "@renderer/terminal-shortcut-dispatch";
import type { ShortcutOverrides } from "@renderer/shortcut-registry";

function attachTerminalShortcutListener(el: HTMLElement, overrides: ShortcutOverrides, getSelection: () => string) {
  function onKeyDown(e: KeyboardEvent) {
    const dispatch = resolveTerminalShortcutKeydown(e, overrides, getSelection());
    if (dispatch.consume) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  el.addEventListener("keydown", onKeyDown, { capture: true });
  return () => el.removeEventListener("keydown", onKeyDown, { capture: true });
}

describe("terminal shortcut keydown (jsdom) — copy vazio não vaza Ctrl+C", () => {
  it("Ctrl+C com copy rebound e seleção vazia: defaultPrevented e xterm-mock não vê o evento", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const overrides: ShortcutOverrides = {
      "terminal.copySelection": { key: "c", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
    };
    const detach = attachTerminalShortcutListener(el, overrides, () => "");

    const xtermSaw = vi.fn();
    // Mesma fase/alvo que o xterm usaria — se stopImmediatePropagation
    // rodar no capture nosso, este listener NÃO dispara.
    el.addEventListener("keydown", xtermSaw);

    const event = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(xtermSaw).not.toHaveBeenCalled();

    detach();
    el.remove();
  });

  it("Ctrl+X no mesmo rebind (sigint efetivo) também consome antes do xterm-mock", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const overrides: ShortcutOverrides = {
      "terminal.copySelection": { key: "c", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
    };
    const detach = attachTerminalShortcutListener(el, overrides, () => "");
    const xtermSaw = vi.fn();
    el.addEventListener("keydown", xtermSaw);

    const event = new KeyboardEvent("keydown", {
      key: "x",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(xtermSaw).not.toHaveBeenCalled();

    detach();
    el.remove();
  });

  // Rodada 3 — stale no fim: Ctrl+C liberado por sigint→Ctrl+X e
  // reivindicado por paste NÃO é engolido (seria buraco negro).
  it("Ctrl+C reatribuído a paste depois de liberar sigint: resolve paste e consome", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const overrides: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
      "terminal.paste": { key: "c", ctrlOrCmd: true, shift: false, alt: false },
    };
    let lastAction: string | undefined;
    function onKeyDown(e: KeyboardEvent) {
      const dispatch = resolveTerminalShortcutKeydown(e, overrides, "");
      lastAction = dispatch.action;
      if (dispatch.consume) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
    el.addEventListener("keydown", onKeyDown, { capture: true });
    const xtermSaw = vi.fn();
    el.addEventListener("keydown", xtermSaw);

    const event = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(lastAction).toBe("paste");
    expect(event.defaultPrevented).toBe(true);
    expect(xtermSaw).not.toHaveBeenCalled();

    el.removeEventListener("keydown", onKeyDown, { capture: true });
    el.remove();
  });

  // Rodada 7 — stale + card.duplicate (canvas): swallow (preventDefault).
  it("Ctrl+C reivindicado por card.duplicate depois de liberar sigint: swallow, mata nativo", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const overrides: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
      "card.duplicate": { key: "c", ctrlOrCmd: true },
    };
    let lastAction: string | undefined;
    function onKeyDown(e: KeyboardEvent) {
      const dispatch = resolveTerminalShortcutKeydown(e, overrides, "");
      lastAction = dispatch.action;
      if (dispatch.consume) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
    el.addEventListener("keydown", onKeyDown, { capture: true });
    const bubbleSaw = vi.fn();
    el.addEventListener("keydown", bubbleSaw);

    const event = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(lastAction).toBe("swallow");
    expect(event.defaultPrevented).toBe(true);
    expect(bubbleSaw).not.toHaveBeenCalled();

    el.removeEventListener("keydown", onKeyDown, { capture: true });
    el.remove();
  });

  // Rodada 7 — defer-central só quando o dono TEM escopo terminal.
  it("Ctrl+C reivindicado por tool.escapeReset (escopo terminal): defer-central, evento sobe", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const overrides: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false, alt: false },
      "tool.escapeReset": { key: "c", ctrlOrCmd: true },
    };
    let lastAction: string | undefined;
    function onKeyDown(e: KeyboardEvent) {
      const dispatch = resolveTerminalShortcutKeydown(e, overrides, "");
      lastAction = dispatch.action;
      if (dispatch.consume) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
    el.addEventListener("keydown", onKeyDown, { capture: true });
    const bubbleSaw = vi.fn();
    el.addEventListener("keydown", bubbleSaw);

    const event = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(lastAction).toBe("defer-central");
    expect(event.defaultPrevented).toBe(false);
    expect(bubbleSaw).toHaveBeenCalled();

    el.removeEventListener("keydown", onKeyDown, { capture: true });
    el.remove();
  });
});
