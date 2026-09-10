import { describe, it, expect } from "vitest";
import { isGlobalShortcutBlocked, type ShortcutTargetInfo } from "../../src/renderer/src/keyboard-shortcut-guard";

function target(overrides: Partial<ShortcutTargetInfo>): ShortcutTargetInfo {
  return { tagName: "DIV", isContentEditable: false, ...overrides };
}

describe("isGlobalShortcutBlocked", () => {
  it("does NOT block when there is no target at all", () => {
    expect(isGlobalShortcutBlocked(null)).toBe(false);
  });

  // The caller always passes `document.activeElement`. Per the DOM, that's
  // BODY (or, rarely, HTML) exactly when nothing meaningful is focused —
  // this is the "nothing is focused, tool shortcuts are free to fire" case.
  it("does NOT block when nothing is really focused (activeElement is <body>)", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "BODY" }))).toBe(false);
  });

  it("does NOT block when activeElement is <html> (same 'nothing focused' fallback)", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "HTML" }))).toBe(false);
  });

  it("blocks real text inputs", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "INPUT" }))).toBe(true);
    expect(isGlobalShortcutBlocked(target({ tagName: "TEXTAREA" }))).toBe(true);
  });

  it("blocks contentEditable regardless of tag", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });

  it("blocks the browser card's embedded canvas (forwards every key into the page)", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "CANVAS" }))).toBe(true);
  });

  it("blocks a focused <button> — the Rail bug item 2 fixed", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "BUTTON" }))).toBe(true);
  });

  it("blocks a focused <select>", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "SELECT" }))).toBe(true);
  });

  it("blocks a focused <a href>", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "A" }))).toBe(true);
  });

  // Achado 1 (review, 2026-09-09): a element with tabindex="-1" — a modal
  // or custom-widget container focused purely via script for focus-
  // trapping, deliberately outside the normal Tab order — reports
  // `tabIndex === -1`, same as a plain unfocused div. The old
  // `tabIndex >= 0` check couldn't tell them apart and let v/p/c/s hijack
  // keyboard from an open modal. The new check doesn't read tabIndex at
  // all: if it's genuinely `document.activeElement` and it isn't
  // body/html, a DOM invariant guarantees it must be focusable somehow
  // (a plain div can never become activeElement otherwise) — so a
  // tabindex="-1" container is correctly blocked.
  it("blocks a tabindex=-1 modal/widget container that received real, scripted focus (achado 1)", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "DIV" }))).toBe(true);
  });

  it("blocks any other element type reported as the real activeElement", () => {
    expect(isGlobalShortcutBlocked(target({ tagName: "SPAN" }))).toBe(true);
  });
});
