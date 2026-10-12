import { useSyncExternalStore } from "react";
import type { UpdaterSnapshot } from "../../main/update-state";

/** Same shape as main's idle snapshot; main is the source of truth and replaces it on boot. */
const IDLE_SNAPSHOT: UpdaterSnapshot = {
  phase: "idle",
  version: null,
  changelog: "",
  downloadBytes: null,
  progress: null,
  error: null,
  manual: null,
};

export type UpdateStatus = {
  /** The update's state as the main process holds it (phase, progress, error, …). */
  snapshot: UpdaterSnapshot;
  /** `snapshot.version`, kept as a flat field for the title-bar icon. */
  version: string | null;
  /** The update dialog is on screen. */
  dialogOpen: boolean;
  /** A versão que o usuário adiou, lida do disco pelo main no boot. */
  remindLaterVersion: string | null;
  /** True while a check (boot or manual) is in flight. */
  checking: boolean;
  /** Achado ao vivo (2026-09-02): checagens que falham (rede,
   * rate-limit da API do GitHub sem token, etc.) não tinham NENHUMA
   * superfície pro usuário -- só um console.warn no processo main,
   * invisível em quem roda o pacote instalado. Null = sem erro (ou
   * nunca checou). */
  checkError: string | null;
  /** Atualização automática indisponível NESTA build (saída do GitHub,
   * 2026-09-15: sem feed enquanto a VPS de distribuição não existe).
   * Diferente de `checkError`: não é falha, é configuração — e precisa
   * aparecer, senão o app promete silenciosamente um update que nunca vem. */
  updatesUnavailable: string | null;
  /** Dá para INSTALAR nesta instalação? (task 5fb0c21b, item 2) — `canInstall:
   * false` com o motivo é o caso do dono (rpm sem `package-type`): a tela diz
   * "baixe a nova" em vez de oferecer um botão que falha. `null` = o main não
   * respondeu isso (versão antiga). */
  install: { canInstall: boolean; how?: string; needsElevation?: boolean; message?: string } | null;
  /** Página da release, derivada do MESMO `app-update.yml` que configura o
   *  feed — não um segundo literal de owner/repo no renderer. */
  releaseUrl: string | null;
  /** A versão RODANDO, para o selo do salto (patch/minor/major). */
  currentVersion: string | null;
};

let status: UpdateStatus = {
  snapshot: IDLE_SNAPSHOT,
  version: null,
  dialogOpen: false,
  remindLaterVersion: null,
  checking: false,
  checkError: null,
  updatesUnavailable: null,
  install: null,
  releaseUrl: null,
  currentVersion: null,
};
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function setStatus(patch: Partial<UpdateStatus>) {
  status = { ...status, ...patch };
  emit();
}

/** The version whose dialog already opened by itself this session — it opens once, not on every push. */
let autoOpenedFor: string | null = null;

function applySnapshot(snapshot: UpdaterSnapshot) {
  const patch: Partial<UpdateStatus> = { snapshot, version: snapshot.version };
  // An offered version opens the dialog once — unless the user already said
  // "not now" to exactly that version (persisted). A NEWER version is a
  // different string and asks again. Nothing else pops it open: a background
  // download finishing, or failing, only changes the title-bar icon.
  if ((snapshot.phase === "available" || snapshot.phase === "manual") && snapshot.version !== null) {
    if (autoOpenedFor !== snapshot.version && status.remindLaterVersion !== snapshot.version) {
      autoOpenedFor = snapshot.version;
      patch.dialogOpen = true;
    }
  }
  // Restarting is always shown: the user just asked for it.
  if (snapshot.phase === "installing") patch.dialogOpen = true;
  setStatus(patch);
}

// Module-level, same pattern as `useToast.ts` — `Titlebar` (the update icon)
// and `UpdateBanner` (the dialog host) both need the same state without
// prop-drilling it through `App.tsx`, which doesn't otherwise know or care
// about updater state at all. The boot check fires once per app lifetime
// (`initialized` guard), not once per component mount. `checkNow()` is a
// separate, repeatable manual re-check that bypasses this guard.
let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  // Test-only (verification scripts): the facts a dev build's check does not give,
  // so every dialog screen can be shown with fixed data.
  (window as unknown as { __stellarUpdateTest?: unknown }).__stellarUpdateTest = {
    setFacts: (facts: Partial<Pick<UpdateStatus, "currentVersion" | "releaseUrl" | "install">>) => setStatus(facts),
  };
  window.updater.onState(applySnapshot);
  void window.updater.getState().then(applySnapshot);
  void runCheck();
}

async function runCheck() {
  setStatus({ checking: true, checkError: null });
  const result = await window.updater.check();
  setStatus({
    checking: false,
    checkError: result.error ?? null,
    updatesUnavailable: result.unavailable ?? null,
    install: result.install ?? null,
    releaseUrl: result.releaseUrl ?? null,
    currentVersion: result.currentVersion ?? null,
    remindLaterVersion: result.remindLaterVersion ?? status.remindLaterVersion,
  });
  // The persisted "not now" arrives with the check; an offer that raced ahead
  // of it may have opened the dialog for a version already postponed.
  if (
    status.dialogOpen &&
    status.remindLaterVersion !== null &&
    status.remindLaterVersion === status.snapshot.version &&
    status.snapshot.phase === "available"
  ) {
    setStatus({ dialogOpen: false });
  }
}

export type UpdateActions = {
  openDialog: () => void;
  /** Close without remembering anything (the download, if any, goes on). */
  closeDialog: () => void;
  /** "Agora não": close and remember this version as postponed. */
  postpone: () => void;
  download: () => void;
  cancelDownload: () => void;
  /** "Reiniciar agora" — the only way the app closes to install. */
  restart: () => void;
  /** "Tentar de novo": repeats whichever step failed. */
  retry: () => void;
  checkNow: () => void;
};

const actions: UpdateActions = {
  openDialog: () => setStatus({ dialogOpen: true }),
  closeDialog: () => setStatus({ dialogOpen: false }),
  postpone: () => {
    setStatus({ dialogOpen: false });
    // PERSISTE por versão (task 5fb0c21b, item 5): um restart não reabre o
    // diálogo para a MESMA versão. O ícone na barra de título segue lembrando.
    const version = status.snapshot.version;
    if (version) {
      setStatus({ remindLaterVersion: version });
      void window.updater.remindLater(version);
    }
  },
  download: () => {
    void window.updater.download();
  },
  cancelDownload: () => {
    void window.updater.cancel();
  },
  restart: () => {
    void window.updater.install();
  },
  retry: () => {
    const error = status.snapshot.error;
    if (error?.stage === "install") void window.updater.install();
    else void window.updater.download();
  },
  checkNow: () => {
    if (status.checking) return;
    void runCheck();
  },
};

export function useUpdateStatus(): UpdateStatus & UpdateActions {
  ensureInitialized();
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
  );
  return { ...s, ...actions };
}
