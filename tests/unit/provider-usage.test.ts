import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getProviderUsage,
  parseOpencodeStatsOutput,
  readClaudeStats,
  PROVIDER_DASHBOARDS,
} from "../../src/main/provider-usage";
import { formatTokenMetric } from "../../src/renderer/src/ProviderUsageBadge";

describe("parseOpencodeStatsOutput", () => {
  it("extracts cost and token metrics accurately from ASCII box output", () => {
    const sample = `
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                            107 │
│Messages                                          4,630 │
│Days                                                117 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                       $21.08 │
│Avg Cost/Day                                      $0.18 │
│Avg Tokens/Session                                 5.1M │
│Median Tokens/Session                              1.5M │
│Input                                             54.3M │
│Output                                             1.4M │
│Cache Read                                       491.9M │
│Cache Write                                           0 │
└────────────────────────────────────────────────────────┘
`;
    const parsed = parseOpencodeStatsOutput(sample);
    expect(parsed.costUSD).toBe(21.08);
    expect(parsed.sessions).toBe(107);
    expect(parsed.messages).toBe(4630);
    expect(parsed.inputTokens).toBe(54_300_000);
    expect(parsed.outputTokens).toBe(1_400_000);
    expect(parsed.cacheReadTokens).toBe(491_900_000);
  });
});

describe("readClaudeStats", () => {
  it("reads and sums tokens from stats-cache.json", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "claude-home-"));
    try {
      await mkdir(join(tempHome, ".claude"), { recursive: true });
      const statsJson = {
        version: 5,
        totalMessages: 1000,
        totalSessions: 25,
        modelUsage: {
          "claude-sonnet-4": {
            inputTokens: 50000,
            outputTokens: 10000,
            cacheReadInputTokens: 200000,
            costUSD: 1.5,
          },
          "claude-haiku-4": {
            inputTokens: 20000,
            outputTokens: 5000,
            cacheReadInputTokens: 50000,
            costUSD: 0.2,
          },
        },
      };
      await writeFile(join(tempHome, ".claude", "stats-cache.json"), JSON.stringify(statsJson));

      const res = await readClaudeStats(tempHome);
      expect(res.supported).toBe(true);
      if (res.supported) {
        expect(res.provider).toBe("claude");
        expect(res.source).toBe("local-cache");
        expect(res.inputTokens).toBe(70000);
        expect(res.outputTokens).toBe(15000);
        expect(res.cacheReadTokens).toBe(250000);
        expect(res.costUSD).toBe(1.7);
        expect(res.totalSessions).toBe(25);
        expect(res.totalMessages).toBe(1000);
      }
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("handles missing stats-cache.json gracefully", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "empty-home-"));
    try {
      const res = await readClaudeStats(emptyHome);
      expect(res.supported).toBe(false);
      if (!res.supported) {
        expect(res.dashboardUrl).toBe(PROVIDER_DASHBOARDS.claude);
      }
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("getProviderUsage", () => {
  it("reports bash as not having AI quota concepts", async () => {
    const res = await getProviderUsage("bash");
    expect(res.supported).toBe(false);
    if (!res.supported) {
      expect(res.reason).toContain("Shell local");
    }
  });

  it("honestly reports unsupported CLI providers with their dashboard URLs", async () => {
    const providers = ["codex", "cursor", "antigravity", "cline", "commandcode"];
    for (const p of providers) {
      const res = await getProviderUsage(p);
      expect(res.supported).toBe(false);
      if (!res.supported) {
        expect(res.reason.length).toBeGreaterThan(10);
        expect(res.dashboardUrl).toBe(PROVIDER_DASHBOARDS[p]);
      }
    }
  });
});

describe("formatTokenMetric", () => {
  it("formats tokens into human readable shorthand", () => {
    expect(formatTokenMetric(0)).toBe("0");
    expect(formatTokenMetric(500)).toBe("500");
    expect(formatTokenMetric(1500)).toBe("1.5k");
    expect(formatTokenMetric(2_400_000)).toBe("2.4M");
    expect(formatTokenMetric(1_500_000_000)).toBe("1.5B");
  });
});
