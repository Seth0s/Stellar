/**
 * DESIGN-BACKLOG.md §2.1 "Internacionalizacao" — FASE 1 infrastructure.
 *
 * Typed catalog + pure `t()`, shared by main and renderer with no React
 * provider. See `agent-facing.ts` before extracting any more strings.
 */

export type { Locale, MessageKey } from "./catalogs";
export type { TVars } from "./t";
export { CATALOGS, SUPPORTED_LOCALES, ptBR, en } from "./catalogs";
export { t, getLocale, setLocale, resolveLocale, isLocale } from "./t";
export { formatRelativeTime } from "./relative-time";
export { AGENT_FACING_MODULES } from "./agent-facing";
