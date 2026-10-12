/**
 * Right-click menu: "Agente ou terminal" opens the rail's new-agent flow in a
 * panel glued to the menu. jsdom has no layout, so these cover state, focus and
 * keys; geometry (4 px gap, row alignment, flip, edge clamp) is measured in the
 * app by scripts/verify/smoke-rail-overlay.mjs and capture-rail-parity.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { BoardCanvasMenu } from "@renderer/BoardCanvasMenu";
import type { AgentFormValues } from "@renderer/agent-flow-model";
import { setLocale } from "../../src/shared/i18n";

vi.mock("@renderer/useAgentAvailability", () => ({
  useAgentAvailability: () => ({ missing: [], checking: false }),
  useAvailableAgentProviders: () => [],
}));
vi.mock("@renderer/useProviderClassification", () => ({
  useProviderClassification: () => ({ dynamicIds: [], skippedIds: [] }),
}));

// Every provider has quota left (an unread usage would show "sem cota" and disable the row).
vi.mock("@renderer/provider-usage-decision", () => ({
  decideProviderUsage: () => ({ kind: "measured", bars: [{ key: "week", labelKey: "rail.v3.quota.week", percent: 23 }], metrics: [] }),
}));

function form(over: Partial<AgentFormValues> = {}): AgentFormValues {
  return {
    providers: ["claude", "bash"],
    newProvider: "claude",
    setNewProvider: vi.fn(),
    newResumeId: "",
    setNewResumeId: vi.fn(),
    newContinueLast: false,
    setNewContinueLast: vi.fn(),
    newModel: "",
    setNewModel: vi.fn(),
    newEffort: "",
    setNewEffort: vi.fn(),
    newSystemPrompt: "",
    setNewSystemPrompt: vi.fn(),
    newCwd: "~/projects/demo",
    setNewCwd: vi.fn(),
    ...over,
  };
}

const row = () => document.querySelector('[data-part="board-canvas-terminal"]') as HTMLButtonElement;
const sub = () => document.querySelector('[data-part="ctx-submenu"]') as HTMLElement | null;
const firstRow = () => document.querySelector('[data-part="board-canvas-new-task"]') as HTMLElement;
const tiles = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-provider]"));

beforeEach(() => {
  setLocale("pt-BR");
  Object.assign(window, { providerUsage: { get: vi.fn(async () => undefined) } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("without the agent flow", () => {
  it("'Agente ou terminal' creates straight away, as before", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<BoardCanvasMenu x={10} y={10} onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(row());
    expect(onSelect).toHaveBeenCalledWith("terminal");
    expect(onClose).toHaveBeenCalled();
    expect(sub()).toBeNull();
    expect(row().getAttribute("aria-haspopup")).toBeNull();
  });
});

describe("with the agent flow", () => {
  const open = (f = form(), onSelect = vi.fn(), onClose = vi.fn()) => {
    render(<BoardCanvasMenu x={10} y={10} agentFlow={{ form: f }} onSelect={onSelect} onClose={onClose} />);
    return { f, onSelect, onClose };
  };

  it("a click opens the panel (step 1, providers) instead of creating, and takes focus", () => {
    const { onSelect } = open();
    expect(row().getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(row());
    expect(onSelect).not.toHaveBeenCalled();
    expect(sub()).toBeTruthy();
    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(tiles().length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(tiles()[0]);
    // The row owns the highlight while its panel is open.
    expect(firstRow().className).not.toMatch(/itemActive/);
    expect(row().className).toMatch(/itemActive/);
  });

  it("resting the pointer on the row opens it after a short dwell, without taking focus", () => {
    vi.useFakeTimers();
    open();
    fireEvent.pointerEnter(row());
    expect(sub()).toBeNull();
    act(() => void vi.advanceTimersByTime(160));
    expect(sub()).toBeTruthy();
    expect(document.activeElement).not.toBe(tiles()[0]);
  });

  it("passing on to another row closes it after a grace; reaching the panel keeps it", () => {
    vi.useFakeTimers();
    open();
    fireEvent.click(row());
    fireEvent.pointerEnter(document.querySelector('[data-part="board-canvas-browser"]')!);
    fireEvent.pointerEnter(sub()!);
    act(() => void vi.advanceTimersByTime(400));
    expect(sub()).toBeTruthy();
    fireEvent.pointerEnter(document.querySelector('[data-part="board-canvas-browser"]')!);
    act(() => void vi.advanceTimersByTime(250));
    expect(sub()).toBeNull();
  });

  it("→ on the focused row opens it with focus inside", () => {
    open();
    row().focus();
    fireEvent.keyDown(row(), { key: "ArrowRight" });
    expect(sub()).toBeTruthy();
    expect(document.activeElement).toBe(tiles()[0]);
  });

  it("↑ ↓ move between providers", () => {
    open();
    fireEvent.click(row());
    const list = tiles();
    expect(list.length).toBeGreaterThan(1);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(list[1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(list[0]);
  });

  it("choosing a provider sets it and shows the form; 'Abrir o card' creates at the click and closes", () => {
    const { f, onSelect, onClose } = open();
    fireEvent.click(row());
    fireEvent.click(tiles().find((b) => b.dataset.provider === "bash")!);
    expect(f.setNewProvider).toHaveBeenCalledWith("bash");
    expect(sub()!.textContent).toContain("Passo 2 de 2");
    fireEvent.click(document.querySelector('[data-role="agent-flow-create"]')!);
    expect(onSelect).toHaveBeenCalledWith("terminal");
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter inside the folder field creates too", () => {
    const { onSelect } = open();
    fireEvent.click(row());
    fireEvent.click(tiles()[0]!);
    const input = sub()!.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("terminal");
  });

  it("← steps back: form → providers → closes and returns focus to the row", () => {
    open();
    fireEvent.click(row());
    fireEvent.click(tiles()[0]!);
    expect(sub()!.textContent).toContain("Passo 2 de 2");
    fireEvent.keyDown(sub()!.querySelector("input")!, { key: "ArrowLeft" });
    expect(sub()!.textContent).toContain("Passo 1 de 2");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(sub()).toBeNull();
    expect(document.activeElement).toBe(row());
  });

  it("Esc closes everything and a press outside both does too, but a press inside the panel does not", () => {
    const { onClose } = open();
    fireEvent.click(row());
    fireEvent.mouseDown(sub()!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("opens on the left when the right side has no room", () => {
    const rect = (l: number, t: number, w: number, h: number) =>
      ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.getAttribute("data-part") === "board-canvas-menu") return rect(720, 50, 268, 485);
      if (this.getAttribute("data-part") === "board-canvas-terminal") return rect(726, 120, 256, 28);
      return rect(0, 0, 0, 0);
    });
    open();
    fireEvent.click(row());
    expect(sub()!.dataset.side).toBe("left");
    expect(sub()!.style.left).toBe(`${720 - 4 - 296}px`);
    expect(sub()!.style.top).toBe(`${120 - 7}px`);
    spy.mockRestore();
  });
});
