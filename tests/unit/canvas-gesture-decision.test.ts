import { describe, expect, it } from "vitest";
import { decidePointerDownOwner, decideWheelOwner, hasCanvasModifier, MIDDLE_BUTTON } from "../../src/renderer/src/canvas-gesture-decision";

/**
 * The canvas modifier is Ctrl (Cmd on macOS), the key of the canvas zoom
 * shortcuts. Over a card — a browser card above all, whose page swallows the
 * wheel and the drag — the modifier hands the gesture to the canvas; without it
 * the card keeps it.
 */
const none = { ctrlKey: false, metaKey: false };

describe("decideWheelOwner", () => {
  it("sem modificador a roda é do conteúdo (rola a página, o scrollback)", () => {
    expect(decideWheelOwner(none)).toBe("content");
  });
  it("Ctrl ou Cmd + roda é do canvas", () => {
    expect(decideWheelOwner({ ctrlKey: true, metaKey: false })).toBe("canvas");
    expect(decideWheelOwner({ ctrlKey: false, metaKey: true })).toBe("canvas");
    expect(hasCanvasModifier({ ctrlKey: true, metaKey: true })).toBe(true);
  });
});

describe("decidePointerDownOwner", () => {
  const down = (over: Partial<Parameters<typeof decidePointerDownOwner>[0]> = {}) =>
    decidePointerDownOwner({ button: 0, ctrlKey: false, metaKey: false, mode: "normal", ...over });

  it("clique/arraste simples fica com o card (mover pela barra, página embutida)", () => {
    expect(down()).toBe("content");
  });
  it("Ctrl ou Cmd + botão esquerdo → o canvas move", () => {
    expect(down({ ctrlKey: true })).toBe("canvas");
    expect(down({ metaKey: true })).toBe("canvas");
  });
  it("o botão do meio move o canvas mesmo sem modificador", () => {
    expect(down({ button: MIDDLE_BUTTON })).toBe("canvas");
  });
  it("o botão direito nunca vira pan (menu de contexto), com ou sem Ctrl", () => {
    expect(down({ button: 2 })).toBe("content");
    expect(down({ button: 2, ctrlKey: true })).toBe("content");
  });
  it("fora do modo ponteiro (selecionar, conector) o gesto já tem outro trabalho", () => {
    expect(down({ ctrlKey: true, mode: "select" })).toBe("content");
    expect(down({ ctrlKey: true, mode: "connector" })).toBe("content");
    expect(down({ button: MIDDLE_BUTTON, mode: "select" })).toBe("content");
  });
});
