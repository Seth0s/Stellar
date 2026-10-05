/**
 * Pure decision for persisting a browser card's CURRENT URL.
 *
 * The card's address bar holds the live URL, updated on every navigation —
 * including in-page `pushState` routes. That value is written back to the card
 * (debounced) so a background unload/reload reattaches to where the user was,
 * not to the creation URL. This module only answers "should this navigation be
 * committed?" — the timer lives in the component, the write in App.
 */

/** Quiet period after the last navigation before the URL is written back. */
export const URL_PERSIST_DEBOUNCE_MS = 600;

/**
 * True when the URL is a real, non-empty value that differs from the last one
 * committed. The initial value (the card's creation URL) is never a change, so
 * it is never committed on mount.
 */
export function decideBrowserUrlCommit(input: { url: string; lastCommitted: string | null }): boolean {
  return input.url.trim().length > 0 && input.url !== input.lastCommitted;
}
