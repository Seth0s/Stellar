import { describe, expect, it } from "vitest";
import {
  countLines,
  decideEditorPerfMode,
  decideMinimapBars,
  extractLineWindow,
  MARKDOWN_PREVIEW_MAX_LINES,
  PLAIN_EDITOR_MAX_BYTES,
  PLAIN_EDITOR_MAX_LINES,
} from "../../src/renderer/src/code-editor-perf-decision";

describe("countLines", () => {
  it("counts without allocating a split array", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(3);
  });
});

describe("decideEditorPerfMode", () => {
  it("keeps small buffers in full mode with markdown preview", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const d = decideEditorPerfMode(text);
    expect(d.mode).toBe("full");
    expect(d.allowMarkdownPreview).toBe(true);
    expect(d.showPlainBanner).toBe(false);
  });

  it("disables markdown preview above the measured preview threshold", () => {
    const text = Array.from({ length: MARKDOWN_PREVIEW_MAX_LINES }, (_, i) => `- item ${i}`).join("\n");
    const d = decideEditorPerfMode(text);
    expect(d.allowMarkdownPreview).toBe(false);
  });

  it("enters plain mode by line count", () => {
    const text = Array.from({ length: PLAIN_EDITOR_MAX_LINES }, (_, i) => `x${i}`).join("\n");
    const d = decideEditorPerfMode(text);
    expect(d.mode).toBe("plain");
    expect(d.showPlainBanner).toBe(true);
  });

  it("enters plain mode by byte size (former hard refuse ceiling)", () => {
    const text = "x".repeat(PLAIN_EDITOR_MAX_BYTES);
    const d = decideEditorPerfMode(text);
    expect(d.mode).toBe("plain");
    expect(d.allowMarkdownPreview).toBe(false);
  });
});

describe("extractLineWindow", () => {
  it("returns only the window above the cursor", () => {
    const content = ["a", "b", "function foo() {}", "c", "d"].join("\n");
    const win = extractLineWindow(content, 3, 1);
    expect(win.text).toBe("b\nfunction foo() {}");
    expect(win.cursorLineInWindow).toBe(2);
  });
});

describe("decideMinimapBars", () => {
  it("caps bar count and never builds a full lines array", () => {
    const content = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join("\n");
    const bars = decideMinimapBars(content, 80, (n) => (n === 1 ? "#f00" : undefined));
    expect(bars.length).toBeLessThanOrEqual(80);
    expect(bars[0]?.color).toBe("#f00");
    expect(bars[0]?.lineNo).toBe(1);
  });
});
