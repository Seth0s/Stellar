/**
 * DESIGN-BACKLOG.md §2.0 item 5 — whether `openBrowserFor` should navigate
 * an existing browser card owned by the caller, or always create a new one.
 *
 * Defaults:
 * - Human (`ownerCardId === null`): never reuse. Every null-owner used to
 *   share one card, so a chip click "opened" nothing visible.
 * - Agent (non-null owner): reuse unless the caller passes `reuse: false`.
 *   Keeps `open_url` from cluttering the board on every navigation while
 *   still letting the caller opt into a second window.
 */
export function decideBrowserReuse(ownerCardId: string | null, reuse?: boolean): boolean {
  if (ownerCardId === null) return false;
  return reuse !== false;
}
