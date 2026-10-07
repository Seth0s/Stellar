import { describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import { attachWebglRenderer } from "../../src/renderer/src/terminal-webgl";

/**
 * A GPU failure while loading WebGL must cost nothing but the GPU: the terminal
 * keeps its buffer and stays usable (the old path disposed it and rebuilt a bare
 * one, losing the replayed history, the registry entry and the input handlers).
 */
function fakeAddon(overrides: Partial<Record<"dispose" | "onContextLoss", () => void>> = {}) {
  const handlers: Array<() => void> = [];
  const addon = {
    onContextLoss: vi.fn((handler: () => void) => {
      handlers.push(handler);
      return { dispose: () => {} };
    }),
    dispose: vi.fn(),
    activate: vi.fn(),
    ...overrides,
  };
  return { addon: addon as unknown as WebglAddon, raw: addon, fire: () => handlers.forEach((h) => h()) };
}
const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

describe("attachWebglRenderer", () => {
  it("loads the addon, reports true, and drops back to the DOM renderer on context loss", () => {
    const term = new Terminal();
    const loadAddon = vi.spyOn(term, "loadAddon").mockImplementation(() => {});
    const { addon, raw, fire } = fakeAddon();
    expect(attachWebglRenderer(term, () => addon)).toBe(true);
    expect(loadAddon).toHaveBeenCalledWith(addon);
    expect(raw.dispose).not.toHaveBeenCalled();
    fire();
    expect(raw.dispose).toHaveBeenCalledTimes(1);
    term.dispose();
  });

  it("when loading throws: reports false, releases the addon, and the terminal keeps its buffer and still takes writes", async () => {
    const term = new Terminal({ cols: 120, rows: 30 });
    await write(term, "replayed history line\r\n");
    vi.spyOn(term, "loadAddon").mockImplementation(() => {
      throw new Error("WebGL2 context creation failed");
    });
    const { addon, raw } = fakeAddon();
    expect(attachWebglRenderer(term, () => addon)).toBe(false);
    expect(raw.dispose).toHaveBeenCalledTimes(1);
    // The same instance survives: history intact, still writable, not disposed.
    await write(term, "live line\r\n");
    const lines: string[] = [];
    for (let y = 0; y < term.buffer.active.length; y++) lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? "");
    expect(lines.join("\n")).toContain("replayed history line");
    expect(lines.join("\n")).toContain("live line");
    term.dispose();
  });

  it("when even constructing the addon throws: false, and nothing else is touched", () => {
    const term = new Terminal();
    const loadAddon = vi.spyOn(term, "loadAddon");
    expect(
      attachWebglRenderer(term, () => {
        throw new Error("no WebGL");
      }),
    ).toBe(false);
    expect(loadAddon).not.toHaveBeenCalled();
    term.dispose();
  });

  it("a dispose that throws during cleanup does not escape", () => {
    const term = new Terminal();
    vi.spyOn(term, "loadAddon").mockImplementation(() => {
      throw new Error("boom");
    });
    const { addon } = fakeAddon({
      dispose: () => {
        throw new Error("already gone");
      },
    });
    expect(() => attachWebglRenderer(term, () => addon)).not.toThrow();
    term.dispose();
  });
});
