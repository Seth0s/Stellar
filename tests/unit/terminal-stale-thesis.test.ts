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
    expect(res1.action).toBe("copy-noop"); // It's caught by copySelection!

    // Sigint rebound to Ctrl+X. card.duplicate rebound to Ctrl+C.
    const overrides2: ShortcutOverrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true, shift: false },
      "card.duplicate": { key: "c", ctrlOrCmd: true },
    };
    const res2 = resolveTerminalShortcutKeydown(e, overrides2, "");
    expect(res2.action).toBe("defer-central"); // Caught by defer-central!
  });
});
