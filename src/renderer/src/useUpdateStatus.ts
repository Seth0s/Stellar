import { useSyncExternalStore } from "react";

export type UpdateStatus = {
  version: string | null;
  /** O corpo da release SEM a seção de commits (o main já separou). */
  changelog: string;
  /** Os commits que o `release.yml` escreveu no corpo da release. Vazio = a
   *  release não trouxe a seção (o dropdown não aparece). */
  commits: string[];
  /** A versão que o usuário adiou, lida do disco pelo main no boot. */
  remindLaterVersion: string | null;
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

const REMIND_LATER_MS = 4 * 60 * 60 * 1000;

let status: UpdateStatus = {
  version: null,
  changelog: "",
  commits: [],
  remindLaterVersion: null,
  dismissed: false,
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
  window.updater.onAvailable((version, changelog, commits) => {
    // ADIADO PERSISTIDO (task 5fb0c21b, item 5): se é a MESMA versão que o
    // usuário adiou, o banner nasce escondido — o `Titlebar`'s dot continua
    // mostrando que há atualização. Uma versão MAIS NOVA é string diferente e
    // avisa de novo, por construção.
    setStatus({
      version,
      changelog,
      commits,
      dismissed: status.remindLaterVersion === version,
      checkError: null,
    });
  });
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
}

export function useUpdateStatus(): UpdateStatus & {
  dismiss: () => void;
  undismiss: () => void;
  checkNow: () => void;
} {
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
      // PERSISTE por versão (task 5fb0c21b, item 5): um restart não des-esconde
      // a MESMA versão. `null`/ausente não grava nada.
      if (status.version) {
        setStatus({ remindLaterVersion: status.version });
        void window.updater.remindLater(status.version);
      }
      // E o voltar-em-4h continua: em MEMÓRIA, para quem fica no app aberto.
      setTimeout(() => setStatus({ dismissed: false }), REMIND_LATER_MS);
    },
    undismiss: () => setStatus({ dismissed: false }),
    checkNow: () => {
      if (status.checking) return;
      void runCheck();
    },
  };
}
