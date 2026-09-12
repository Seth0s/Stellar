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
 * - `src/main/message-bus.ts` — text that `typeAndSubmit` types into a
 *   PTY for another agent (`[de: X] relatório disponível…`,
 *   `[de: X] saiu (código N) sem chamar report.`). The `[de: …]` prefix
 *   is a convention other code interprets; translating it breaks routing
 *   / recognition. Marked at each call site.
 * NOT on the list, and deliberately so — `src/main/bash-discovery-decision.ts`.
 * `BASH_CARD_DISCOVERY_TIP` is HUMAN-facing (a tip printed into scrollback
 * for the person), so it is not protocol surface and the array must not
 * claim it is. It stays in English anyway because an agent may happen to
 * read the same scrollback — same reasoning as `ACBRIDGE_HINT`, written at
 * the constant itself. Listing it here as agent-facing would have been a
 * lie a phase-2 sweep would then honour; a review of this file read it that
 * way and filed the omission as a hole, which is exactly the confusion this
 * paragraph removes.
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
  "src/main/message-bus.ts", // typeAndSubmit PTY payloads with [de: …]
  "src/main/status-write-decision.ts",
] as const;
