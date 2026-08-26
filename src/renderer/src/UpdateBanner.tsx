import { useState } from "react";
import { useUpdateStatus } from "./useUpdateStatus";

/**
 * DESIGN-BACKLOG.md item 13 — in-app updater UI, same product contract as
 * CentralByte's `StatusBar` update pill: invisible until an update is
 * actually found (`window.updater.check()` at boot is silent either way —
 * see main/updater.ts), then a small persistent affordance instead of a
 * toast (a real update shouldn't auto-dismiss after 2.4s).
 *
 * Extended (item 17 — "lembrar depois"/changelog/pending-icon, pedido do
 * usuário antes da 1ª tag): "lembrar depois" doesn't forget the update —
 * it hides this banner and lets `Titlebar`'s dot keep the affordance
 * alive (shared state in `useUpdateStatus.ts`), reappearing on its own
 * later or immediately if that dot is clicked. Release notes (when the
 * update feed actually sends one) are collapsed behind a toggle so the
 * banner itself stays a single compact line by default.
 */
export function UpdateBanner() {
  const { version, releaseNotes, dismissed, dismiss } = useUpdateStatus();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);

  if (!version || dismissed) return null;

  return (
    <div className="update-banner">
      <div className="update-banner-row">
        <span>Atualização v{version} disponível</span>
        {releaseNotes && (
          <button className="update-banner-notes-toggle" onClick={() => setShowNotes((v) => !v)}>
            {showNotes ? "ocultar novidades" : "ver novidades"}
          </button>
        )}
        <button
          disabled={installing}
          onClick={() => {
            setInstalling(true);
            setError(null);
            window.updater.install().then((result) => {
              if (!result.ok) {
                setInstalling(false);
                setError(result.error ?? "falha ao instalar");
              }
              // On success the app quits+relaunches on its own
              // (autoUpdater.quitAndInstall) — nothing left to do here.
            });
          }}
        >
          {installing ? "instalando…" : "instalar e reiniciar"}
        </button>
        <button className="update-banner-later" disabled={installing} onClick={dismiss} title="Some por algumas horas — o ícone na barra de título continua avisando">
          lembrar depois
        </button>
      </div>
      {error && <span className="update-banner-error">{error}</span>}
      {showNotes && releaseNotes && <pre className="update-banner-notes">{releaseNotes}</pre>}
    </div>
  );
}
