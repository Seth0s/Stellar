import { describe, it, expect } from "vitest";
import {
  ACBRIDGE_HINT,
  PROVIDERS,
  argsCarryDeclaredBrief,
  argvCarriesDeclaredBrief,
  briefArgvFragment,
  canImposeSessionId,
  deriveReportChannel,
  deriveReportDiscovery,
  providerById,
  providerCapacity,
  shouldImposeSessionId,
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
// conjunto mais largo que o low/medium/high do antigravity).
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

  it("ACBRIDGE_HINT states the single report rule: catalog has `report` → tool, else acbridge report with verdict", () => {
    expect(ACBRIDGE_HINT).toContain("`report`");
    expect(ACBRIDGE_HINT).toContain("catalog");
    expect(ACBRIDGE_HINT).toContain("acbridge report");
    expect(ACBRIDGE_HINT).toContain("`verdict`");
  });
});

// 2026-09-13 — one declaration (`capacity.mcp`) drives both whether
// `ensureMcpRegistered` acts (mcp-registration.ts) and the channel a
// report is expected on. Discovery (how the agent LEARNS) stays separate
// and is NOT flipped here: cursor is still `scrollback`.
describe("providers: deriveReportChannel (from capacity.mcp, never a list)", () => {
  it("any MCP mechanism → mcp; none + acbridge → acbridge; neither → unreachable", () => {
    const base = {
      role: "agent" as const,
      systemPrompt: { mechanism: "none" as const },
      delivery: { briefMechanism: "none" as const },
    };
    expect(deriveReportChannel({ ...base, mcp: { mechanism: "ephemeral-flag" }, acbridgeOnPath: false })).toBe("mcp");
    expect(deriveReportChannel({ ...base, mcp: { mechanism: "global-config" }, acbridgeOnPath: false })).toBe("mcp");
    expect(deriveReportChannel({ ...base, mcp: { mechanism: "none" }, acbridgeOnPath: true })).toBe("acbridge");
    expect(deriveReportChannel({ ...base, mcp: { mechanism: "none" }, acbridgeOnPath: false })).toBe("unreachable");
  });

  it("every agent provider today expects mcp; bash expects acbridge", () => {
    for (const p of PROVIDERS) {
      const expected = p.id === "bash" ? "acbridge" : "mcp";
      expect(deriveReportChannel(p.capacity), p.id).toBe(expected);
    }
  });

  it("channel and discovery are independent axes (cursor: mcp channel, scrollback discovery)", () => {
    const cursor = providerCapacity("cursor")!;
    expect(deriveReportChannel(cursor)).toBe("mcp");
    expect(deriveReportDiscovery(cursor)).toBe("scrollback");
  });
});

// Declaration vs buildArgs for the spawn brief. The 2026-09-13 silent
// loss on cursor/antigravity happened because `delivery.briefMechanism`
// said the CLI takes a brief while `buildArgs` never read `opts.brief`.
// `canArgv` trusted the declaration, so the typing fallback never armed
// and the text vanished. This walks EVERY provider — a new one that
// declares positional/flag without placing the brief must fail here.
describe("providers: delivery.briefMechanism is implemented by buildArgs", () => {
  const SENTINEL = "__stellar_brief_contract__";

  it("every provider that declares briefMechanism !== none places that brief in argv", () => {
    const declared = PROVIDERS.filter(
      (p) => p.capacity.delivery.briefMechanism !== "none" && p.capacity.delivery.briefMechanism !== undefined,
    );
    const caught: string[] = [];
    for (const p of declared) {
      const { briefMechanism, briefFlag } = p.capacity.delivery;
      const args = p.buildArgs({ brief: SENTINEL });
      const placed =
        briefMechanism === "flag"
          ? Boolean(briefFlag) && args[args.indexOf(briefFlag)] === briefFlag && args[args.indexOf(briefFlag) + 1] === SENTINEL
          : args.includes(SENTINEL);
      if (!placed) caught.push(p.id);
    }
    expect(caught, `declared=${declared.map((p) => p.id).join(",")} caught=${caught.join(",")}`).toEqual([]);
  });

  it("flag providers place the declared briefFlag immediately before the brief", () => {
    for (const p of PROVIDERS) {
      if (p.capacity.delivery.briefMechanism !== "flag") continue;
      const flag = p.capacity.delivery.briefFlag;
      expect(flag, `${p.id} declares flag without briefFlag`).toBeTruthy();
      const args = p.buildArgs({ brief: SENTINEL });
      const i = args.indexOf(flag!);
      expect(i, `${p.id} missing declared briefFlag ${flag}`).toBeGreaterThanOrEqual(0);
      expect(args[i + 1], `${p.id} briefFlag not followed by brief`).toBe(SENTINEL);
    }
  });

  it("none providers never put the brief in argv", () => {
    for (const p of PROVIDERS) {
      if (p.capacity.delivery.briefMechanism !== "none") continue;
      expect(p.buildArgs({ brief: SENTINEL })).not.toContain(SENTINEL);
    }
  });

  it("briefArgvFragment is derived from delivery — cursor positional, antigravity -i", () => {
    expect(briefArgvFragment({ briefMechanism: "positional" }, SENTINEL)).toEqual([SENTINEL]);
    expect(briefArgvFragment({ briefMechanism: "flag", briefFlag: "-i" }, SENTINEL)).toEqual(["-i", SENTINEL]);
    expect(briefArgvFragment({ briefMechanism: "none" }, SENTINEL)).toEqual([]);
    expect(briefArgvFragment({ briefMechanism: "flag", briefFlag: "-i" }, undefined)).toEqual([]);
  });

  it("argvCarriesDeclaredBrief is empirical: bash false, every declared provider true", () => {
    expect(argvCarriesDeclaredBrief("bash", SENTINEL)).toBe(false);
    expect(argvCarriesDeclaredBrief("no-such-provider", SENTINEL)).toBe(false);
    for (const p of PROVIDERS) {
      const declared = p.capacity.delivery.briefMechanism !== "none";
      expect(argvCarriesDeclaredBrief(p.id, SENTINEL), p.id).toBe(declared);
      expect(argsCarryDeclaredBrief(p.buildArgs({ brief: SENTINEL }), p.capacity.delivery, SENTINEL)).toBe(declared);
    }
  });
});

// Measured 2026-09-13 (task c1064d95): Stellar can IMPOSE the session id
// on claude (`--session-id`) and cursor (`--resume` even for a fresh
// uuid). The other three refuse or mint their own — buildArgs must not
// invent a flag for them just because an imposed id was passed.
describe("providers: impose session id (claude/cursor)", () => {
  it("canImposeSessionId is only claude and cursor", () => {
    expect(canImposeSessionId("claude")).toBe(true);
    expect(canImposeSessionId("cursor")).toBe(true);
    for (const id of ["codex", "antigravity", "opencode", "bash"]) {
      expect(canImposeSessionId(id)).toBe(false);
    }
  });

  it("shouldImposeSessionId is false when restoring or continuing", () => {
    expect(shouldImposeSessionId("claude", {})).toBe(true);
    expect(shouldImposeSessionId("cursor", {})).toBe(true);
    expect(shouldImposeSessionId("claude", { resumeId: "already" })).toBe(false);
    expect(shouldImposeSessionId("cursor", { continueLast: true })).toBe(false);
    expect(shouldImposeSessionId("codex", {})).toBe(false);
  });

  it("claude restore uses --resume; impose uses --session-id; never both", () => {
    const claude = providerById("claude")!;
    const restored = claude.buildArgs({ resumeId: "sess-restore" });
    expect(restored.slice(0, 2)).toEqual(["--resume", "sess-restore"]);
    expect(restored).not.toContain("--session-id");

    const imposed = claude.buildArgs({ imposedSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    expect(imposed.slice(0, 2)).toEqual(["--session-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
    expect(imposed).not.toContain("--resume");
  });

  it("cursor uses --resume for both restore and impose", () => {
    const cursor = providerById("cursor")!;
    expect(cursor.buildArgs({ resumeId: "old" }).slice(0, 2)).toEqual(["--resume", "old"]);
    expect(cursor.buildArgs({ imposedSessionId: "new-uuid" }).slice(0, 2)).toEqual(["--resume", "new-uuid"]);
  });

  it("codex/antigravity/opencode ignore imposedSessionId (cannot impose)", () => {
    const id = "deadbeef-dead-4eef-8eef-deadbeefdead";
    expect(providerById("codex")!.buildArgs({ imposedSessionId: id })).not.toContain(id);
    expect(providerById("antigravity")!.buildArgs({ imposedSessionId: id })).not.toContain(id);
    expect(providerById("opencode")!.buildArgs({ imposedSessionId: id })).not.toContain(id);
  });
});
