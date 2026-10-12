import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDismissedPrototypes,
  resetDismissedPrototypesCache,
  setPrototypeDismissedKey,
} from "../../src/renderer/src/task-fila-prototype-dismissals";

/**
 * The strip, the chip and the card footer all read the same dismissals, so one
 * click is seen by all of them at once; and the store is the only writer.
 */
describe("prototype dismissals store", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    storage.clear();
    resetDismissedPrototypesCache();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps one Set instance until something changes (useSyncExternalStore needs that)", () => {
    expect(getDismissedPrototypes("b1")).toBe(getDismissedPrototypes("b1"));
  });

  it("dismissing and undoing replace the Set, persist, and are per board", () => {
    const before = getDismissedPrototypes("b1");
    setPrototypeDismissedKey("b1", "t1:100", true);
    const after = getDismissedPrototypes("b1");
    expect(after).not.toBe(before);
    expect(after.has("t1:100")).toBe(true);
    expect(storage.get("stellar.fila.prototypeDismissed.b1")).toBe('["t1:100"]');
    expect(getDismissedPrototypes("b2").size).toBe(0);
    setPrototypeDismissedKey("b1", "t1:100", false);
    expect(getDismissedPrototypes("b1").size).toBe(0);
  });

  it("reads what a previous run stored", () => {
    storage.set("stellar.fila.prototypeDismissed.b1", '["t9:5"]');
    expect(getDismissedPrototypes("b1").has("t9:5")).toBe(true);
  });
});
