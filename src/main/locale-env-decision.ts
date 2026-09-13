/**
 * Pure decision for the locale vars a PTY should receive.
 *
 * A Finder-launched `.app` inherits launchd's minimal env: no LANG, no
 * LC_*. libc then settles on C / US-ASCII. The same hole exists on a
 * Linux host started with a stripped environment. Measured (2026-09-13,
 * macOS 26.6.2, arm64): the login shell had UTF-8, `locale -a` listed
 * dozens of UTF-8 names including pt_BR and C.UTF-8, and the Stellar
 * process itself had APP_ENV_LOCALE=ABSENT.
 *
 * This module never talks to a shell and never invents a name.
 * The caller passes the env we would inherit and the names `locale -a`
 * (or an equivalent listing) actually returned. We either write one of
 * those names or write nothing. A name `setlocale()` would refuse falls
 * back to C — the original bug, now wearing a disguise.
 *
 * Language is synthesized from the process env (when it names a real
 * language) and from the OS UI language hint. We do not copy the login
 * shell's LANG: on the measured Mac it was `C.UTF-8`, which would fix
 * encoding and throw away Portuguese CLI messages.
 *
 * POSIX encoding precedence: LC_ALL > LC_CTYPE > LANG.
 * An already-UTF-8 winner is left alone. C / POSIX / US-ASCII (and an
 * absent winner) are filled. Any other encoding (ISO-8859-1, EUC-JP) is
 * treated as a deliberate choice and kept.
 */

export type LocaleEnvInput = {
  env: Record<string, string | undefined>;
  availableLocales: readonly string[];
  /** BCP 47 or POSIX, e.g. `pt-BR` / `pt_BR`. From the OS UI language. */
  preferredLanguage?: string | null;
};

export type LocaleEnvDecision = {
  /** Variables to assign. Empty = leave the inherited env as-is. */
  writes: Record<string, string>;
};

const ENCODING_PRECEDENCE = ["LC_ALL", "LC_CTYPE", "LANG"] as const;
type EncodingVar = (typeof ENCODING_PRECEDENCE)[number];

type SplitLocale = {
  language: string;
  encoding: string | null;
  modifier: string | null;
};

export function splitLocaleName(name: string): SplitLocale {
  let rest = name.trim();
  let modifier: string | null = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    modifier = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const dot = rest.indexOf(".");
  if (dot < 0) return { language: rest, encoding: null, modifier };
  return { language: rest.slice(0, dot), encoding: rest.slice(dot + 1), modifier };
}

function compactEncoding(encoding: string): string {
  return encoding.toLowerCase().replace(/[-_]/g, "");
}

function normalizedLanguage(language: string): string {
  return language.replace(/-/g, "_").toLowerCase();
}

function encodingKind(encoding: string | null): "utf8" | "ascii" | "other" | null {
  if (!encoding) return null;
  const compact = compactEncoding(encoding);
  if (compact === "utf8") return "utf8";
  if (compact === "usascii" || compact === "ascii") return "ascii";
  return "other";
}

function isCFamilyLanguage(language: string): boolean {
  const lang = normalizedLanguage(language);
  return lang === "c" || lang === "posix";
}

/** True when the name itself claims UTF-8 (`pt_BR.UTF-8`, `C.utf8`, …). */
export function isUtf8LocaleName(name: string): boolean {
  return encodingKind(splitLocaleName(name).encoding) === "utf8";
}

/**
 * C / POSIX without a UTF-8 suffix, or an explicit US-ASCII / ASCII
 * charmap. `C.UTF-8` is NOT this — that name is already a UTF-8 locale.
 */
export function isExplicitCOrAsciiLocale(name: string): boolean {
  const { language, encoding } = splitLocaleName(name);
  const kind = encodingKind(encoding);
  if (kind === "utf8") return false;
  if (kind === "ascii") return true;
  return isCFamilyLanguage(language);
}

function readEnvVar(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function localeEncodingWinner(env: Record<string, string | undefined>): { key: EncodingVar; value: string } | { key: null; value: null } {
  for (const key of ENCODING_PRECEDENCE) {
    const value = readEnvVar(env, key);
    if (value !== undefined) return { key, value };
  }
  return { key: null, value: null };
}

function languageSearchKeysFromName(name: string): string[] {
  const { language } = splitLocaleName(name);
  if (!language) return [];
  const lower = normalizedLanguage(language);
  if (!lower || isCFamilyLanguage(lower)) return [];
  const keys = [lower];
  const under = lower.indexOf("_");
  if (under > 0) keys.push(lower.slice(0, under));
  return keys;
}

/**
 * Search keys, most specific first. Env-declared languages (even when
 * the encoding winner is C) beat the OS hint: `LANG=pt_BR.UTF-8` plus
 * `LC_ALL=C` still wants Portuguese.
 */
export function localeLanguageSearchKeys(env: Record<string, string | undefined>, preferredLanguage?: string | null): string[] {
  const keys: string[] = [];
  const add = (name: string | undefined) => {
    if (!name) return;
    for (const key of languageSearchKeysFromName(name)) {
      if (!keys.includes(key)) keys.push(key);
    }
  };
  add(readEnvVar(env, "LC_MESSAGES"));
  add(readEnvVar(env, "LANG"));
  add(readEnvVar(env, "LC_ALL"));
  add(preferredLanguage?.trim() || undefined);
  return keys;
}

function findUtf8ForKeys(pool: readonly string[], keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const exact = pool.find((name) => normalizedLanguage(splitLocaleName(name).language) === key);
    if (exact) return exact;
  }
  const langOnly = keys.find((key) => !key.includes("_"));
  if (langOnly) {
    const prefix = `${langOnly}_`;
    const regional = pool.find((name) => normalizedLanguage(splitLocaleName(name).language).startsWith(prefix));
    if (regional) return regional;
  }
  return undefined;
}

/**
 * Pick a name that IS in `available`. Preference: requested language,
 * then `C.UTF-8` / `C.utf8` (encoding-only fallback), then `en_US`,
 * then any UTF-8 name in listing order. Never invents a string.
 */
export function pickAvailableUtf8Locale(available: readonly string[], searchKeys: readonly string[] = []): string | null {
  const utf8 = available.filter(isUtf8LocaleName);
  if (utf8.length === 0) return null;
  const plain = utf8.filter((name) => splitLocaleName(name).modifier === null);
  const pool = plain.length > 0 ? plain : utf8;

  const fromKeys = findUtf8ForKeys(pool, searchKeys);
  if (fromKeys) return fromKeys;

  const fallback = findUtf8ForKeys(pool, ["c", "en_us", "en"]);
  if (fallback) return fallback;

  return pool[0] ?? null;
}

function needsCorrection(value: string | null): boolean {
  if (value === null) return true;
  if (isUtf8LocaleName(value)) return false;
  return isExplicitCOrAsciiLocale(value);
}

export function decideLocaleEnv(input: LocaleEnvInput): LocaleEnvDecision {
  const winner = localeEncodingWinner(input.env);
  if (!needsCorrection(winner.value)) return { writes: {} };

  const chosen = pickAvailableUtf8Locale(input.availableLocales, localeLanguageSearchKeys(input.env, input.preferredLanguage));
  if (!chosen) return { writes: {} };

  if (winner.key === "LC_ALL") return { writes: { LC_ALL: chosen } };

  if (winner.key === "LC_CTYPE") {
    const writes: Record<string, string> = { LC_CTYPE: chosen };
    const lang = readEnvVar(input.env, "LANG");
    if (!lang || needsCorrection(lang)) writes.LANG = chosen;
    return { writes };
  }

  return { writes: { LANG: chosen } };
}
