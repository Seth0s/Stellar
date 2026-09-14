/**
 * Build identity — make "which code is this process running?" readable.
 *
 * Measured pain (2026-09-14): the installed asar lagged the repo
 * (`deriveTaskStatus` absent from `/opt/Stellar/resources/app.asar`) and
 * nothing in the app could say so. Orchestrators deduced "needs rebuild"
 * instead of measuring. `acbridge version` already stamps the bus↔CLI
 * protocol; this module is the app-side counterpart for the *binary*.
 *
 * Decision (same day):
 * - Source: commit + ISO build time injected at `electron-vite` compile
 *   via `define` (`electron.vite.config.ts`). Cost differs from acbridge:
 *   `resources/bin/acbridge` is copied verbatim by `extraResources` (no
 *   compile step → injecting there needs `beforePack`, already rejected).
 *   The asar's main bundle already goes through Vite — one `define` is
 *   free. No obsolescence detector, no git compare from inside the app.
 * - Dev: probe git at runtime. Never claim a frozen build stamp. Dirty
 *   tree is reported honestly ("dev, dirty tree").
 * - Protocol mismatch: handshake already decides (acbridge-protocol-
 *   decision.ts). Identity only *exposes* `busProtocol` so both
 *   consumers can see what the handshake already knows — no toast.
 *
 * Depends on single-instance lock always-on (0a24e028): shared userData
 * stays shared, but only one Electron process binds the socket — so
 * "which build" is the identity of that one process, not ambiguous.
 */

import { execFileSync } from "node:child_process";

/** Stamps frozen into the main bundle by electron-vite `define`. Empty
 * string when the module is loaded outside a Vite build (unit tests). */
declare const __STELLAR_BUILD_COMMIT__: string | undefined;
declare const __STELLAR_BUILD_TIME__: string | undefined;

function injectedCommit(): string | null {
  try {
    const v = typeof __STELLAR_BUILD_COMMIT__ !== "undefined" ? __STELLAR_BUILD_COMMIT__ : "";
    return v && v !== "unknown" ? v : null;
  } catch {
    return null;
  }
}

function injectedBuiltAt(): string | null {
  try {
    const v = typeof __STELLAR_BUILD_TIME__ !== "undefined" ? __STELLAR_BUILD_TIME__ : "";
    return v && v !== "unknown" ? v : null;
  } catch {
    return null;
  }
}

export type BuildIdentity = {
  /** `dev` = electron-vite / unpackaged; `packaged` = installed binary. */
  mode: "dev" | "packaged";
  /** `package.json` version (`app.getVersion()`). */
  version: string;
  /** Short commit when known; null if unavailable. */
  commit: string | null;
  /** ISO-8601 build time for packaged stamps; null in dev. */
  builtAt: string | null;
  /** True only in dev when `git status --porcelain` is non-empty. */
  dirty: boolean;
  /** Bus protocol integer — same literal as `ACBRIDGE_PROTOCOL`. */
  busProtocol: number;
  /** One-line human/agent summary; never lies about cleanliness. */
  label: string;
};

export type BuildIdentityInput = {
  isPackaged: boolean;
  version: string;
  busProtocol: number;
  /** Working tree to probe in dev. Ignored when packaged. */
  gitCwd?: string;
  /** Test seam — skip real git. */
  gitProbe?: () => { commit: string | null; dirty: boolean };
  /** Test seam — override injected stamps. */
  stamps?: { commit: string | null; builtAt: string | null };
};

function probeGit(cwd: string): { commit: string | null; dirty: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { commit: commit || null, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: false };
  }
}

/** Pure resolve — no Electron import, unit-testable. */
export function resolveBuildIdentity(input: BuildIdentityInput): BuildIdentity {
  const { isPackaged, version, busProtocol } = input;

  if (!isPackaged) {
    const git = input.gitProbe
      ? input.gitProbe()
      : input.gitCwd
        ? probeGit(input.gitCwd)
        : { commit: null, dirty: false };
    const dirty = git.dirty;
    const commit = git.commit;
    const label = dirty
      ? `dev ${commit ?? "?"} (dirty tree)`
      : `dev ${commit ?? "?"}`;
    return {
      mode: "dev",
      version,
      commit,
      builtAt: null,
      dirty,
      busProtocol,
      label,
    };
  }

  const stamps = input.stamps ?? {
    commit: injectedCommit(),
    builtAt: injectedBuiltAt(),
  };
  const commit = stamps.commit;
  const builtAt = stamps.builtAt;
  const label =
    commit && builtAt
      ? `packaged ${commit} @ ${builtAt}`
      : commit
        ? `packaged ${commit}`
        : `packaged v${version} (no build stamp)`;
  return {
    mode: "packaged",
    version,
    commit,
    builtAt,
    dirty: false,
    busProtocol,
    label,
  };
}
