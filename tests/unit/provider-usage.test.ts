import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getProviderUsage,
  parseOpencodeStatsOutput,
  readCodexUsage,
  parseCodexRateLimits,
  readClaudeStats,
  PROVIDER_DASHBOARDS,
  resetProviderUsageCache,
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

describe("Codex rollout quota", () => {
  it("uses only the latest token_count rate_limits fields from the newest rollout", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const day = join(home, ".codex", "sessions", "2026", "10", "13");
    await mkdir(day, { recursive: true });
    const path = join(day, "rollout-sample.jsonl");
    const now = 2_000_000_000_000;
    const oldPath = join(day, "rollout-older.jsonl");
    await writeFile(oldPath, JSON.stringify({ payload: { type: "token_count", info: { rate_limits: {
      primary: { used_percent: 99, window_minutes: 43200, resets_at: (now + 60_000) / 1000 },
    } } } }));
    const sample = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "never returned" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { rate_limits: {
        limit_id: "codex", primary: { used_percent: 32, window_minutes: 43200, resets_at: (now + 60_000) / 1000 },
        secondary: { used_percent: 17, window_minutes: 10080, resets_at: (now + 120_000) / 1000 },
        credits: { has_credits: true, balance: null },
      } } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "also never returned" } }),
    ].join("\n");
    await writeFile(path, sample);
    await utimes(oldPath, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    await utimes(path, new Date(1_900_000_000_000), new Date(1_900_000_000_000));
    const before = (await readCodexUsage(home, now));
    await rm(home, { recursive: true, force: true });
    expect(before).toMatchObject({
      provider: "codex", supported: true, capturedAtMs: 1_900_000_000_000,
      segments: [
        { key: "primary-43200m", percent: 32, resetsAtMs: now + 60_000 },
        { key: "secondary-10080m", percent: 17, resetsAtMs: now + 120_000 },
      ],
    });
    expect(JSON.stringify(before)).not.toContain("never returned");
  });

  it("treats a rollout whose quota reset passed as unknown", () => {
    expect(parseCodexRateLimits({ primary: { used_percent: 100, window_minutes: 43200, resets_at: 1_999_999 } }, 1_900_000_000_000, 2_000_000_000_000)).toMatchObject({
      provider: "codex", supported: false,
    });
  });

  it("treats an old rollout with an elapsed reset as unknown", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-stale-home-"));
    const day = join(home, ".codex", "sessions", "2025", "01", "01");
    await mkdir(day, { recursive: true });
    const path = join(day, "rollout-stale.jsonl");
    await writeFile(path, JSON.stringify({ payload: { type: "token_count", info: { rate_limits: {
      primary: { used_percent: 100, window_minutes: 43200, resets_at: 1_999_999 },
    } } } }));
    await utimes(path, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    const stale = await readCodexUsage(home, 2_000_000_000_000);
    await rm(home, { recursive: true, force: true });
    expect(stale.supported).toBe(false);
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

  it("returns the explicit synthetic verification sample only for its declared provider", async () => {
    const previous = process.env.STELLAR_VERIFY_PROVIDER_USAGE;
    process.env.STELLAR_VERIFY_PROVIDER_USAGE = JSON.stringify({
      provider: "claude",
      supported: true,
      source: "http",
      segments: [{ key: "week", percent: 100, resetsAtMs: 2_000_000_000_000 }],
    });
    try {
      const sample = await getProviderUsage("claude", { isPackaged: false });
      expect(sample.supported && sample.segments?.[0]).toEqual({ key: "week", percent: 100, resetsAtMs: 2_000_000_000_000 });
      const other = await getProviderUsage("codex", { isPackaged: false, codexHomeDir: "/nonexistent-codex-test-home" });
      expect(other.supported).toBe(false);
      process.env.STELLAR_VERIFY_PROVIDER_USAGE = JSON.stringify({
        provider: "codex", supported: true, source: "http", segments: [{ key: "week", percent: 1 }],
      });
      resetProviderUsageCache();
      const packaged = await getProviderUsage("codex", { isPackaged: true, codexHomeDir: "/nonexistent-codex-test-home" });
      expect(packaged.supported).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.STELLAR_VERIFY_PROVIDER_USAGE;
      else process.env.STELLAR_VERIFY_PROVIDER_USAGE = previous;
    }
  });

  it("honestly reports unsupported CLI providers with their dashboard URLs", async () => {
    // `commandcode` SAIU desta lista (task 36034ff2): ele passou a ter fonte de
    // PERCENTUAL por HTTP (`/alpha/billing/credits`) — ver
    // `provider-usage-commandcode.test.ts`. Codex gets an empty fixture home so
    // this test never depends on a real local rollout or auth.
    const providers = ["codex", "cursor", "antigravity", "cline"];
    resetProviderUsageCache();
    for (const p of providers) {
      const res = await getProviderUsage(p, p === "codex" ? { codexHomeDir: "/nonexistent-codex-test-home" } : {});
      expect(res.supported).toBe(false);
      if (!res.supported) {
        expect(res.reason.length).toBeGreaterThan(10);
        expect(res.dashboardUrl).toBe(PROVIDER_DASHBOARDS[p]);
      }
    }
  });

  it("keeps every provider without a quota source unknown rather than fabricating 0% or exhaustion", async () => {
    const providers = ["codex", "antigravity", "cline", "cursor"];
    for (const provider of providers) {
      const usage = await getProviderUsage(provider, provider === "codex" ? { codexHomeDir: "/nonexistent-codex-test-home" } : {});
      expect(usage.supported).toBe(false);
      if (usage.supported) throw new Error(`${provider} must not invent a quota segment`);
    }
  });

  it("does not reuse OpenCode's cached on-demand placeholder after the explicit measure gesture", async () => {
    const first = await getProviderUsage("opencode");
    expect(first.supported).toBe(false);
    if (first.supported) return;
    expect(first.onDemand).toBe(true);
    const measured = await getProviderUsage("opencode", {
      allowSpawn: true,
      opencodeStatsReader: async () => ({ provider: "opencode", supported: true, source: "cli-stats", costUSD: 0 }),
    });
    expect(measured.supported).toBe(true);
    if (measured.supported) expect(measured.source).toBe("cli-stats");
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
