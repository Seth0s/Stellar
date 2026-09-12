/**
 * DESIGN-BACKLOG.md §2.1 "Internacionalizacao" — THE boundary that matters
 * more than the library choice.
 *
 * Three text audiences; only HUMAN is translated:
 *
 * 1. HUMAN — renderer UI, native menus, dialogs. Goes through `t()`.
 * 2. AGENT — never translate. English is correct when the reader is a
 *    model. Translating changes agent behaviour and breaks parsers; no
 *    current test would catch that.
 * 3. DEVELOPER — `console.warn`, logs. Never translate.
 *
 * AGENT-FACING modules / surfaces (do NOT sweep these in phase 2):
 *
 * - `src/main/mcp-server.ts` — `SERVER_INSTRUCTIONS` and every MCP tool
 *   `description:` string. Protocol surface for models.
 * - `src/main/providers.ts` — `ACBRIDGE_HINT` (system-prompt nudge injected
 *   into provider CLIs). Marked at the constant itself.
 * - `src/main/bash-discovery-decision.ts` — `AGENT_SCROLLBACK_DISCOVERY_TIP`
 *   and `REPORT_DISCOVERY_UNREACHABLE_TIP` (capacity-derived scrollback /
 *   spawn refusal for providers without a system-prompt flag). AGENT-facing.
 *   `BASH_CARD_DISCOVERY_TIP` is HUMAN-facing (tip for the person about
 *   nested agents) and stays English because agents may read the same
 *   scrollback — listed here only for the agent tips above.
 * - `src/main/message-bus.ts` — text that `typeAndSubmit` types into a
 *   PTY for another agent (`[de: X] relatório disponível…`,
 *   `[de: X] saiu (código N) sem chamar report.`). The `[de: …]` prefix
 *   is a convention other code interprets; translating it breaks routing
 *   / recognition. Marked at each call site.
 * - `src/main/status-write-decision.ts` — strings delivered to the writing
 *   agent via `typeAndSubmit` / MCP response. Agent-facing.
 *
 * This file exists so a future "extract every string" sweep has a hard
 * checklist instead of relying on memory. Importing it is optional; the
 * comments on the modules above are the operational guard.
 */

export const AGENT_FACING_MODULES = [
  "src/main/mcp-server.ts",
  "src/main/providers.ts", // ACBRIDGE_HINT only — provider labels are HUMAN
  "src/main/bash-discovery-decision.ts", // AGENT_SCROLLBACK_* / UNREACHABLE tips
  "src/main/message-bus.ts", // typeAndSubmit PTY payloads with [de: …]
  "src/main/status-write-decision.ts",
] as const;
