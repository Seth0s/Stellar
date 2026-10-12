import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  QUOTA_WARN_PERCENTS,
  contextWarning,
  formatTokenCount,
  healthAlerts,
  healthCoolKeys,
  isContextAboveThreshold,
  parseTokenCount,
  readCardHealth,
  type ContextDecl,
} from "../../src/main/card-health";
import { providerCapacity } from "../../src/main/providers";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";

/**
 * CARD HEALTH, pinned to the REAL output. Each reading below comes from a line
 * collected live (fixtures `card-health/commandcode-working.txt` and
 * `tui-submit-started/claude-working.txt`) and from the provider's declaration.
 * Changing the pattern, the window or the threshold to a guess breaks this test.
 *
 * The commandcode cases also lock in a correction: the spinner's `↓ Nk` is the
 * TURN's token volume (it resets and grows every turn), so it is NOT context —
 * commandcode declares no context, and the reading must stay `null`.
 */

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/card-health/${name}`, import.meta.url), "utf8");
// Recorded claude card screens: the footer bar `NN% <used>/<window>` is the
// context fill this reading targets.
const claudeScreen = readFileSync(
  new URL("./fixtures/tui-submit-started/claude-working.txt", import.meta.url),
  "utf8",
);
beforeAll(() => {
  // The app's own boot: without it `commandcode` (dynamic) is not in the
  // registry and `providerCapacity("commandcode")` answers `undefined`.
  loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-card-health-")));
});

describe("parseTokenCount — number + unit, never a disguised NaN", () => {
  it("decimal k/m and the bare case", () => {
    expect(parseTokenCount("255.1", "k")).toBe(255_100);
    expect(parseTokenCount("141.7", "k")).toBe(141_700);
    expect(parseTokenCount("1", "m")).toBe(1_000_000);
    expect(parseTokenCount("1.2", "K")).toBe(1_200);
    expect(parseTokenCount("512")).toBe(512);
  });

  it("comma decimal and absence of value", () => {
    expect(parseTokenCount("141,7", "k")).toBe(141_700);
    expect(parseTokenCount("abc")).toBeNull();
    expect(parseTokenCount("")).toBeNull();
  });

  it("formatTokenCount is display only", () => {
    expect(formatTokenCount(255_100)).toBe("255.1k");
    expect(formatTokenCount(1_000_000)).toBe("1m");
    expect(formatTokenCount(758_000)).toBe("758k");
    expect(formatTokenCount(512)).toBe("512");
  });
});

describe("commandcode — quota is read; the spinner is NOT context", () => {
  it("the footer `Plan: 81% used, 13.3 credits left` becomes quota.percent + text", () => {
    const health = readCardHealth(providerCapacity("commandcode")?.health, fixture("commandcode-working.txt"), 123);
    expect(health.quota?.percent).toBe(81);
    expect(health.quota?.text).toContain("Plan: 81% used");
    expect(health.quota?.text).toContain("13.3 credits left");
    expect(health.quota?.at).toBe(123);
  });

  it("the `↓ 255.1k` spinner is TURN volume, not context — the reading stays null", () => {
    // Real live screens read `↓ 8.0k` minutes into a turn and `↓ 12.4k` later:
    // it resets and grows every turn, so it can never be the session context.
    const health = readCardHealth(providerCapacity("commandcode")?.health, fixture("commandcode-working.txt"), 1);
    expect(providerCapacity("commandcode")?.health?.context).toBeUndefined();
    expect(health.context).toBeNull();
  });

  it("a card whose ONLY token text is the spinner still has no context", () => {
    const screen = "○ Crystallizing…  esc to interrupt • 6m 18s • ↓ 255.1k\n";
    expect(readCardHealth(providerCapacity("commandcode")?.health, screen, 1).context).toBeNull();
  });
});

describe("claude — the footer bar `NN% <used>/<window>` is the context", () => {
  it("the used/window pair becomes usedTokens AND windowTokens (both from the CLI)", () => {
    const health = readCardHealth(providerCapacity("claude")?.health, claudeScreen, 7);
    expect(health.context).toEqual({
      usedTokens: 758_000,
      windowTokens: 1_000_000,
      source: "claude status-bar context fill (used/window)",
      at: 7,
    });
  });

  it("the `↓ 1.2k tokens` spinner is NOT the session context (the slash is required)", () => {
    const onlySpinner = "✽ Sautéed for 16s · ↓ 1.2k tokens\n";
    expect(readCardHealth(providerCapacity("claude")?.health, onlySpinner, 1).context).toBeNull();
  });

  it("the LAST bar wins when the screen repaints", () => {
    const screen = "[█░░] 10% 100k/1m\n… repaint …\n[█████] 76% 758k/1m\n";
    const reading = readCardHealth(providerCapacity("claude")?.health, screen, 1).context;
    expect(reading?.usedTokens).toBe(758_000);
    expect(reading?.windowTokens).toBe(1_000_000);
  });

  it("claude declares no quota — the answer is null, never an invented number", () => {
    expect(readCardHealth(providerCapacity("claude")?.health, claudeScreen, 1).quota).toBeNull();
  });

  it("a reading with NO window yields no fraction and therefore no warning", () => {
    // A provider that prints tokens used but not the window gets an honest
    // reading and NO threshold — a fraction cannot be computed from nothing.
    const usedOnly: ContextDecl = { pattern: /used (\d+)(k?)/i, warnFraction: 0.7, source: "synthetic" };
    const health = readCardHealth({ context: usedOnly }, "used 900k\n", 1);
    expect(health.context).toEqual({ usedTokens: 900_000, source: "synthetic", at: 1 });
    expect(isContextAboveThreshold(health.context!, usedOnly)).toBe(false);
    expect(contextWarning(health, { context: usedOnly })).toBeNull();
  });
});

/** The footer of a healthy card, exactly as `read_card` showed it when a false
 *  "111% and near its limit" was sent: 11% of a 1m window. */
const HEALTHY_FOOTER =
  "Sonnet 5.5 | Código | [██░░░░░░░░░░░░░░░░░░] 11% 105k/1m | 5h [█████░░░░░░░░░░░░░░░] 27% ↻12:30  7d [████████░░░░░░░░░░░░] 44% ↻17/10";

describe("claude — a torn read of the repainted footer is never a reading", () => {
  const claude = () => providerCapacity("claude")?.health;
  const readOf = (screen: string) => readCardHealth(claude(), screen, 1).context;

  it("the healthy footer is read whole: 105k of 1m, and the 5h/7d bars are not context", () => {
    expect(readOf(HEALTHY_FOOTER)).toEqual({
      usedTokens: 105_000,
      windowTokens: 1_000_000,
      source: "claude status-bar context fill (used/window)",
      at: 1,
    });
    const alerts = healthAlerts({ health: readCardHealth(claude(), HEALTHY_FOOTER, 1), capability: claude(), cardLabel: "Sonnet", provider: "claude" });
    expect(alerts).toEqual([]);
  });

  it("a digit glued in front of the used count (1 + 105k = 1105k, 111%) is refused", () => {
    expect(readOf(HEALTHY_FOOTER.replace("11% 105k/1m", "11% 1105k/1m"))).toBeNull();
  });

  it("a digit glued onto the bar's own percent (111% next to 105k/1m) is refused", () => {
    expect(readOf(HEALTHY_FOOTER.replace("11% 105k/1m", "111% 105k/1m"))).toBeNull();
  });

  it("the cause, pinned: 1 + 105k read as 1105k of 1m is exactly the false 111%", () => {
    // The pattern alone, with no corroboration and no used<=window rule (what
    // the declaration did before): the glued count is 110.5% of the window,
    // and the alert prints Math.round(110.5) = 111.
    const pairOnly: ContextDecl = { pattern: /([\d.]+)([km])\s*\/\s*([\d.]+)([km])/i, warnFraction: 0.7, source: "pair only" };
    const rawPair = pairOnly.pattern.exec("11% 1105k/1m");
    expect(Math.round((Number(rawPair![1]) * 1e3) / 1e6 * 100)).toBe(111);
  });

  it("used over the window can never be a reading, even without the bar percent", () => {
    const bare: ContextDecl = { pattern: /([\d.]+)([km])\s*\/\s*([\d.]+)([km])/i, warnFraction: 0.7, source: "synthetic" };
    expect(readCardHealth({ context: bare }, "222k/200k\n", 1).context).toBeNull();
  });

  it("a torn newest paint does not hide the good one before it", () => {
    const screen = `${HEALTHY_FOOTER}\n${HEALTHY_FOOTER.replace("11% 105k/1m", "11% 1105k/1m")}\n`;
    expect(readOf(screen)?.usedTokens).toBe(105_000);
  });

  it("a pair with no bar percent in front (prose, a log line) is not the footer", () => {
    expect(readOf("copied 222k/200k from the log\n")).toBeNull();
  });

  it("every printed fill agrees with its own percent: 76% 758k/1m stays valid", () => {
    expect(readOf(claudeScreen)?.usedTokens).toBe(758_000);
  });
});

describe("healthCoolKeys — only a trustworthy reading well below a level re-arms it", () => {
  const claude = () => providerCapacity("claude")?.health;
  const commandcode = () => providerCapacity("commandcode")?.health;

  it("11% context is cool; 68% (inside the margin) is not; 76% is not", () => {
    expect(healthCoolKeys({ health: readCardHealth(claude(), HEALTHY_FOOTER, 1), capability: claude() })).toEqual(["context"]);
    expect(healthCoolKeys({ health: readCardHealth(claude(), "[███] 68% 680k/1m\n", 1), capability: claude() })).toEqual([]);
    expect(healthCoolKeys({ health: readCardHealth(claude(), claudeScreen, 1), capability: claude() })).toEqual([]);
  });

  it("a missing reading re-arms nothing", () => {
    expect(healthCoolKeys({ health: readCardHealth(claude(), "❯ prompt\n", 1), capability: claude() })).toEqual([]);
  });

  it("quota 70% is below both levels; 78% is inside the margin of 80 only", () => {
    const at = (percent: number) =>
      healthCoolKeys({ health: readCardHealth(commandcode(), `Plan: ${percent}% used, 1 credits left\n`, 1), capability: commandcode() });
    expect(at(70)).toEqual(["quota:80", "quota:95"]);
    expect(at(78)).toEqual(["quota:95"]);
  });
});

describe("honesty — no declaration or no screen means null", () => {
  it("a provider that declares no health produces no reading", () => {
    // cursor is native and declares no `health`.
    expect(providerCapacity("cursor")?.health).toBeUndefined();
    expect(readCardHealth(providerCapacity("cursor")?.health, claudeScreen, 1)).toEqual({
      context: null,
      quota: null,
    });
  });

  it("without a screen, nothing is invented", () => {
    expect(readCardHealth(providerCapacity("claude")?.health, null, 1)).toEqual({ context: null, quota: null });
    expect(readCardHealth(providerCapacity("commandcode")?.health, "", 1)).toEqual({ context: null, quota: null });
  });
});

describe("thresholds — warned once per level, and the delivery warning", () => {
  const commandcode = () => providerCapacity("commandcode")?.health;
  const claude = () => providerCapacity("claude")?.health;

  it("claude 758k/1m (76%) crosses the context threshold", () => {
    const health = readCardHealth(claude(), claudeScreen, 1);
    const alerts = healthAlerts({ health, capability: claude(), cardLabel: "Master", provider: "claude" });
    expect(alerts.map((a) => a.key)).toEqual(["context"]);
    expect(alerts[0].message).toContain("76%");
    expect(alerts[0].message).toContain("list_cards");
  });

  it("a context below the threshold warns nothing", () => {
    const cool = "[█░░░] 10% 100k/1m\n";
    const health = readCardHealth(claude(), cool, 1);
    expect(isContextAboveThreshold(health.context!, claude()!.context!)).toBe(false);
    expect(healthAlerts({ health, capability: claude(), cardLabel: "x", provider: "claude" })).toEqual([]);
    expect(contextWarning(health, claude())).toBeNull();
  });

  it("quota 81% crosses only the 80 level", () => {
    const health = readCardHealth(commandcode(), fixture("commandcode-working.txt"), 1);
    const alerts = healthAlerts({ health, capability: commandcode(), cardLabel: "7°", provider: "commandcode" });
    expect(alerts.map((a) => a.key)).toEqual(["quota:80"]);
    expect(alerts[0].message).toContain("81% used");
    expect(alerts[0].message).toContain("list_cards");
  });

  it("quota 96% crosses 80 AND 95", () => {
    const screen = "⚠ Plan: 96% used, 0.5 credits left\n";
    const health = readCardHealth(commandcode(), screen, 1);
    const alerts = healthAlerts({ health, capability: commandcode(), cardLabel: "x", provider: "commandcode" });
    expect(alerts.map((a) => a.key).sort()).toEqual(["quota:80", "quota:95"]);
  });

  it("contextWarning carries tokens, window, percent and threshold — for the DELIVERY", () => {
    const health = readCardHealth(claude(), claudeScreen, 1);
    expect(contextWarning(health, claude())).toMatchObject({
      usedTokens: 758_000,
      windowTokens: 1_000_000,
      percent: 76,
      thresholdPercent: 70,
      source: "claude status-bar context fill (used/window)",
    });
  });

  it("the quota levels are 80 and 95, declared in one place", () => {
    expect([...QUOTA_WARN_PERCENTS]).toEqual([80, 95]);
  });
});
