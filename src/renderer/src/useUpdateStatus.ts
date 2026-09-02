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
  /** True while a check (boot or manual) is in flight. */
  checking: boolean;
  /** Achado ao vivo (2026-09-02): checagens que falham (rede,
   * rate-limit da API do GitHub sem token, etc.) não tinham NENHUMA
   * superfície pro usuário -- só um console.warn no processo main,
   * invisível em quem roda o pacote instalado. Null = sem erro (ou
   * nunca checou). */
  checkError: string | null;
};

const REMIND_LATER_MS = 4 * 60 * 60 * 1000;

let status: UpdateStatus = { version: null, releaseNotes: null, dismissed: false, checking: false, checkError: null };
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
// The boot check fires once per app lifetime (`initialized` guard), not
// once per component mount — two consumers of this hook must not
// double-check or double-register the IPC listener. `checkNow()` is a
// separate, repeatable manual re-check that bypasses this guard.
let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  void runCheck();
  window.updater.onAvailable((version, releaseNotes) => {
    setStatus({ version, releaseNotes, dismissed: false, checkError: null });
  });
}

async function runCheck() {
  setStatus({ checking: true, checkError: null });
  const result = await window.updater.check();
  setStatus({ checking: false, checkError: result.error ?? null });
}

export function useUpdateStatus(): UpdateStatus & { dismiss: () => void; undismiss: () => void; checkNow: () => void } {
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
    checkNow: () => {
      if (status.checking) return;
      void runCheck();
    },
  };
}
