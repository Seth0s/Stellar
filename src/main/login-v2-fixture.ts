/**
 * Isolated UI fixture for app-v2 login screens (Boot / LoginWaiting / Invite).
 * Dev/smoke only: packaged builds never read STELLAR_LOGIN_V2_FIXTURE (same
 * gate as other test-only IPC in index.ts). Public-repo mocks stay fictional.
 */

import { readFileSync } from "node:fs";

export type LoginV2BootFixture = {
  sessionCount?: number;
  homeSynced?: boolean;
  /** When true, Boot never calls onReady so the smoke can capture the screen. */
  hold?: boolean;
};

export type LoginV2LoginFixture = {
  /** Wizard step 0..3 (browser / authorize / account / sync). */
  step?: 0 | 1 | 2 | 3;
  machineName?: string;
  /** Countdown seconds shown on the authorize step. */
  expiresSec?: number;
  displayName?: string;
};

export type LoginV2InviteFixture = {
  token: string;
  teamName: string;
  inviterName: string;
  role: "owner" | "admin" | "member";
  expiresInDays: number;
  email: string;
  skills: number;
  agents: number;
  rules: number;
};

export type LoginV2Fixture = {
  boot?: LoginV2BootFixture;
  login?: LoginV2LoginFixture;
  invite?: LoginV2InviteFixture;
};

export type LoadLoginV2FixtureInput = {
  isPackaged: boolean;
  /** Override for tests; defaults to process.env.STELLAR_LOGIN_V2_FIXTURE. */
  envPath?: string | undefined;
  /** Override for tests; defaults to fs.readFileSync. */
  readFile?: (path: string, encoding: BufferEncoding) => string;
};

/**
 * Returns the fixture JSON, or null. When `isPackaged` is true, returns null
 * immediately and never touches the filesystem — even if the env var is set.
 */
export function loadLoginV2Fixture(input: LoadLoginV2FixtureInput): LoginV2Fixture | null {
  if (input.isPackaged) return null;
  const path = input.envPath !== undefined ? input.envPath : process.env.STELLAR_LOGIN_V2_FIXTURE;
  if (!path) return null;
  const read = input.readFile ?? ((p, enc) => readFileSync(p, enc));
  try {
    return JSON.parse(read(path, "utf8")) as LoginV2Fixture;
  } catch (err) {
    console.warn(`[login-v2-fixture] failed to read ${path}:`, err);
    return null;
  }
}
