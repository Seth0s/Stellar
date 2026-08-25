// Ported from CentralByte's src/hooks/useOcclusion.ts (global scope only —
// agent-canvas has no per-card anchored popover yet, so the per-session
// variant isn't needed here). A native WebContentsView paints above every
// DOM element regardless of z-index, so a full-screen modal (BrowserAskModal)
// would otherwise be hidden behind an open browser card. Any such modal calls
// useOccludesChrome() once in its own body; BrowserCard reads
// useChromeOccluded() and hides its view while true.

import { useEffect, useSyncExternalStore } from "react";

const occluders = new Set<symbol>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function anyOpen() {
  return occluders.size > 0;
}

/** Call in a full-screen modal's body — occludes every browser card for as long as it stays mounted. */
export function useOccludesChrome(active = true): void {
  useEffect(() => {
    if (!active) return;
    const id = Symbol();
    occluders.add(id);
    notify();
    return () => {
      occluders.delete(id);
      notify();
    };
  }, [active]);
}

/** True while at least one full-screen modal calling useOccludesChrome() is mounted. */
export function useChromeOccluded(): boolean {
  return useSyncExternalStore(subscribe, anyOpen);
}
