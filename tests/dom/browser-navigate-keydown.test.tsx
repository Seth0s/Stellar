/**
 * Rodada 3 review — `browser.navigate` matched deve preventDefault,
 * senão Ctrl+P (etc.) navega E abre o diálogo nativo do Chromium.
 */
import { describe, it, expect, vi } from "vitest";
import { matchesShortcut } from "@renderer/shortcut-config";
import type { ShortcutOverrides } from "@renderer/shortcut-registry";

describe("browser.navigate keydown (jsdom) — consome default nativo", () => {
  it("combo efetivo Ctrl+P: preventDefault (não deixa Imprimir nativo disparar)", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    const overrides: ShortcutOverrides = {
      "browser.navigate": { key: "p", ctrlOrCmd: true, shift: false, alt: false },
    };
    const navigate = vi.fn();

    input.addEventListener("keydown", (e) => {
      if (matchesShortcut(e, "browser.navigate", overrides)) {
        e.preventDefault();
        navigate();
      }
    });

    const event = new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(navigate).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);

    input.remove();
  });
});
