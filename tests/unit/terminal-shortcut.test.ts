import { describe, it, expect } from "vitest";
import { resolveTerminalShortcutKeydown } from "../../src/renderer/src/terminal-shortcut-dispatch";
import type { ShortcutKeyEvent } from "../../src/renderer/src/shortcut-registry";

describe("terminal-shortcut-dispatch", () => {
  it("verifies the bug", () => {
    const overrides = {
      "terminal.sigint": { key: "x", ctrlOrCmd: true },
      "terminal.paste": { key: "c", ctrlOrCmd: true }
    };

    const fakeEvent: ShortcutKeyEvent = {
      key: "c",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false
    };

    const res = resolveTerminalShortcutKeydown(fakeEvent, overrides as any, "");
    console.log("Result:", res);
    expect(res.action).toBe("paste"); // This will fail if swallowed
  });
});
