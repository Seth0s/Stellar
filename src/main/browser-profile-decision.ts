/**
 * Browser card session profile — ephemeral (default, Push API blocked like
 * Chromium incognito) vs persistent (`persist:` partition per card).
 *
 * Partition names stay scoped to ONE card id. Never the app defaultSession
 * and never a shared owner profile — cookies/SW/Push for card A cannot
 * leak into card B or the main window.
 */

export type BrowserProfileKind = "ephemeral" | "persistent";

export type BrowserProfileDecision =
  | { action: "accept"; kind: BrowserProfileKind; partition: string }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeBrowserProfileRefuse(reason: string): string {
  return `browser profile refused: ${reason}`;
}

/**
 * Build the Electron `webPreferences.partition` string for a card.
 * Ephemeral = `stellar-browser-<id>` (dies with the process).
 * Persistent = `persist:stellar-browser-<id>` (survives reopen of the same id).
 */
export function decideBrowserPartition(
  cardId: string,
  persistent: boolean | null | undefined,
): BrowserProfileDecision {
  const id = typeof cardId === "string" ? cardId.trim() : "";
  if (!id) {
    return { action: "refuse", error: describeBrowserProfileRefuse("card id is required for a session partition") };
  }
  if (/[/\\:]/.test(id)) {
    return {
      action: "refuse",
      error: describeBrowserProfileRefuse(`card id must not contain path or partition separators (got ${JSON.stringify(id)})`),
    };
  }
  const kind: BrowserProfileKind = persistent === true ? "persistent" : "ephemeral";
  const base = `stellar-browser-${id}`;
  return {
    action: "accept",
    kind,
    partition: kind === "persistent" ? `persist:${base}` : base,
  };
}

export type DisplayMode = "browser" | "standalone";

export type DisplayModeDecision =
  | { action: "apply"; mode: DisplayMode }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeDisplayModeRefuse(reason: string): string {
  return `browser_set_display_mode refused: ${reason}`;
}

export function decideDisplayMode(input: { mode?: unknown }): DisplayModeDecision {
  if (input.mode === "browser" || input.mode === "standalone") {
    return { action: "apply", mode: input.mode };
  }
  return {
    action: "refuse",
    error: describeDisplayModeRefuse('mode must be "standalone" (PWA/iOS) or "browser" (reset)'),
  };
}
