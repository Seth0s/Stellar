/**
 * Wraps scripts/verify/check-design-tokens.mjs so the cheap
 * SYSTEM_DESIGN §1 scan rides with `npm run test:unit` (and CI).
 */

import { describe, expect, it } from "vitest";
import { scanDesignTokens } from "../../scripts/verify/check-design-tokens.mjs";

describe("check-design-tokens", () => {
  const result = scanDesignTokens();

  it("loads the tokens.css catalog", () => {
    expect(result.catalog.has("--text")).toBe(true);
    expect(result.catalog.has("--foam")).toBe(true);
    expect(result.catalog.size).toBeGreaterThan(20);
  });

  it("does not invent a silent theme fallback", () => {
    expect(result.missing).toEqual([]);
  });

  it("documents the one known TaskCard --bg gap instead of hiding it", () => {
    expect(result.known.map((g: { name: string }) => g.name)).toEqual(["--bg"]);
  });
});
