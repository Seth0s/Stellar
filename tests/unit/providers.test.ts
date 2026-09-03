import { describe, it, expect } from "vitest";
import { providerById } from "../../src/main/providers";

// Sticky item "spawn_agent effort" (2026-09-03) — reported live: asking
// spawn_agent for `gemini-3.1-pro` via Antigravity silently fell back to
// a different model ("requires --effort, using Gemini 3.7/3.8 Flash
// (High) instead") because `SpawnOpts` had no `effort` field to pass it
// separately from `model`. Pure-function coverage on `buildArgs` itself —
// no Electron/CDP needed, `effort`'s only job is landing in the arg
// array the right way for every combination.
describe("providers: antigravity buildArgs effort", () => {
  const antigravity = providerById("antigravity")!;

  it("includes --effort when given, after --model", () => {
    const args = antigravity.buildArgs({ model: "gemini-3.1-pro", effort: "high" });
    expect(args).toEqual(["--model", "gemini-3.1-pro", "--effort", "high"]);
  });

  it("omits --effort entirely when not given (existing behavior unchanged)", () => {
    const args = antigravity.buildArgs({ model: "gemini-3.1-pro" });
    expect(args).toEqual(["--model", "gemini-3.1-pro"]);
  });

  it("works with effort alone, no model", () => {
    const args = antigravity.buildArgs({ effort: "low" });
    expect(args).toEqual(["--effort", "low"]);
  });

  it("combines with --conversation (resumeId) same as --model already did", () => {
    const args = antigravity.buildArgs({ resumeId: "abc123", model: "gemini-3.1-pro", effort: "high" });
    expect(args).toEqual(["--conversation", "abc123", "--model", "gemini-3.1-pro", "--effort", "high"]);
  });

  it("every other provider ignores effort silently (not plumbed into their buildArgs at all)", () => {
    const claude = providerById("claude")!;
    const args = claude.buildArgs({ model: "sonnet", effort: "high" } as never);
    expect(args).not.toContain("--effort");
  });
});
