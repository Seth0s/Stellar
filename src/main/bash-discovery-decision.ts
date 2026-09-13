/**
 * DESIGN-BACKLOG.md §0 capacity contract + §2.1 "Identidade e descoberta"
 * points 3 and 4 — pure decisions for what a freshly spawned card surfaces
 * about Stellar discovery / report.
 *
 * Report-discovery DELIVERY is derived from `ProviderCapacity` in
 * `providers.ts` (`deriveReportDiscovery`), not chosen per-provider here:
 *
 *   system_prompt  → ACBRIDGE_HINT already injected by buildArgs; no tip
 *   scrollback     → AGENT_SCROLLBACK_DISCOVERY_TIP (no system-prompt flag)
 *   not_applicable → shell card (bash nested-agent tip is separate)
 *   unreachable    → spawnBlock — refuse spawn visibly, never fail at report
 *
 * Point 3 (bash nested agents): a hand-launched agent inside bash gets
 * neither MCP injection nor system-prompt. Coverage: BASH_CARD_DISCOVERY_TIP
 * (human tip). Auto-teaching that agent would require wrapping binaries by
 * name (forbidden) or injecting launch args after the user typed them
 * (impossible).
 *
 * Point 4 (identity): AGENT_CANVAS_CARD_ID is the bash card, not the nested
 * agent. `acbridge claim-card` declined — known gap.
 */

import {
  deriveReportChannel,
  deriveReportDiscovery,
  providerCapacity,
  type ReportChannel,
  type ReportDiscovery,
} from "./providers";

export type BashDiscoveryInput = {
  /** Provider id of the card being spawned (`"bash"` | `"claude"` | …). */
  providerId: string;
};

export type BashDiscoveryDecision = {
  /**
   * Non-null when the derived report-discovery path is scrollback, or when
   * the card is bash (nested-agent human tip). Surfaced once via the
   * renderer's onData path — never via shell stdin, never via --rcfile.
   */
  scrollbackTip: string | null;
  /**
   * Non-null when `deriveReportDiscovery` returns `unreachable`. Caller
   * (pty-registry) MUST refuse the spawn — visible failure, not a silent
   * hole at report time.
   */
  spawnBlock: string | null;
  /** Derived report-discovery path for this provider (or unreachable). */
  reportDiscovery: ReportDiscovery;
  /** Derived channel the report is expected on (`deriveReportChannel`) —
   * same `capacity.mcp` that gates `ensureMcpRegistered`. */
  reportChannel: ReportChannel;
  /** Whether a hand-launched nested agent can auto-discover Stellar. */
  nestedAgentAutoDiscovery: "full" | "none";
  /**
   * Explicit product decision on point 4 — always `"known_gap"` for bash
   * today. Kept as a field so a future claim-card (if ever built) flips one
   * place instead of re-deriving the policy from comments.
   */
  nestedIdentity: "card_is_self" | "known_gap";
};

/**
 * AGENT-FACING — DO NOT TRANSLATE. English; models read scrollback.
 * No `http://` substring: pty-registry's passive URL sighting would
 * otherwise chip a false URL from this banner.
 *
 * Delivered when capacity derives `scrollback` (no system-prompt flag,
 * acbridge on PATH). Same substance as ACBRIDGE_HINT, framed for a
 * one-shot scrollback line so cursor/antigravity/opencode learn to report
 * without depending on MCP tools actually connecting. Single rule, same
 * as ACBRIDGE_HINT: the agent looks at its own catalog and picks the
 * channel — both land in the same record (`promoteReportVerdict`).
 */
export const AGENT_SCROLLBACK_DISCOVERY_TIP =
  "[stellar] This provider has no system-prompt injection. When you " +
  "finish a task another card spawned you for, report a structured " +
  "result: if a tool named `report` is in your tool catalog (MCP server " +
  "`stellar`), call it; otherwise run `acbridge report '<json>'` (on " +
  "PATH) with `verdict` inside the JSON. Same payload, same record " +
  "either way.";

/** Human-facing tip for bash cards (nested hand-launched agents). English
 * for the same reason as ACBRIDGE_HINT; agents may read the scrollback.
 * No `http://` substring (URL sighting). */
export const BASH_CARD_DISCOVERY_TIP =
  "[stellar] Bash card: `acbridge` is on PATH and AGENT_CANVAS_* is set, " +
  "but an agent you launch by hand here does NOT get the `stellar` MCP " +
  "tools or the environment system-prompt. Prefer a provider card " +
  "(Claude/Codex/…) for full board integration. Nested-agent identity " +
  "(actions attributed to this bash card) is a known gap — same class as " +
  "Claude Code fork subagents.";

/** Visible spawn refusal when no discovery path exists. AGENT-FACING English. */
export const REPORT_DISCOVERY_UNREACHABLE_TIP =
  "[stellar] Refusing spawn: this provider cannot teach an agent to " +
  "report (no system-prompt flag and no `acbridge` on PATH). Fix the " +
  "provider capacity declaration before spawning.";

/**
 * Decide what a freshly spawned card should surface about discovery /
 * report, DERIVED from the provider's capacity declaration.
 * Pure: no I/O, no env reads.
 */
export function decideBashCardDiscovery(input: BashDiscoveryInput): BashDiscoveryDecision {
  const capacity = providerCapacity(input.providerId);
  if (!capacity) {
    // Unknown id — refuse rather than spawn a silent hole.
    return {
      scrollbackTip: null,
      spawnBlock: REPORT_DISCOVERY_UNREACHABLE_TIP,
      reportDiscovery: "unreachable",
      reportChannel: "unreachable",
      nestedAgentAutoDiscovery: "none",
      nestedIdentity: "known_gap",
    };
  }

  const reportDiscovery = deriveReportDiscovery(capacity);
  const reportChannel = deriveReportChannel(capacity);

  if (input.providerId === "bash") {
    return {
      scrollbackTip: BASH_CARD_DISCOVERY_TIP,
      spawnBlock: null,
      reportDiscovery,
      reportChannel,
      nestedAgentAutoDiscovery: "none",
      nestedIdentity: "known_gap",
    };
  }

  if (reportDiscovery === "unreachable") {
    return {
      scrollbackTip: null,
      spawnBlock: REPORT_DISCOVERY_UNREACHABLE_TIP,
      reportDiscovery,
      reportChannel,
      nestedAgentAutoDiscovery: "none",
      nestedIdentity: "card_is_self",
    };
  }

  return {
    scrollbackTip: reportDiscovery === "scrollback" ? AGENT_SCROLLBACK_DISCOVERY_TIP : null,
    spawnBlock: null,
    reportDiscovery,
    reportChannel,
    // Provider cards get buildArgs coverage (MCP and/or system-prompt)
    // for the TOP-level process; a further nested hand-launch inside
    // that card is out of scope here (same gap class, different card).
    nestedAgentAutoDiscovery: "full",
    nestedIdentity: "card_is_self",
  };
}
