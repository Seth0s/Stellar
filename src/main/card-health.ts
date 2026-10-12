import { APP_NOTICE } from "./agent-facing-notices";

/**
 * CARD HEALTH FOR THE ORCHESTRATOR — context used and provider plan/quota.
 *
 * The failure this retires: the orchestrator had no way to know, BEFORE handing
 * a card more work, that the card was nearly out of context or of plan quota.
 * It delivered, waited, and counted a card that could no longer work as active,
 * while a card whose provider plan was nearly spent simply stopped mid-task
 * without calling `report`. Both facts are already on the card's own screen —
 * a plan/quota line, and (on some providers) a context-window reading.
 *
 * WHAT THIS MODULE IS, and what it refuses to be:
 *
 *   - It is DECLARED per provider (`HealthCapability`, next to `effort`/`model`
 *     in `ProviderCapacity`): the SCREEN PATTERN and the threshold. There is no
 *     `if (provider === …)`; a provider that declares no `health`, or exposes
 *     only part of the state, answers `null` for the rest — honest absence,
 *     never a made-up number.
 *   - It READS THE COPY THE APP ALREADY KEEPS (the ANSI-stripped PTY tail, the
 *     same text `read_card` hands the orchestrator) — never a CLI's live
 *     database, never a real session store.
 *   - It is PURE: given the screen text and an instant, it returns the reading.
 *     Enqueuing the alert and de-duplicating it is the bus's job.
 *
 * HONESTY RULE (the same one the rest of the repo follows): when the provider
 * does not expose a quantity, the answer is `null`. A fabricated context
 * percentage is WORSE than absence — plausible and wrong is the worst possible
 * input for a dispatch decision. In particular, a spinner token counter is the
 * TURN's volume (it resets and grows every turn), NOT the session context; a
 * provider that only has that counter declares NO context.
 *
 * THE MEASURED SOURCES (the declaration lives in `providers.ts`): claude prints
 * its context bar as `[bar] NN% <used>/<window>` and the CLI itself gives both
 * numbers (e.g. `720k/1m` = 72%); commandcode's spinner token count is turn
 * volume and is not used, and its quota line (`Plan: N% used`) is.
 */

/** A CONTEXT reading: tokens used, the window when the screen shows one, and
 *  where the reading came from. */
export type ContextReading = { usedTokens: number; windowTokens?: number; source: string; at: number };

/** A PLAN/QUOTA reading: the text the provider showed and, when it prints one,
 *  the percentage. A missing `percent` means the provider shows the line but the
 *  app could not read a number from it (never an invented zero). */
export type QuotaReading = { text: string; percent?: number; at: number };

/** What could actually be read from a card. `null` in a field means the provider
 *  does not expose that quantity (or there is no screen) — absence, not zero. */
export type CardHealth = { context: ContextReading | null; quota: QuotaReading | null };

/**
 * How to read the CONTEXT of this provider — declared, measured, never inferred.
 *
 * `pattern` runs over the ANSI-stripped copy of the screen. Group 1 is the used
 * number, group 2 its optional unit (`k`/`m`); groups 3/4, when the provider
 * prints the window too, are the window number and unit. The LAST occurrence
 * wins: a status line REPAINTS, so the most recent reading is the one on screen
 * now.
 */
export type ContextDecl = {
  /** Groups: 1 = used number, 2 = used unit; 3 = window number, 4 = window unit. */
  pattern: RegExp;
  /**
   * A FALLBACK window in tokens, used only when the pattern does not capture
   * one. Prefer reading the window the provider prints — a hard-coded window is
   * wrong the moment the model changes. Absent + no captured window = the
   * provider exposes context without a window, and no threshold can be honest.
   */
  windowTokens?: number;
  /** Window fraction (0..1) at or above which the orchestrator is warned. */
  warnFraction: number;
  /**
   * Corroboration by the provider's OWN percentage. When the screen prints
   * `NN% <used>/<window>`, this pattern runs over the text right BEFORE the
   * match (anchored at its end, group 1 = NN) and the reading only counts if
   * NN agrees with used/window. The status bar is repainted in place and the
   * app only sees an ANSI-stripped stream, so a number can be glued to a
   * neighbouring fragment; a pair that disagrees with the bar's own percent
   * is a torn read, and an absent reading beats a wrong one.
   */
  barPercent?: RegExp;
  /** Where the reading was taken (the reading's `source` field). */
  source: string;
};

/** How far the bar's own rounded percentage may sit from used/window (points). */
const BAR_PERCENT_TOLERANCE = 2;
/** How much text before a match is searched for the bar's own percentage. */
const BAR_PERCENT_LOOKBEHIND = 16;

/** How to read the PLAN/QUOTA of this provider. Group 1 is the percentage. The
 *  whole LINE that matched becomes `quota.text` (it carries the remaining
 *  credits, the emoji, whatever the provider wrote). */
export type QuotaDecl = {
  pattern: RegExp;
  source: string;
};

/** A provider's health declaration — a sibling of `effort`/`model` in
 *  `ProviderCapacity`. Absent = this provider exposes nothing, and the honest
 *  answer is `{ context: null, quota: null }`. */
export type HealthCapability = {
  context?: ContextDecl;
  quota?: QuotaDecl;
};

/** The quota percentages at which the orchestrator is warned (once per level). */
export const QUOTA_WARN_PERCENTS: readonly number[] = [80, 95];

/** An alert ready to enqueue; `key` is what de-duplicates ("once per level").
 *  The text is AGENT-FACING (English — a model reads it). */
export type HealthAlert = { key: string; message: string };

/** Points BELOW a level the reading must fall before that level may warn again.
 *  Without it a card hovering around a threshold would warn on every crossing. */
export const REARM_MARGIN_POINTS = 5;

/** A quota alert describes the provider's PLAN, which every card of that
 *  provider shares; a context alert describes one card's own window. */
export function healthAlertScope(key: string): "provider" | "card" {
  return key.startsWith("quota:") ? "provider" : "card";
}

/** The structured warning attached to the DELIVERY of a task to a hot card:
 *  it does NOT refuse, it warns. */
export type ContextWarning = {
  usedTokens: number;
  windowTokens: number;
  percent: number;
  thresholdPercent: number;
  source: string;
};

/**
 * Turns a number plus optional unit into tokens. `k`/`m` are decimal (1.000 =
 * 1k); a comma is accepted as the decimal separator. `null` when it is not a
 * valid number — never a `NaN` dressed up as a reading.
 */
export function parseTokenCount(numeric: string, unit?: string): number | null {
  // `Number("")` is 0 — absence of a number must not become zero.
  if (numeric.trim() === "") return null;
  const value = Number(numeric.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return null;
  const u = unit?.toLowerCase();
  const scale = u === "k" ? 1e3 : u === "m" ? 1e6 : 1;
  return Math.round(value * scale);
}

/** The line (no `\n`) that contains the given index, trimmed. */
function lineContaining(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/**
 * The LAST occurrence of the pattern. Clones the pattern with the `g` flag to
 * scan without touching the shared declaration's `lastIndex` — two readings of
 * the same provider never interfere with each other.
 */
function lastMatch(pattern: RegExp, text: string): RegExpExecArray | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let found: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found = m;
    // Guard against an empty match (a pattern that matches a position).
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return found;
}

/** Every occurrence of the pattern, in order (same `g` clone as `lastMatch`). */
function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const found: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return found;
}

/**
 * One match turned into a reading, or `null` when it cannot be trusted:
 *  - the used number does not parse;
 *  - the window is printed and the used count EXCEEDS it (a context cannot be
 *    over 100% of its own window — that is a torn read, not an overflow);
 *  - the provider declared a `barPercent` and the bar's own percentage is
 *    missing or disagrees with used/window.
 */
function readingFromMatch(
  decl: ContextDecl,
  screenText: string,
  m: RegExpExecArray,
  at: number,
): ContextReading | null {
  const used = parseTokenCount(m[1] ?? "", m[2]);
  if (used === null) return null;
  // The window is optional: only when the pattern captured it.
  const window = m[3] === undefined ? null : parseTokenCount(m[3], m[4]);
  const hasWindow = window !== null && window > 0;
  if (hasWindow && used > window) return null;
  if (decl.barPercent) {
    const before = screenText.slice(Math.max(0, m.index - BAR_PERCENT_LOOKBEHIND), m.index);
    const bar = lastMatch(decl.barPercent, before);
    if (!bar || bar[1] === undefined) return null;
    const printed = Number(bar[1]);
    if (!Number.isFinite(printed)) return null;
    if (hasWindow && Math.abs(printed - (used / window) * 100) > BAR_PERCENT_TOLERANCE) return null;
  }
  return {
    usedTokens: used,
    ...(hasWindow ? { windowTokens: window } : {}),
    source: decl.source,
    at,
  };
}

/**
 * Reads the context from screen text, using the provider's declaration. The
 * LAST occurrence that can be trusted wins: a status line REPAINTS, so the
 * newest reading is the one on screen now — but a torn newest read must not
 * hide a good earlier one, and must never become the answer.
 */
export function readContextReading(
  decl: ContextDecl,
  screenText: string,
  at: number,
): ContextReading | null {
  const matches = allMatches(decl.pattern, screenText);
  for (let i = matches.length - 1; i >= 0; i--) {
    const reading = readingFromMatch(decl, screenText, matches[i]!, at);
    if (reading) return reading;
  }
  return null;
}

/** Reads the plan/quota from screen text, using the provider's declaration. */
export function readQuotaReading(
  decl: QuotaDecl,
  screenText: string,
  at: number,
): QuotaReading | null {
  const m = lastMatch(decl.pattern, screenText);
  if (!m) return null;
  const text = lineContaining(screenText, m.index);
  const parsed = m[1] === undefined ? NaN : Number(m[1].replace(",", "."));
  return Number.isFinite(parsed) ? { text, percent: parsed, at } : { text, at };
}

/** The FULL reading of a card. Without a declaration (a provider that exposes
 *  nothing) or without a screen, both fields are `null` — never a guess. */
export function readCardHealth(
  capability: HealthCapability | null | undefined,
  screenText: string | null | undefined,
  at: number,
): CardHealth {
  if (!capability) return { context: null, quota: null };
  const text = screenText ?? "";
  return {
    context: capability.context ? readContextReading(capability.context, text, at) : null,
    quota: capability.quota ? readQuotaReading(capability.quota, text, at) : null,
  };
}

/** A token count in short display form (`255.1k`, `1m`). Display only. */
export function formatTokenCount(n: number): string {
  const trim = (v: number): string => String(Number(v.toFixed(1)));
  if (n >= 1e6) return `${trim(n / 1e6)}m`;
  if (n >= 1e3) return `${trim(n / 1e3)}k`;
  return String(n);
}

/**
 * The window to measure against: the one the screen showed, else the declared
 * fallback. `null` when neither exists — and then no threshold can be honest,
 * so callers must not warn.
 */
export function resolveContextWindow(
  reading: ContextReading,
  decl: ContextDecl,
): number | null {
  const window = reading.windowTokens ?? decl.windowTokens;
  return window !== undefined && window > 0 ? window : null;
}

/** The fraction of the window already used (0..1+). No window -> `0`. */
export function contextUsedFraction(reading: ContextReading, decl: ContextDecl): number {
  const window = resolveContextWindow(reading, decl);
  if (window === null) return 0;
  return reading.usedTokens / window;
}

/** Is the reading at or above the provider's declared threshold? No window to
 *  measure against means no warning — absence, never a guessed percentage. */
export function isContextAboveThreshold(reading: ContextReading, decl: ContextDecl): boolean {
  const window = resolveContextWindow(reading, decl);
  if (window === null) return false;
  return reading.usedTokens / window >= decl.warnFraction;
}

/**
 * The structured warning for a DELIVERY — `null` when there is no reading, no
 * window, or the reading is below the threshold. It does not refuse the
 * delivery: it only warns.
 */
export function contextWarning(
  health: CardHealth,
  capability: HealthCapability | null | undefined,
): ContextWarning | null {
  const decl = capability?.context;
  if (!health.context || !decl) return null;
  const window = resolveContextWindow(health.context, decl);
  if (window === null || !isContextAboveThreshold(health.context, decl)) return null;
  return {
    usedTokens: health.context.usedTokens,
    windowTokens: window,
    percent: Math.round((health.context.usedTokens / window) * 100),
    thresholdPercent: Math.round(decl.warnFraction * 100),
    source: health.context.source,
  };
}

/** A sentence (agent-facing English) describing a `ContextWarning`. */
export function describeContextWarning(warn: ContextWarning): string {
  return (
    `context at ${warn.percent}% of its declared window ` +
    `(${formatTokenCount(warn.usedTokens)} of ${formatTokenCount(warn.windowTokens)} tokens, source: ${warn.source})`
  );
}

/**
 * Every ACTIVE alert for this reading — context above its threshold and each
 * quota level reached. The bus de-duplicates by `key` (once per level) and
 * REMOVES the key when the reading drops back, so the alert can fire again if
 * the card fills up once more.
 */
export function healthAlerts(opts: {
  health: CardHealth;
  capability: HealthCapability | null | undefined;
  cardLabel: string;
  provider: string;
}): HealthAlert[] {
  const { health, capability, cardLabel, provider } = opts;
  const alerts: HealthAlert[] = [];

  if (health.quota?.percent !== undefined) {
    const percent = health.quota.percent;
    for (const threshold of QUOTA_WARN_PERCENTS) {
      if (percent < threshold) continue;
      alerts.push({
        key: `quota:${threshold}`,
        message: APP_NOTICE.quotaHealth({ cardLabel, provider, percent, threshold }),
      });
    }
  }

  const decl = capability?.context;
  if (health.context && decl && isContextAboveThreshold(health.context, decl)) {
    const warning = contextWarning(health, capability);
    if (!warning) return alerts;
    alerts.push({
      key: "context",
      message: APP_NOTICE.contextHealth({ cardLabel, provider, percent: warning.percent }),
    });
  }

  return alerts;
}

/**
 * The alert keys this reading proves are COOL — safe to warn about again if the
 * level is crossed once more. Only a trustworthy reading well below the level
 * counts (by `REARM_MARGIN_POINTS`); a missing or torn reading proves nothing,
 * so it never re-arms an alert (otherwise a repaint glitch would make the same
 * conclusion fire again).
 */
export function healthCoolKeys(opts: {
  health: CardHealth;
  capability: HealthCapability | null | undefined;
}): string[] {
  const { health, capability } = opts;
  const keys: string[] = [];
  if (health.quota?.percent !== undefined) {
    for (const threshold of QUOTA_WARN_PERCENTS) {
      if (health.quota.percent < threshold - REARM_MARGIN_POINTS) keys.push(`quota:${threshold}`);
    }
  }
  const decl = capability?.context;
  if (health.context && decl) {
    const window = resolveContextWindow(health.context, decl);
    if (window !== null && (health.context.usedTokens / window) * 100 < decl.warnFraction * 100 - REARM_MARGIN_POINTS) {
      keys.push("context");
    }
  }
  return keys;
}
