/**
 * Typing of `window.accountSessions` (sessions saved to and opened from the
 * account). A file of its own so `env.d.ts` stays untouched; the global
 * `Window` interface is merged by the declaration below.
 */
import type { AccountSessionsApi } from "../../preload/index";

declare global {
  interface Window {
    accountSessions: AccountSessionsApi;
  }
}

export {};
