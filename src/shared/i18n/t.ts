/**
 * DESIGN-BACKLOG.md §2.1 "Internacionalizacao" — FASE 1.
 *
 * Pure `t()` — no React provider, no i18next. Main (native menus,
 * dialogs) and renderer share the same catalogs via `src/shared/`, the
 * same cross-process pattern as `card-identity.ts`. Testable under
 * vitest `environment: "node"`.
 *
 * Interpolation is intentional minimal `{name}` replacement — ICU
 * plurals are not needed for phase 1 (pt/en are both one/other;
 * `Intl.PluralRules` covers that if a later phase needs it).
 */

import { CATALOGS, type Locale, type MessageKey, SUPPORTED_LOCALES } from "./catalogs";

let currentLocale: Locale = "pt-BR";

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/**
 * Map Electron's `app.getLocale()` (BCP 47, e.g. `en-US`, `pt-BR`, `pt`)
 * onto a supported catalog. Override wins when present — an English host
 * that wants a Portuguese UI is the explicit case the backlog names.
 */
export function resolveLocale(appLocale: string, override: Locale | null | undefined): Locale {
  if (override && (SUPPORTED_LOCALES as readonly string[]).includes(override)) {
    return override;
  }
  const normalized = appLocale.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  return "en";
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export type TVars = Record<string, string | number>;

export function t(key: MessageKey, vars?: TVars): string {
  let out: string = CATALOGS[currentLocale][key];
  if (!vars) return out;
  for (const [name, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}
