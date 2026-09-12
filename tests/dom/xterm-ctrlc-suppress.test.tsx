/**
 * Medição empírica (rodada 5 review) — o que impede o xterm de emitir
 * `\x03` no `onData` quando Ctrl+C chega, SEM matar o bubble pro App.tsx.
 *
 * Resultados medidos (jsdom + @xterm/xterm real):
 * - baseline: onData recebe `\x03`
 * - preventDefault sozinho no capture do container: AINDA recebe `\x03`
 * - attachCustomKeyEventHandler → false: NÃO recebe `\x03`, bubble sobe
 * - stopImmediatePropagation: NÃO recebe `\x03`, mas bubble NÃO sobe
 *
 * Por isso `defer-central` usa o custom handler, nunca só preventDefault,
 * e nunca stopImmediatePropagation.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Terminal } from "@xterm/xterm";
import { resolveTerminalShortcutKeydown } from "@renderer/terminal-shortcut-dispatch";
import type { ShortcutOverrides } from "@renderer/shortcut-registry";

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function dispatchCtrlC(target: EventTarget) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      keyCode: 67,
      which: 67,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function openTerm() {
  const host = document.createElement("div");
  host.style.width = "400px";
  host.style.height = "200px";
  document.body.appendChild(host);
  const term = new Terminal({ cols: 40, rows: 10 });
  const seen: string[] = [];
  term.onData((d) => seen.push(d));
  term.open(host);
  const ta = host.querySelector("textarea") as HTMLTextAreaElement;
  return { host, term, ta, seen, cleanup: () => { term.dispose(); host.remove(); } };
}

describe("xterm Ctrl+C suppress — medição que decide defer-central", () => {
  it("baseline: Ctrl+C sem intervenção emite \\x03", async () => {
    const { ta, seen, cleanup } = await openTerm();
    ta.focus();
    dispatchCtrlC(ta);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.some((s) => s.includes("\x03"))).toBe(true);
    cleanup();
  });

  it("preventDefault sozinho NÃO impede \\x03", async () => {
    const { host, ta, seen, cleanup } = await openTerm();
    host.addEventListener("keydown", (e) => e.preventDefault(), { capture: true });
    ta.focus();
    dispatchCtrlC(ta);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.some((s) => s.includes("\x03"))).toBe(true);
    cleanup();
  });

  it("attachCustomKeyEventHandler(false) impede \\x03 E deixa o bubble subir", async () => {
    const { term, ta, seen, cleanup } = await openTerm();
    let bubbleSaw = false;
    const onBubble = () => {
      bubbleSaw = true;
    };
    window.addEventListener("keydown", onBubble);
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && ev.ctrlKey && (ev.key === "c" || ev.key === "C")) return false;
      return true;
    });
    ta.focus();
    dispatchCtrlC(ta);
    await new Promise((r) => setTimeout(r, 20));
    window.removeEventListener("keydown", onBubble);
    expect(seen.some((s) => s.includes("\x03"))).toBe(false);
    expect(bubbleSaw).toBe(true);
    cleanup();
  });

  it("stopImmediatePropagation impede \\x03 mas TAMBÉM mata o bubble", async () => {
    const { host, ta, seen, cleanup } = await openTerm();
    let bubbleSaw = false;
    const onBubble = () => {
      bubbleSaw = true;
    };
    window.addEventListener("keydown", onBubble);
    host.addEventListener(
      "keydown",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true },
    );
    ta.focus();
    dispatchCtrlC(ta);
    await new Promise((r) => setTimeout(r, 20));
    window.removeEventListener("keydown", onBubble);
    expect(seen.some((s) => s.includes("\x03"))).toBe(false);
    expect(bubbleSaw).toBe(false);
    cleanup();
  });

  it("contrato defer-central: customHandler consulta o dispatch e barra \\x03 sem stopImmediate", async () => {
    // Dono COM escopo terminal — card.duplicate (canvas) cairia em swallow.
    const overrides: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
      "tool.escapeReset": { key: "c", ctrlOrCmd: true },
    };
    const { term, host, ta, seen, cleanup } = await openTerm();
    let bubbleSaw = false;
    const onBubble = () => {
      bubbleSaw = true;
    };
    window.addEventListener("keydown", onBubble);

    // Mesmo wiring que useTerminal: capture sem stopImmediate em defer-central
    // + customHandler devolvendo false.
    host.addEventListener(
      "keydown",
      (e) => {
        const d = resolveTerminalShortcutKeydown(e, overrides, "");
        expect(d.action).toBe("defer-central");
        if (d.consume) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const d = resolveTerminalShortcutKeydown(ev, overrides, term.getSelection());
      if (d.action === "defer-central") return false;
      if (d.consume) return false;
      return true;
    });

    ta.focus();
    dispatchCtrlC(ta);
    await new Promise((r) => setTimeout(r, 20));
    window.removeEventListener("keydown", onBubble);

    expect(seen.some((s) => s.includes("\x03"))).toBe(false);
    expect(bubbleSaw).toBe(true);
    cleanup();
  });
});
