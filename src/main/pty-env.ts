/**
 * Environment hygiene for PTY children.
 *
 * A card is a process the Stellar main process spawns, and `spawn()` used to
 * inherit the whole main-process environment. Two classes of variable must not
 * cross that boundary.
 *
 * 1. APP IDENTITY. A card that runs `xdg-open` on a link hands the launched
 *    program whatever the Stellar process calls itself. Measured on this
 *    machine: a Brave opened from a card's artifact link inherited
 *    `CHROME_DESKTOP=stellar.desktop` plus
 *    `GIO_LAUNCHED_DESKTOP_FILE{,_PID}=/usr/share/applications/stellar.desktop`.
 *    Chromium reads `CHROME_DESKTOP` as its app identity, so the desktop
 *    grouped the browser's whole process tree (~3 GB, ~60% CPU) as "Stellar".
 *    Every key below is that same kind of leak.
 *
 * 2. ELECTRON INTERNALS. `ELECTRON_*` describes the Electron runtime that is
 *    running Stellar, not the CLI in the card. None of them is needed by a
 *    provider: the `resources/bin` shims set `ELECTRON_RUN_AS_NODE` themselves
 *    (`stellar-mcp`, `acbridge`) right before re-executing `AGENT_CANVAS_NODE`,
 *    so a card never relies on inheriting it. (This is a separate concern from
 *    the session-identity keys, which stay where they are: see
 *    `pty-registry.ts::isInheritedClaudeSessionEnvKey`.)
 *
 * The policy is DATA, not scattered `if`s: a new identity key is one line here,
 * and the whole set is asserted by a test.
 */

/** Exact keys that carry the parent app's identity into a descendant. */
export const PTY_IDENTITY_ENV_EXACT: readonly string[] = [
  // Chromium's app identity. Set when Stellar is launched from its .desktop
  // entry; inherited by any Chromium-based app a card opens.
  "CHROME_DESKTOP",
  // Chromium's own stash of the desktop name it overrode (ozone). Internal to
  // Chromium; a CLI has no use for it.
  "ORIGINAL_XDG_CURRENT_DESKTOP",
  // GIO's record of the .desktop file that launched this process — the same
  // "who launched me" identity, inherited from the Stellar launch.
  "GIO_LAUNCHED_DESKTOP_FILE",
  "GIO_LAUNCHED_DESKTOP_FILE_PID",
  // XDG startup/activation tokens: they let a child claim the focus and the
  // grouping of the app that launched it.
  "DESKTOP_STARTUP_ID",
  "XDG_ACTIVATION_TOKEN",
];

/** Prefixes of Electron-runtime internals that must not reach a card. */
export const PTY_IDENTITY_ENV_PREFIXES: readonly string[] = ["ELECTRON_"];

/** True when an inherited key must be dropped from a PTY's environment. */
export function isIdentityEnvKey(key: string): boolean {
  return PTY_IDENTITY_ENV_EXACT.includes(key) || PTY_IDENTITY_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}
