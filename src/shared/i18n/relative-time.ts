/**
 * DESIGN-BACKLOG.md §2.1 "Internacionalizacao" — replace hand-rolled
 * relative-time strings (`"2d"`, `"18h"`, `"agora"`) with
 * `Intl.RelativeTimeFormat` so the unit labels follow the active locale
 * instead of staying Portuguese forever.
 *
 * Pure: `now` is an explicit argument (same testability convention as
 * `formatTaskAge` / `evaluateRebindCandidate`). Reads `getLocale()` for
 * the catalog locale — call `setLocale` in tests before asserting.
 */

import { getLocale } from "./t";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Unit = "second" | "minute" | "hour" | "day";

/**
 * Coarse relative age for UI chips and session cards. Picks the largest
 * unit that still fits (never "1d 3h") — same granularity the old
 * hand-rolled formatters used — then lets `Intl` own the wording.
 */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto", style: "narrow" });

  if (diff < MINUTE_MS) return rtf.format(0, "second");

  let value: number;
  let unit: Unit;
  if (diff < HOUR_MS) {
    value = Math.floor(diff / MINUTE_MS);
    unit = "minute";
  } else if (diff < DAY_MS) {
    value = Math.floor(diff / HOUR_MS);
    unit = "hour";
  } else {
    value = Math.floor(diff / DAY_MS);
    unit = "day";
  }
  return rtf.format(-value, unit);
}
