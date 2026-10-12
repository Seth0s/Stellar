/**
 * Number and text shaping for the update dialog — pure, so what the user reads
 * ("18,4 de 38,2 MB", "faltam cerca de 7 s") is testable without a renderer.
 *
 * Megabytes are decimal (1 MB = 1,000,000 bytes), the unit release pages and
 * download managers use, one decimal place, in the user's locale.
 */
import type { UpdaterError, UpdaterProgress } from "../../main/update-state";
import { t } from "../../shared/i18n";

const MB = 1_000_000;

function oneDecimal(locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** `18,4` — megabytes with one decimal. */
export function formatMegabytes(bytes: number, locale: string): string {
  return oneDecimal(locale).format(bytes / MB);
}

/** `38` — a whole number of megabytes, for the "Baixar · 38 MB" button. */
export function formatWholeMegabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(bytes / MB));
}

/** `3,1` — megabytes per second. */
export function formatSpeed(bytesPerSecond: number, locale: string): string {
  return formatMegabytes(bytesPerSecond, locale);
}

/** Time left, rounded up to a whole second or minute; `null` when no speed is known yet. */
export function remainingTime(progress: Pick<UpdaterProgress, "transferred" | "total" | "bytesPerSecond">): {
  unit: "s" | "min";
  value: number;
} | null {
  if (progress.bytesPerSecond <= 0 || progress.total <= 0) return null;
  const seconds = Math.max(0, Math.ceil((progress.total - progress.transferred) / progress.bytesPerSecond));
  return seconds < 60 ? { unit: "s", value: Math.max(1, seconds) } : { unit: "min", value: Math.ceil(seconds / 60) };
}

/**
 * The "Detalhe técnico" line: the library's code or first line, plus the
 * numbers that explain it (how far a download got, how much disk was needed).
 */
export function errorDetailLine(error: UpdaterError, locale: string): string {
  const base = error.code !== null && !error.detail.startsWith(error.code) ? `${error.code}: ${error.detail}` : error.detail;
  if (error.kind === "disk" && error.neededBytes !== null && error.freeBytes !== null) {
    return `${base} (${t("update.dialog.error.neededFree", {
      needed: formatWholeMegabytes(error.neededBytes, locale),
      free: formatWholeMegabytes(error.freeBytes, locale),
    })})`;
  }
  if (error.stage === "download" && error.percent !== null && error.transferred !== null && error.total !== null && error.total > 0) {
    const of = t("update.dialog.downloading.of", {
      done: formatMegabytes(error.transferred, locale),
      total: formatMegabytes(error.total, locale),
    });
    return `${base} (${error.percent}% · ${of})`;
  }
  return base;
}

/**
 * The "O que muda" bullets from a release body. Release notes are Markdown; the
 * dialog shows plain lines. List items become bullets, headings and HTML
 * comments are dropped, loose paragraphs count as one note each, and inline
 * emphasis/code/links are flattened to their text.
 */
export function parseChangelogNotes(changelog: string, max = 8): string[] {
  const notes: string[] = [];
  for (const raw of changelog.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("<!--") || /^[-*_]{3,}$/.test(line)) continue;
    const text = line
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`]+/g, "")
      .trim();
    if (text !== "") notes.push(text);
    if (notes.length >= max) break;
  }
  return notes;
}
