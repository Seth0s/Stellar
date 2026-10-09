/**
 * One Electron process per shared `userData`.
 *
 * `app.setName` is identical in `electron-vite dev` and the packaged
 * `/opt/Stellar/stellar` binary, so both resolve to the same userData
 * (`~/.config/stellar`) — same `agent-canvas.db`, same
 * `agent-canvas.sock`, same Chromium SingletonLock key. Two instances on
 * that profile are the bug class:
 *
 * - Socket: whoever binds first serves `acbridge` from BOTH trees.
 * - Card ids: the seed is read once per process and advanced in memory
 *   (store.ts) — two writers collide.
 * - "Is the app running old code?" is ambiguous with two "the app"s.
 *
 * Rejected alternatives:
 * - Separate userData by mode: the live DB holds the owner's boards plus
 *   cards/tasks/secrets/remote-devices/board-assets. Dev against an empty
 *   profile would wake the owner without their boards — expectation
 *   destruction, not a fix. Needs an explicit reversible migration if
 *   ever chosen; not this change.
 * - Per-resource flock only: the socket already probes EADDRINUSE; that does
 *   not stop a second process opening the DB with an independent seed.
 *   Refusing start when the resource is taken is what
 *   `requestSingleInstanceLock` already is.
 *
 * Policy: always request the lock after `setName`. The shared DB stays
 * shared (dev still sees the same boards when the packaged app is closed).
 * Concurrent writers are refused — the second launch focuses the holder via
 * `second-instance`.
 *
 * Identity note: a still-running pre-migration `agent-canvas` process
 * holds a *different* lock key. `user-data-migration.ts` aborts if the
 * legacy sock is live — the Electron lock alone cannot serialize across
 * the rename.
 */

export type SingleInstancePolicy = {
  /** Call `app.requestSingleInstanceLock()` after `setName`. */
  requestLock: true;
  /** On loss: `app.quit()` and skip `createWindow` / store / socket / MCP. */
  quitIfLost: true;
};

/**
 * @param _isPackaged Kept so call sites that branch on
 *   `app.isPackaged` stay honest — the value MUST NOT affect the policy.
 */
export function decideSingleInstancePolicy(_isPackaged: boolean): SingleInstancePolicy {
  return { requestLock: true, quitIfLost: true };
}

/**
 * The refusal has to SPEAK: losing the lock exits with `app.quit()` —
 * code 0, empty stderr — and whoever launched the app reads "opened and
 * closed" and concludes their own test is broken. Exiting silently with a
 * success code is the same defect class this repo keeps killing: the app
 * knew the answer and didn't say it.
 *
 * This is a DIAGNOSTIC STRING, not UI: it goes to the stderr of the process
 * that is giving up, which is where a human in a terminal or an agent
 * reading `npm run dev` output actually looks. So it does not go through
 * `t()` — there is no window to translate, and the reader may be an agent.
 *
 * It states the three things: THAT it is not a test failure, WHY (shared
 * userData, one process per database) and WHAT TO DO.
 */
export function describeSingleInstanceRefusal(userDataDir: string): string {
  return (
    `[stellar] outra instância já está rodando sobre este userData (${userDataDir}) — ` +
    `esta saiu sem abrir janela, e isso NÃO é falha do seu teste. ` +
    `Um processo por banco é deliberado: dois escritores colidem no socket do acbridge e no seed de ids de card. ` +
    `Feche a instância aberta antes de rodar dev/smoke, ou suba com --user-data-dir próprio (é o que scripts/verify/cdp-client.mjs faz).`
  );
}
