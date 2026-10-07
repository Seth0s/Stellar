import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserCardActive, shouldBrowserCardPaint } from "../../src/shared/browser-activity";
import { createFocusGate, FOCUS_RELEASE_GRACE_MS, UNFOCUSED_FRAME_RATE, CPU_JPEG_FOCUSED_FRAME_RATE, decideBrowserFrame } from "../../src/main/browser-frame-decision";

/**
 * Measured on an isolated instance with five visible browser cards (four with an
 * animation): ~58% of a core with the pointer on the empty board and ~98% with the
 * pointer over one animated card. The pages cost ~3%; the per-frame pipeline
 * (encode in main, IPC, decode and draw in the renderer, GPU) is the rest, so what
 * matters is how many frames per second each card is asked for.
 */
describe("isBrowserCardActive — o card em uso", () => {
  it("o ponteiro sobre o card ou o foco do teclado nele → ativo", () => {
    expect(isBrowserCardActive({ hovering: true, domFocused: false })).toBe(true);
    expect(isBrowserCardActive({ hovering: false, domFocused: true })).toBe(true);
    expect(isBrowserCardActive({ hovering: true, domFocused: true })).toBe(true);
  });
  it("ser o card mais alto da pilha NÃO é uso: sem hover nem foco → inativo", () => {
    expect(isBrowserCardActive({ hovering: false, domFocused: false })).toBe(false);
  });
});

describe("shouldBrowserCardPaint — janela do app escondida", () => {
  it("só pinta dentro da viewport do board E com a janela visível", () => {
    expect(shouldBrowserCardPaint({ inViewport: true, windowVisible: true })).toBe(true);
    expect(shouldBrowserCardPaint({ inViewport: true, windowVisible: false })).toBe(false);
    expect(shouldBrowserCardPaint({ inViewport: false, windowVisible: true })).toBe(false);
    expect(shouldBrowserCardPaint({ inViewport: false, windowVisible: false })).toBe(false);
  });
});

describe("taxa que o card visível pede", () => {
  it("em uso: 30 fps; sem uso: 4 fps — cinco cards parados pedem 20 fps no total, não 62", () => {
    const used = decideBrowserFrame({ visible: true, focused: true, sharedTextureAvailable: false }).frameRate;
    const idle = decideBrowserFrame({ visible: true, focused: false, sharedTextureAvailable: false }).frameRate;
    expect(used).toBe(CPU_JPEG_FOCUSED_FRAME_RATE);
    expect(idle).toBe(UNFOCUSED_FRAME_RATE);
    expect(idle * 5).toBe(20);
    // The old arrangement: topmost at 30 plus four at 8.
    expect(CPU_JPEG_FOCUSED_FRAME_RATE + 4 * 8).toBe(62);
  });
});

describe("createFocusGate — a taxa cheia não cai no instante em que o ponteiro sai", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("set(true) vale na hora", () => {
    const seen: boolean[] = [];
    createFocusGate((f) => seen.push(f)).set(true);
    expect(seen).toEqual([true]);
  });

  it("set(false) só vale depois da carência", () => {
    const seen: boolean[] = [];
    const gate = createFocusGate((f) => seen.push(f));
    gate.set(false);
    vi.advanceTimersByTime(FOCUS_RELEASE_GRACE_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([false]);
  });

  it("voltar a ficar em uso durante a carência cancela a queda", () => {
    const seen: boolean[] = [];
    const gate = createFocusGate((f) => seen.push(f));
    gate.set(false);
    vi.advanceTimersByTime(FOCUS_RELEASE_GRACE_MS / 2);
    gate.set(true);
    vi.advanceTimersByTime(FOCUS_RELEASE_GRACE_MS * 2);
    expect(seen).toEqual([true]);
  });

  it("duas saídas seguidas reiniciam a carência (uma queda só)", () => {
    const seen: boolean[] = [];
    const gate = createFocusGate((f) => seen.push(f));
    gate.set(false);
    vi.advanceTimersByTime(FOCUS_RELEASE_GRACE_MS - 10);
    gate.set(false);
    vi.advanceTimersByTime(FOCUS_RELEASE_GRACE_MS - 10);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([false]);
  });

  it("dispose cancela a queda pendente (card destruído)", () => {
    const seen: boolean[] = [];
    const gate = createFocusGate((f) => seen.push(f));
    gate.set(false);
    gate.dispose();
    vi.advanceTimersByTime(FOCUS_RELEASE_GRACE_MS * 2);
    expect(seen).toEqual([]);
  });
});
