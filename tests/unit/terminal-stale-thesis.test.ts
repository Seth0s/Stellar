import { describe, it, expect } from "vitest";
import { resolveTerminalShortcutKeydown } from "../../src/renderer/src/terminal-shortcut-dispatch";
import type { ShortcutKeyEvent, ShortcutOverrides } from "../../src/renderer/src/shortcut-registry";

describe("thesis test", () => {
  it("tests the combinations", () => {
    const e: ShortcutKeyEvent = {
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      key: "c",
    };

    // Sigint rebound to Ctrl+X. copySelection rebound to Ctrl+C.
    const overrides1: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
      "terminal.copySelection": { key: "c", ctrlOrCmd: true, shift: false },
    };
    const res1 = resolveTerminalShortcutKeydown(e, overrides1, "");
    expect(res1.action).toBe("copy-noop");

    // Sigint rebound; card.duplicate (canvas) on Ctrl+C — fora de escopo
    // terminal → swallow (mata nativo; não defer-central).
    const overrides2: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
      "card.duplicate": { key: "c", ctrlOrCmd: true },
    };
    const res2 = resolveTerminalShortcutKeydown(e, overrides2, "");
    expect(res2.action).toBe("swallow");

    // Dono central COM escopo terminal → defer-central.
    const overrides3: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
      "tool.escapeReset": { key: "c", ctrlOrCmd: true },
    };
    const res3 = resolveTerminalShortcutKeydown(e, overrides3, "");
    expect(res3.action).toBe("defer-central");
  });
});
