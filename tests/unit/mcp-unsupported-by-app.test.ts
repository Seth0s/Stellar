import { describe, expect, it } from "vitest";
import {
  MCP_MECHANISMS,
  parseProviderSpec,
  dynamicProviderDef,
  providersConfigSchema,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";
import { deriveReportChannel } from "../../src/main/providers";

/**
 * `unsupported-by-app` — honest absence of MCP registration when the CLI
 * HAS MCP but Stellar cannot write its config shape (measured: omp stores
 * settings in SQLite, not a JSON file).
 *
 * MUTATION PROOF (gatesOutput):
 *   (i) drop `"unsupported-by-app"` from MCP_MECHANISMS → parser refuses a
 *       valid omp-shaped declaration and this file goes red;
 *   (ii) accept `{mechanism:"unsupported-by-app"}` without `reason` → the
 *       refusal test below goes red;
 *   (iii) restore `deriveReportChannel` to `mechanism !== "none"` →
 *       unsupported is mis-classified as mcp channel and the channel
 *       assertion goes red.
 */

const OMP_REASON =
  "Oh My Pi stores MCP settings in SQLite (agent.db / settings); Stellar only writes JSON global-config files";

function ompLike(mcp: DynamicProviderSpec["capacity"]["mcp"]): DynamicProviderSpec {
  return {
    id: "omp-probe",
    label: "OMP probe",
    binaryNames: ["omp"],
    installCommand: { posix: "npm i -g omp", windows: "npm i -g omp" },
    capacity: {
      role: "agent",
      session: { canImposeSessionId: false, resumeFlag: "--resume" },
      systemPrompt: { mechanism: "flag", flag: "-s" },
      mcp,
      acbridgeOnPath: true,
      effort: {
        mechanism: "flag",
        flag: "--thinking",
        values: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
      },
      model: { mechanism: "flag", flag: "-m" },
      delivery: { briefMechanism: "positional" },
    },
  };
}

describe("mcp unsupported-by-app", () => {
  it("MCP_MECHANISMS lists unsupported-by-app next to none and global-config", () => {
    expect(MCP_MECHANISMS).toEqual(["global-config", "none", "unsupported-by-app"]);
    const schema = JSON.stringify(providersConfigSchema());
    expect(schema).toContain('"unsupported-by-app"');
    expect(schema).toContain("não sabe escrever");
  });

  it("accepts omp-shaped declaration with written reason; round-trips into live capacity", () => {
    const declared = ompLike({ mechanism: "unsupported-by-app", reason: OMP_REASON });
    const parsed = parseProviderSpec(declared);
    expect(parsed.ok, parsed.ok ? "" : parsed.reason).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.capacity.mcp).toEqual({ mechanism: "unsupported-by-app", reason: OMP_REASON });
    expect(dynamicProviderDef(parsed.spec).capacity.mcp).toEqual({
      mechanism: "unsupported-by-app",
      reason: OMP_REASON,
    });
    expect(deriveReportChannel(dynamicProviderDef(parsed.spec).capacity)).toBe("acbridge");
  });

  it("refuses unsupported-by-app without reason, naming the field", () => {
    const parsed = parseProviderSpec(ompLike({ mechanism: "unsupported-by-app" } as DynamicProviderSpec["capacity"]["mcp"]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("capacity.mcp.reason");
    expect(parsed.reason).toContain("unsupported-by-app");
  });

  it("refuses unsupported-by-app with blank reason", () => {
    const parsed = parseProviderSpec(ompLike({ mechanism: "unsupported-by-app", reason: "   " }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("capacity.mcp.reason");
  });

  it("none stays distinct: no reason required, still not a live MCP channel", () => {
    const parsed = parseProviderSpec(ompLike({ mechanism: "none" }));
    expect(parsed.ok, parsed.ok ? "" : parsed.reason).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.capacity.mcp).toEqual({ mechanism: "none" });
    expect(deriveReportChannel(dynamicProviderDef(parsed.spec).capacity)).toBe("acbridge");
  });
});
