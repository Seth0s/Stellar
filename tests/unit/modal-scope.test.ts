import { describe, it, expect, beforeEach } from "vitest";
import { registerModalOpen, isAnyModalOpen, __resetModalScopeForTests } from "../../src/renderer/src/modal-scope";

describe("modal-scope", () => {
  beforeEach(() => {
    __resetModalScopeForTests();
  });

  it("starts closed", () => {
    expect(isAnyModalOpen()).toBe(false);
  });

  it("open marks it open immediately — no dependency on a focus timer running", () => {
    registerModalOpen();
    expect(isAnyModalOpen()).toBe(true);
  });

  it("release closes it again", () => {
    const release = registerModalOpen();
    release();
    expect(isAnyModalOpen()).toBe(false);
  });

  it("stacks two modals — closing one leaves the other counted as open", () => {
    const releaseFirst = registerModalOpen();
    const releaseSecond = registerModalOpen();
    expect(isAnyModalOpen()).toBe(true);
    releaseFirst();
    expect(isAnyModalOpen()).toBe(true);
    releaseSecond();
    expect(isAnyModalOpen()).toBe(false);
  });

  it("calling release twice does not double-decrement (would go negative and never report closed correctly)", () => {
    const releaseFirst = registerModalOpen();
    const releaseSecond = registerModalOpen();
    releaseFirst();
    releaseFirst(); // duplicate call — e.g. React StrictMode double-invoking a cleanup
    expect(isAnyModalOpen()).toBe(true); // second modal still open
    releaseSecond();
    expect(isAnyModalOpen()).toBe(false); // never went negative, so this still reads correctly
  });
});
