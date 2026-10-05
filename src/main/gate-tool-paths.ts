/**
 * BOARD-DECLARED TOOL PATHS FOR GATES — read-only binds for a shared tool that
 * lives outside the task's repository.
 *
 * A gate runs inside the same bubblewrap sandbox as the chat `bash` tool: the
 * host filesystem is readable, but every path under `$HOME` that the project
 * root does not re-bind is occluded by an empty tmpfs. A board-level tool (a
 * lint script shared by the repositories of one workspace) therefore vanishes
 * from the gate and the gate fails as if the tool did not exist.
 *
 * The board declares the extra directories; they enter the sandbox as
 * READ-ONLY binds, never read-write. Validation is pure and separate from the
 * mounting: a declaration that is relative, absent, or a broad slice of
 * `$HOME` is refused with a reason instead of being mounted, and only specific
 * directories are accepted.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/** Why a declared path was refused — the reason the board author has to fix. */
export type GateToolPathReason =
  | "empty"
  | "relative"
  | "not-found"
  | "not-a-directory"
  | "home-root"
  | "sensitive-home";

export type GateToolPathRefusal = {
  /** The declared path as it reached the validator (absolute form when it was
   * resolvable). */
  path: string;
  reason: GateToolPathReason;
  /** The message a human acts on — it names the path and what to declare
   * instead. */
  message: string;
};

export type GateToolPathValidation = {
  /** Absolute paths that may be mounted, in declaration order, deduplicated. */
  accepted: string[];
  rejected: GateToolPathRefusal[];
};

/**
 * Directories under `$HOME` whose contents are secrets or credentials. A tool
 * bind must never re-expose them even read-only, because a read is already
 * enough to leak a key.
 */
const SENSITIVE_HOME_DIRS = [".ssh", ".config", ".gnupg", ".aws", ".kube"] as const;

export type GateToolPathProbes = {
  home: string;
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
};

/** `child` is `parent` itself or lives under it. */
function isWithin(child: string, parent: string): boolean {
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(base);
}

function refusal(path: string, reason: GateToolPathReason, message: string): GateToolPathRefusal {
  return { path, reason, message };
}

/**
 * Validates ONE declared path. Absolute path in, absolute path out; anything
 * that is not a concrete existing directory, or that would re-expose a broad
 * slice of `$HOME`, is refused with a message the board author can act on.
 */
export function validateGateToolPath(
  raw: unknown,
  probes: GateToolPathProbes,
): { accepted: string | null; refusal: GateToolPathRefusal | null } {
  const declared = typeof raw === "string" ? raw.trim() : "";
  if (typeof raw !== "string" || declared === "") {
    return { accepted: null, refusal: refusal(declared, "empty", "gate tool path is empty or not a string") };
  }
  if (!isAbsolute(declared)) {
    return {
      accepted: null,
      refusal: refusal(declared, "relative", `gate tool path must be absolute (received "${declared}")`),
    };
  }
  const abs = resolve(declared);
  const home = resolve(probes.home);
  // The home directory itself, or any ancestor of it (`/`, `/home`): mounting
  // it would re-expose the whole tree read-only, which is the broad case this
  // rule exists to refuse.
  if (isWithin(home, abs)) {
    return {
      accepted: null,
      refusal: refusal(
        abs,
        "home-root",
        `gate tool path ${abs} would re-expose the whole home directory; declare a specific tool directory instead`,
      ),
    };
  }
  for (const dir of SENSITIVE_HOME_DIRS) {
    const sensitive = resolve(home, dir);
    if (isWithin(abs, sensitive)) {
      return {
        accepted: null,
        refusal: refusal(
          abs,
          "sensitive-home",
          `gate tool path ${abs} is inside ${sensitive}, which holds secrets; declare a specific tool directory instead`,
        ),
      };
    }
  }
  if (!probes.exists(abs)) {
    return { accepted: null, refusal: refusal(abs, "not-found", `gate tool path ${abs} does not exist`) };
  }
  if (!probes.isDirectory(abs)) {
    return { accepted: null, refusal: refusal(abs, "not-a-directory", `gate tool path ${abs} is not a directory`) };
  }
  return { accepted: abs, refusal: null };
}

/** Validates the whole declaration list, preserving order and dropping
 * duplicates. Never throws: a malformed entry becomes a refusal. */
export function validateGateToolPaths(
  raw: readonly unknown[] | null | undefined,
  probes: GateToolPathProbes,
): GateToolPathValidation {
  const accepted: string[] = [];
  const rejected: GateToolPathRefusal[] = [];
  if (!Array.isArray(raw)) return { accepted, rejected };
  for (const item of raw) {
    const result = validateGateToolPath(item, probes);
    if (result.accepted !== null) {
      if (!accepted.includes(result.accepted)) accepted.push(result.accepted);
    } else if (result.refusal !== null) {
      rejected.push(result.refusal);
    }
  }
  return { accepted, rejected };
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Production probes over the real filesystem and the real home directory. */
export function systemGateToolPathProbes(): GateToolPathProbes {
  return {
    home: homedir(),
    exists: (path) => safeStat(path) !== null,
    isDirectory: (path) => safeStat(path)?.isDirectory() ?? false,
  };
}
