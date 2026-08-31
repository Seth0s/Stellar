import { useCallback, useRef } from "react";

/**
 * Pre-release audit P1 — `React.memo` on a card component (TerminalCard,
 * BrowserCard, etc.) only skips re-rendering it when EVERY prop is
 * referentially stable across renders. App.tsx's card-rendering switch
 * used to pass a fresh inline closure per handler per card on every
 * single render (`onChange={(r) => tryChangeRect(c.id, r)}`) — memo's
 * shallow comparison sees that as "changed" every time regardless of
 * whether `tryChangeRect`'s actual behavior or `c` itself changed,
 * defeating memoization for every card kind universally, not just the
 * one actually being dragged/resized.
 *
 * These two hooks hand back the SAME function reference for the SAME
 * card across renders, keyed by the card object's own identity — this
 * codebase's `setCards` updaters already return the exact same object
 * reference for any card a given state update doesn't touch (`prev.map
 * ((c) => (c.id === id ? {...c, rect} : c))`), so a `WeakMap` keyed by
 * that object needs no manual cleanup: once a card is removed/replaced,
 * its old object becomes unreachable and the cached closure is garbage
 * collected right along with it — never an unbounded cache the way a
 * plain `Map<id, fn>` would be for a long session creating/closing many
 * cards (see DESIGN-BACKLOG.md item 63's B7 for the same class of risk
 * elsewhere in this codebase).
 *
 * The cached closure always calls through to the LATEST version of `fn`
 * via a ref updated on every render, so a "stale" cached wrapper (kept
 * around because ITS card hasn't changed, even though the App component
 * itself re-rendered for an unrelated reason) never runs outdated
 * logic — only the wrapper's own identity stays stable, never its
 * behavior. Safe as long as `fn` itself only reads current app state via
 * refs or a `setState` updater function (not a captured plain value) —
 * already this codebase's established idiom (`cardsRef`/`worldRef`/
 * `orderRef`, functional `setCards` updaters throughout App.tsx).
 */
export function useStableCardHandler<C extends { id: string }, Args extends unknown[]>(
  fn: (card: C, ...args: Args) => void,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cache = useRef(new WeakMap<C, (...args: Args) => void>()).current;
  return useCallback(
    (card: C) => {
      let cached = cache.get(card);
      if (!cached) {
        cached = (...args: Args) => fnRef.current(card, ...args);
        cache.set(card, cached);
      }
      return cached;
    },
    [cache],
  );
}

/** Same as `useStableCardHandler` above, for a handler shaped `(id,
 * ...args) => void` instead of `(card, ...args) => void` — most of
 * App.tsx's card handlers already take the id directly (`tryChangeRect`,
 * `raise`, `closeCard`, ...), only a few need the full card object. */
export function useStableCardIdHandler<C extends { id: string }, Args extends unknown[]>(
  fn: (id: string, ...args: Args) => void,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cache = useRef(new WeakMap<C, (...args: Args) => void>()).current;
  return useCallback(
    (card: C) => {
      let cached = cache.get(card);
      if (!cached) {
        cached = (...args: Args) => fnRef.current(card.id, ...args);
        cache.set(card, cached);
      }
      return cached;
    },
    [cache],
  );
}
