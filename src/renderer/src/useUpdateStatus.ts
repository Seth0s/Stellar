import { useSyncExternalStore } from "react";

export type UpdateStatus = {
  version: string | null;
  releaseNotes: string | null;
  /** "lembrar depois" clicked — `UpdateBanner` hides, but the pending
   * update itself isn't forgotten: `Titlebar`'s dot stays visible the
   * whole time (this flag never touches `version`), and the banner comes
   * back on its own after `REMIND_LATER_MS`, or right away if the dot is
   * clicked. */
  dismissed: boolean;
};

const REMIND_LATER_MS = 4 * 60 * 60 * 1000;

let status: UpdateStatus = { version: null, releaseNotes: null, dismissed: false };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function setStatus(patch: Partial<UpdateStatus>) {
  status = { ...status, ...patch };
  emit();
}

// Module-level, same pattern as `useToast.ts` — `Titlebar` (the pending-
// update dot) and `UpdateBanner` (the pill itself) both need the same
// version/dismissed state without prop-drilling it through `App.tsx`,
// which doesn't otherwise know or care about updater state at all.
// `window.updater.check()` fires once per app lifetime (`initialized`
// guard), not once per component mount — two consumers of this hook
// must not double-check or double-register the IPC listener.
let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  void window.updater.check();
  window.updater.onAvailable((version, releaseNotes) => {
    setStatus({ version, releaseNotes, dismissed: false });
  });
}

export function useUpdateStatus(): UpdateStatus & { dismiss: () => void; undismiss: () => void } {
  ensureInitialized();
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
  );
  return {
    ...s,
    dismiss: () => {
      setStatus({ dismissed: true });
      setTimeout(() => setStatus({ dismissed: false }), REMIND_LATER_MS);
    },
    undismiss: () => setStatus({ dismissed: false }),
  };
}
