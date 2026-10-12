/**
 * The prototype cards the owner dismissed, shared by everything that counts
 * needs-you count (the strip, the chip, the card footer). It is a tiny
 * external store over the localStorage keys in `task-fila-v3-decision.ts`, so a
 * dismissal made in the Fila is seen by the footer in the same instant.
 */
import { useSyncExternalStore } from "react";
import { loadDismissedPrototypes, saveDismissedPrototypes } from "./task-fila-v3-decision";

const cache = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

/** The dismissed keys of a board. The same Set instance until something changes. */
export function getDismissedPrototypes(boardId: string): Set<string> {
  let set = cache.get(boardId);
  if (!set) {
    set = loadDismissedPrototypes(boardId);
    cache.set(boardId, set);
  }
  return set;
}

/** Mark (or unmark) one dismissal key and tell every subscriber. */
export function setPrototypeDismissedKey(boardId: string, key: string, dismissed: boolean): void {
  const next = new Set(getDismissedPrototypes(boardId));
  if (dismissed) next.add(key);
  else next.delete(key);
  cache.set(boardId, next);
  saveDismissedPrototypes(boardId, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDismissedPrototypes(boardId: string): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => getDismissedPrototypes(boardId),
    () => getDismissedPrototypes(boardId),
  );
}

/** Test seam: forget the in-memory copy so the next read goes to storage. */
export function resetDismissedPrototypesCache(): void {
  cache.clear();
}
