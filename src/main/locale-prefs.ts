/**
 * DESIGN-BACKLOG.md §2.1 "Internacionalizacao" — persisted locale override.
 *
 * Lives outside `store.ts` on purpose (board/card data is a different
 * concern; another agent owns that file this session). Same atomic-write
 * posture as `secrets.ts`: sibling `.tmp` + `renameSync`.
 *
 * `null` override = follow `app.getLocale()`. The resolved locale is
 * computed by shared `resolveLocale`, not here.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLocale, type Locale } from "../shared/i18n";

type LocaleFile = { override: Locale | null };

function localePath(userDataDir: string): string {
  return join(userDataDir, "locale.json");
}

function readFile(userDataDir: string): LocaleFile {
  const path = localePath(userDataDir);
  if (!existsSync(path)) return { override: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { override?: unknown };
    return { override: isLocale(raw.override) ? raw.override : null };
  } catch {
    return { override: null };
  }
}

function writeFile(userDataDir: string, data: LocaleFile): void {
  const path = localePath(userDataDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, path);
}

export function createLocalePrefs(userDataDir: string) {
  let cache: LocaleFile | null = null;

  function load(): LocaleFile {
    if (!cache) cache = readFile(userDataDir);
    return cache;
  }

  return {
    getOverride(): Locale | null {
      return load().override;
    },
    setOverride(override: Locale | null): void {
      cache = { override };
      writeFile(userDataDir, cache);
    },
  };
}

export type LocalePrefs = ReturnType<typeof createLocalePrefs>;
