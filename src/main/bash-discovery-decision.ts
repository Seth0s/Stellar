/**
 * DESIGN-BACKLOG.md §2.1 "Identidade e descoberta", points 3 and 4 —
 * pure decisions for a bash card where the user launches an agent by hand.
 *
 * Point 3 (discovery): every card, bash included, already inherits
 * AGENT_CANVAS_* and `acbridge` on PATH (`pty-registry.ts`). Provider
 * cards additionally get `--mcp-config` / system-prompt injection from
 * `providers.ts::buildArgs`. A hand-launched agent inside bash gets
 * neither, so it can act on the board and has no reliable way to learn
 * that. Auto-teaching that agent would require wrapping its binary by
 * name (forbidden — fragile, ages badly) or injecting into launch args
 * after the user already typed the command (impossible from here).
 *
 * Chosen coverage: a one-shot HUMAN tip in the bash card's scrollback.
 * That answers the repo owner's question ("is this why my agent didn't
 * use Stellar?") without touching ~/.bashrc / ~/.zshrc and without
 * pretending the nested agent itself was taught.
 *
 * Point 4 (identity): AGENT_CANVAS_CARD_ID is the bash card, not the
 * nested agent. `acbridge claim-card` was considered and declined — no
 * cheap handshake exists, and a new card would still not inject MCP/
 * system-prompt into an already-running process. Same known-gap class
 * as Claude Code `fork` subagents inheriting the parent's MCP identity.
 */

export type BashDiscoveryInput = {
  /** Provider id of the card being spawned (`"bash"` | `"claude"` | …). */
  providerId: string;
};

export type BashDiscoveryDecision = {
  /**
   * Non-null only for the bash provider: text to surface once in the
   * card's scrollback (via the renderer's onData path — never via shell
   * stdin, never via --rcfile / --init-file).
   */
  scrollbackTip: string | null;
  /** Whether a hand-launched nested agent can auto-discover Stellar. */
  nestedAgentAutoDiscovery: "full" | "none";
  /**
   * Explicit product decision on point 4 — always `"known_gap"` today.
   * Kept as a field so a future claim-card (if ever built) flips one
   * place instead of re-deriving the policy from comments.
   */
  nestedIdentity: "card_is_self" | "known_gap";
};

/** Human-facing, English (same public as ACBRIDGE_HINT — agents may
 * happen to read scrollback; never localize agent-adjacent runtime text).
 * No `http://` substring: pty-registry's passive URL sighting would
 * otherwise chip a false URL from this banner. */
export const BASH_CARD_DISCOVERY_TIP =
  "[stellar] Bash card: `acbridge` is on PATH and AGENT_CANVAS_* is set, " +
  "but an agent you launch by hand here does NOT get the `stellar` MCP " +
  "tools or the environment system-prompt. Prefer a provider card " +
  "(Claude/Codex/…) for full board integration. Nested-agent identity " +
  "(actions attributed to this bash card) is a known gap — same class as " +
  "Claude Code fork subagents.";

/**
 * Decide what (if anything) a freshly spawned card should surface about
 * hand-launched nested agents. Pure: no I/O, no env reads.
 */
export function decideBashCardDiscovery(input: BashDiscoveryInput): BashDiscoveryDecision {
  if (input.providerId === "bash") {
    return {
      scrollbackTip: BASH_CARD_DISCOVERY_TIP,
      nestedAgentAutoDiscovery: "none",
      nestedIdentity: "known_gap",
    };
  }
  return {
    scrollbackTip: null,
    // Provider cards get buildArgs coverage (MCP and/or system-prompt)
    // for the TOP-level process; a further nested hand-launch inside
    // that card is out of scope here (same gap class, different card).
    nestedAgentAutoDiscovery: "full",
    nestedIdentity: "card_is_self",
  };
}
