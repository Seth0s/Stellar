/**
 * Isolated UI fixture for the app-v3 dual-ring radial (provider arc + quotas).
 * Dev/smoke only: packaged builds never read STELLAR_RADIAL_FIXTURE (same
 * gate as login-v2-fixture / other test-only IPC).
 */

import { readFileSync } from "node:fs";
import { app, ipcMain } from "electron";

export type RadialFixtureProvider = {
  id: string;
  label: string;
  quota: string;
  tone: "ok" | "warn" | "muted";
  dim: boolean;
  stats: Record<string, unknown>;
};

export type RadialFixture = {
  providers: RadialFixtureProvider[];
  defaultProviderId: string;
};

export type LoadRadialFixtureInput = {
  isPackaged: boolean;
  /** Override for tests; defaults to process.env.STELLAR_RADIAL_FIXTURE. */
  envPath?: string | undefined;
  /** Override for tests; defaults to fs.readFileSync. */
  readFile?: (path: string, encoding: BufferEncoding) => string;
};

/**
 * Returns the fixture JSON, or null. When `isPackaged` is true, returns null
 * immediately and never touches the filesystem — even if the env var is set.
 */
export function loadRadialFixture(input: LoadRadialFixtureInput): RadialFixture | null {
  if (input.isPackaged) return null;
  const path = input.envPath !== undefined ? input.envPath : process.env.STELLAR_RADIAL_FIXTURE;
  if (!path) return null;
  const read = input.readFile ?? ((p, enc) => readFileSync(p, enc));
  try {
    return JSON.parse(read(path, "utf8")) as RadialFixture;
  } catch (err) {
    console.warn(`[radial-fixture] failed to read ${path}:`, err);
    return null;
  }
}

/** Register `ui:radial-fixture`. Call once from main bootstrap (see index.ts). */
export function registerRadialFixtureIpc(): void {
  ipcMain.handle("ui:radial-fixture", (): RadialFixture | null => {
    if (app.isPackaged) return null;
    return loadRadialFixture({ isPackaged: false });
  });
}
