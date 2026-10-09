/**
 * Pure decisions for dropping files/media onto a terminal card vs the
 * empty canvas. The canvas path creates a MediaCard; the terminal path
 * types absolute shell-quoted paths into the live PTY (no Enter) — same
 * convention as native terminals and as image-paste in useTerminal.
 */

/** Custom MIME for in-app drags (FilesCard / MediaCard) carrying absolute paths. */
export const STELLAR_PATHS_MIME = "application/x-stellar-paths";

/** C0 controls + DEL — a newline/CR in a path would submit a TUI prompt or
 * execute a second line when typed into a PTY. Built with a loop (not a
 * control-char regex literal) so eslint's no-control-regex stays quiet. */
export function pathHasShellUnsafeControls(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Visible escape for a refused path in the card warning (not for the shell). */
export function escapePathForWarning(path: string): string {
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code === 0x09) out += "\\t";
    else if (code <= 0x1f || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += path[i];
  }
  return out;
}

/**
 * Quote one absolute path for a shell/CLI input box. Single-quoted so bash
 * does not expand `!` (history), `$`, backticks, or escapes — only `'` itself
 * is closed/reopened as `'\''`. Returns null when the path contains control
 * characters (caller must refuse, never type those bytes into the PTY).
 */
export function quoteShellArg(path: string): string | null {
  if (pathHasShellUnsafeControls(path)) return null;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export type FormatDropPathsResult = {
  /** Shell-ready fragment ending in a trailing space, or "" if nothing safe. */
  typed: string;
  /** Display-escaped paths that were refused (control chars). */
  refused: string[];
};

/**
 * Join several absolute paths the way a native terminal drop does:
 * single-quoted, space-separated, trailing space so the user can keep typing.
 * No `\r` — the drop must not submit. Paths with control characters are
 * omitted from `typed` and listed (escaped) in `refused`.
 */
export function formatPathsForTerminalInput(paths: string[]): FormatDropPathsResult {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const path of paths) {
    const quoted = quoteShellArg(path);
    if (quoted === null) {
      refused.push(escapePathForWarning(path));
      continue;
    }
    accepted.push(quoted);
  }
  return {
    typed: accepted.length === 0 ? "" : `${accepted.join(" ")} `,
    refused,
  };
}

/** Join a project root with a FilesCard-relative path into an absolute path. */
export function joinProjectPath(root: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath;
  const base = root.replace(/\/+$/, "");
  const rel = relativePath.replace(/^\/+/, "");
  return rel ? `${base}/${rel}` : base;
}

export type DropSurface =
  | { kind: "canvas" }
  | { kind: "terminal"; live: boolean }
  | { kind: "other-card" };

/**
 * Where a file/media drop should land, given the surface under the cursor.
 * A dead (exited) terminal owns the gesture so the canvas does not create
 * a MediaCard, but writes nothing.
 */
export function decideFileDropDestination(surface: DropSurface): "terminal" | "canvas" | "ignore" {
  if (surface.kind === "terminal") return surface.live ? "terminal" : "ignore";
  if (surface.kind === "canvas") return "canvas";
  return "ignore";
}

/** Drag-over highlight only when the card can actually receive the drop. */
export function decideTerminalDropHighlight(opts: {
  live: boolean;
  hasFilePayload: boolean;
}): boolean {
  return opts.live && opts.hasFilePayload;
}

export function hasDropFilePayload(types: ArrayLike<string>): boolean {
  const list = Array.from(types);
  return list.includes("Files") || list.includes(STELLAR_PATHS_MIME);
}

/** Parse the in-app MIME; invalid JSON or non-string entries → []. */
export function parseStellarPathsPayload(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

/** Attrs form — unit-tested without a DOM. */
export function classifyDropSurfaceFromAttrs(
  kind: string | null | undefined,
  cardId: string,
  liveTerminalIds: ReadonlySet<string>,
): DropSurface {
  if (!kind) return { kind: "canvas" };
  if (kind === "terminal") {
    return { kind: "terminal", live: cardId !== "" && liveTerminalIds.has(cardId) };
  }
  return { kind: "other-card" };
}

/**
 * Classify a DOM node under the cursor into a drop surface. `liveTerminalIds`
 * are terminal card ids whose PTY is still running.
 */
export function classifyDropSurface(
  el: Element | null,
  liveTerminalIds: ReadonlySet<string>,
): DropSurface {
  const card = el?.closest?.("[data-kind]") as HTMLElement | null;
  if (!card) return { kind: "canvas" };
  const kind = card.getAttribute("data-kind");
  const id =
    card.getAttribute("data-card-id") ||
    card.querySelector("[data-card-id]")?.getAttribute("data-card-id") ||
    "";
  return classifyDropSurfaceFromAttrs(kind, id, liveTerminalIds);
}
