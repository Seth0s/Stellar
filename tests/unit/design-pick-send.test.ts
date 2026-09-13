import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { designContextText, sendDesignPick, type DesignPick } from "../../src/renderer/src/design-pick-send";

const pick: DesignPick = {
  tag: "button",
  className: "primary",
  selector: "button.primary",
  width: 120,
  height: 40,
};

describe("designContextText", () => {
  it("formats tag, class, selector, url and size", () => {
    expect(designContextText(pick, "https://example.test/page")).toBe(
      `<button class="primary"> — button.primary\nhttps://example.test/page · 120×40px`,
    );
  });

  it("omits class attribute when className is empty", () => {
    expect(designContextText({ ...pick, tag: "div", className: "", selector: "div" }, "https://x")).toBe(
      `<div> — div\nhttps://x · 120×40px`,
    );
  });
});

describe("sendDesignPick", () => {
  it("delivers the formatted body once and never writes Enter itself", async () => {
    const sendToCard = vi.fn(async () => ({ ok: true as const }));
    sendDesignPick(sendToCard, "term-1", pick, "https://example.test");
    await vi.waitFor(() => expect(sendToCard).toHaveBeenCalledOnce());
    expect(sendToCard).toHaveBeenCalledWith(
      "term-1",
      `<button class="primary"> — button.primary\nhttps://example.test · 120×40px`,
    );
    const delivered = sendToCard.mock.calls[0][1] as string;
    expect(delivered).not.toContain("\r");
  });
});

describe("BrowserCard wiring", () => {
  const src = readFileSync("src/renderer/src/BrowserCard.tsx", "utf8");

  it("sends Design Mode picks through window.bus.send, not raw pty.write + Enter", () => {
    expect(src).toContain("window.bus.send");
    expect(src).not.toMatch(/pty\.write\(targetId/);
    expect(src).not.toMatch(/pty\.write\([^)]*,\s*"\\r"\)/);
  });
});
