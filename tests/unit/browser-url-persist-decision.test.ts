import { describe, expect, it } from "vitest";
import { decideBrowserUrlCommit, URL_PERSIST_DEBOUNCE_MS } from "../../src/main/browser-url-persist-decision";

/**
 * The browser card persists its CURRENT url (debounced) so a background
 * unload/reload reattaches to where the user was. The decision is pure: the
 * timer lives in the component, the write in App.
 */
describe("browser url persist decision", () => {
  it("commits only when the url changed from the last committed one", () => {
    expect(decideBrowserUrlCommit({ url: "https://a/1", lastCommitted: "https://a/0" })).toBe(true);
    expect(decideBrowserUrlCommit({ url: "https://a/1", lastCommitted: "https://a/1" })).toBe(false);
  });

  it("never commits the initial value (the creation url is not a change)", () => {
    expect(decideBrowserUrlCommit({ url: "https://a/start", lastCommitted: "https://a/start" })).toBe(false);
  });

  it("refuses an empty/whitespace url", () => {
    expect(decideBrowserUrlCommit({ url: "", lastCommitted: null })).toBe(false);
    expect(decideBrowserUrlCommit({ url: "   ", lastCommitted: null })).toBe(false);
  });

  it("commits the first non-empty navigation from a null baseline", () => {
    expect(decideBrowserUrlCommit({ url: "https://a/in-page", lastCommitted: null })).toBe(true);
  });

  it("exposes a positive debounce window", () => {
    expect(URL_PERSIST_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});
