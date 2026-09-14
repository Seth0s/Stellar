/**
 * One Electron process per shared `userData`.
 *
 * Measured 2026-09-14: `app.setName("agent-canvas")` is identical in
 * `electron-vite dev` and the packaged `/opt/Stellar/stellar` binary, so
 * both resolve to `~/.config/agent-canvas` — same `agent-canvas.db`, same
 * `agent-canvas.sock`, same Chromium SingletonLock key. The previous
 * gate (`requestSingleInstanceLock` only when `app.isPackaged`) existed
 * so dev could open beside the installed app; that accommodation is the
 * bug class:
 *
 * - Socket: whoever binds first serves `acbridge` from BOTH trees.
 * - Card ids: seed is read once per process and advanced in memory
 *   (store.ts FURO 2) — two writers collide.
 * - "Is the app running old code?" is ambiguous with two "the app"s.
 *
 * Rejected alternatives (same day, with measurement):
 * - Separate userData by mode: live DB holds boards Maestro + Idyplatform,
 *   26 cards, 115 tasks, secrets, remote-devices, board-assets. Dev
 *   against an empty profile would wake the owner without their boards —
 *   expectation destruction, not a fix. Needs an explicit reversible
 *   migration if ever chosen; not this change.
 * - Per-resource flock only: socket already probes EADDRINUSE; that does
 *   not stop a second process opening the DB with an independent seed.
 *   Refusing start when the resource is taken is what
 *   `requestSingleInstanceLock` already is.
 *
 * Policy: always request the lock after `setName`. Shared DB stays shared
 * (dev still sees Maestro when the packaged app is closed). Concurrent
 * writers are refused — second launch focuses the holder via
 * `second-instance`.
 */

export type SingleInstancePolicy = {
  /** Call `app.requestSingleInstanceLock()` after `setName`. */
  requestLock: true;
  /** On loss: `app.quit()` and skip `createWindow` / store / socket / MCP. */
  quitIfLost: true;
};

/**
 * @param _isPackaged Kept so call sites that used to branch on
 *   `app.isPackaged` stay honest — the value MUST NOT affect the policy.
 */
export function decideSingleInstancePolicy(_isPackaged: boolean): SingleInstancePolicy {
  return { requestLock: true, quitIfLost: true };
}
