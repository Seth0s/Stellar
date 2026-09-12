import { describe, it, expect } from "vitest";
import {
  ACBRIDGE_HINT,
  PROVIDERS,
  deriveReportDiscovery,
  providerById,
  providerCapacity,
} from "../../src/main/providers";

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
    const args = antigravity.buildArgs({
      resumeId: "abc123",
      model: "gemini-3.1-pro",
      effort: "high",
    });
    expect(args).toEqual([
      "--conversation",
      "abc123",
      "--model",
      "gemini-3.1-pro",
      "--effort",
      "high",
    ]);
  });

  it("cursor/codex/opencode ignore effort silently (not plumbed into their buildArgs at all)", () => {
    for (const id of ["cursor", "codex", "opencode"] as const) {
      const args = providerById(id)!.buildArgs({ model: "x", effort: "high" });
      expect(args).not.toContain("--effort");
    }
  });
});

// DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" (relato do dono
// do repo, 2026-09-09) — confirmado via `claude --help` real (não
// presumido, o pedido explícito era não assumir que é `--effort` só
// porque é o nome usado pelo antigravity) que a CLI do claude TEM sua
// própria flag `--effort <level>` (low/medium/high/xhigh/max, um
// conjunto mais largo que o low/high do antigravity).
describe("providers: claude buildArgs effort", () => {
  const claude = providerById("claude")!;

  it("includes --effort when given, same position style as --model", () => {
    const args = claude.buildArgs({ model: "opus", effort: "high" });
    expect(args.slice(0, 4)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  it("omits --effort entirely when not given (existing behavior unchanged)", () => {
    const args = claude.buildArgs({ model: "opus" });
    expect(args).not.toContain("--effort");
  });

  it("model and effort always arrive together — never one without the other from the same spawnOpts", () => {
    const withBoth = claude.buildArgs({ resumeId: "sess1", model: "opus", effort: "high" });
    expect(withBoth).toContain("--model");
    expect(withBoth).toContain("--effort");
    const withNeither = claude.buildArgs({ resumeId: "sess1" });
    expect(withNeither).not.toContain("--model");
    expect(withNeither).not.toContain("--effort");
  });

  // Review adversarial 2026-09-09, achado 2 — `SpawnOpts.effort` widened
  // from "low" | "high" to plain string precisely so claude's REAL range
  // (confirmed via --help: low/medium/high/xhigh/max) passes through
  // untouched, not just the antigravity-era subset.
  it("passes claude's wider effort range through untouched (medium/xhigh/max, not just low/high)", () => {
    for (const level of ["medium", "xhigh", "max"]) {
      const args = claude.buildArgs({ model: "opus", effort: level });
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe(level);
    }
  });
});

describe("providers: ACBRIDGE_HINT prompt coverage", () => {
  const claude = providerById("claude")!;
  const codex = providerById("codex")!;

  function claudeSystemPrompt(args: string[]): string {
    const index = args.indexOf("--append-system-prompt");
    expect(index).toBeGreaterThanOrEqual(0);
    return args[index + 1]!;
  }

  function codexDeveloperInstructions(args: string[]): string {
    const config = args.find((arg) => arg.startsWith("developer_instructions="));
    expect(config).toBeDefined();
    return JSON.parse(config!.slice("developer_instructions=".length)) as string;
  }

  it("keeps the environment hint when Claude receives a custom task prompt", () => {
    const value = claudeSystemPrompt(
      claude.buildArgs({ systemPrompt: "Implement the requested change." }),
    );

    expect(value).toMatch(/^Implement the requested change\.\n\n/);
    expect(value).toContain("agent-canvas");
    expect(value).not.toBe("Implement the requested change.");
  });

  it("uses only the environment hint when systemPrompt is absent or whitespace-only", () => {
    const withoutPrompt = claudeSystemPrompt(claude.buildArgs({}));
    const withWhitespacePrompt = claudeSystemPrompt(claude.buildArgs({ systemPrompt: " \n\t " }));

    expect(withoutPrompt).toContain("agent-canvas");
    expect(withWhitespacePrompt).toBe(withoutPrompt);
  });

  it("uses Codex's real -c flag for additive developer instructions", () => {
    const withPrompt = codexDeveloperInstructions(
      codex.buildArgs({ systemPrompt: "Review the task carefully." }),
    );
    const withoutPrompt = codexDeveloperInstructions(codex.buildArgs({}));

    expect(withPrompt).toMatch(/^Review the task carefully\.\n\n/);
    expect(withPrompt).toContain("agent-canvas");
    expect(withoutPrompt).toContain("agent-canvas");
    expect(codex.buildArgs({ systemPrompt: "Review the task carefully." })).toContain("-c");
  });
});

describe("providers: capacity contract (§0)", () => {
  it("every provider declares capacity; delivery matches buildArgs", () => {
    for (const p of PROVIDERS) {
      expect(p.capacity).toBeDefined();
      const discovery = deriveReportDiscovery(p.capacity);
      const args = p.buildArgs({ systemPrompt: "task", mcpUrl: "http://127.0.0.1:9" });
      const argsText = args.join("\0");
      if (discovery === "system_prompt") {
        expect(argsText).toContain(ACBRIDGE_HINT.slice(0, 40));
      } else {
        expect(argsText).not.toContain("agent-canvas");
      }
    }
  });

  it("cursor/antigravity/opencode: no system-prompt, global MCP, scrollback discovery", () => {
    for (const id of ["cursor", "antigravity", "opencode"] as const) {
      const c = providerCapacity(id)!;
      expect(c.systemPrompt.mechanism).toBe("none");
      expect(c.mcp.mechanism).toBe("global-config");
      expect(c.acbridgeOnPath).toBe(true);
      expect(deriveReportDiscovery(c)).toBe("scrollback");
    }
  });

  it("claude/codex: system-prompt + ephemeral MCP", () => {
    expect(providerCapacity("claude")!.systemPrompt.mechanism).toBe("append-system-prompt");
    expect(providerCapacity("claude")!.mcp.mechanism).toBe("ephemeral-flag");
    expect(providerCapacity("codex")!.systemPrompt.mechanism).toBe("developer_instructions");
    expect(providerCapacity("codex")!.mcp.mechanism).toBe("ephemeral-flag");
    expect(deriveReportDiscovery(providerCapacity("claude")!)).toBe("system_prompt");
    expect(deriveReportDiscovery(providerCapacity("codex")!)).toBe("system_prompt");
  });

  it("ACBRIDGE_HINT never contains a URL scheme (pty URL sighting)", () => {
    expect(ACBRIDGE_HINT).not.toMatch(/https?:\/\//);
  });
});
