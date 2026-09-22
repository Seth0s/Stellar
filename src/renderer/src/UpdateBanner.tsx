import { useState } from "react";
import { t, type MessageKey } from "../../shared/i18n";
import { deriveVersionJump } from "./update-jump";
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
  const { version, releaseNotes, dismissed, dismiss, install, releaseUrl, currentVersion } = useUpdateStatus();
  // O SELO DO SALTO (task 5fb0c21b): patch/minor/major, derivado puro
  // (`update-jump.ts`). Sem as duas versões comparáveis não há selo — ausência
  // nunca vira "patch" por omissão.
  const jump = version && currentVersion ? deriveVersionJump(currentVersion, version) : null;
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);

  if (!version || dismissed) return null;

  return (
    <div className="update-banner">
      <div className="update-banner-row">
        <span>{t("update.available", { version })}</span>
        {jump && <span className={`update-banner-jump update-banner-jump--${jump}`}>{t(`update.jump.${jump}` as MessageKey)}</span>}
        {releaseNotes && (
          <button className="update-banner-notes-toggle" onClick={() => setShowNotes((v) => !v)}>
            {showNotes ? t("update.hideNotes") : t("update.showNotes")}
          </button>
        )}
        {install && !install.canInstall ? (
          // A VERDADE NO LUGAR DO BOTÃO (task 5fb0c21b, item 2): nesta
          // instalação a atualização automática não acontece, e o motivo vem
          // medido do main (`decideUpdateInstall`). Oferecer "instalar e
          // reiniciar" aqui seria um botão que baixa e falha no meio.
          <span className="update-banner-manual">
            <span className="update-banner-manual-why">{install.message ?? t("update.installManual")}</span>
            {releaseUrl && (
              <a className="update-banner-manual-link" href={releaseUrl} target="_blank" rel="noreferrer">
                {t("update.downloadManual")}
              </a>
            )}
          </span>
        ) : (
          <button
            disabled={installing}
            onClick={() => {
              setInstalling(true);
              setError(null);
              window.updater.install().then((result) => {
                if (!result.ok) {
                  setInstalling(false);
                  setError(result.error ?? t("update.installFail"));
                }
                // On success the app quits+relaunches on its own
                // (autoUpdater.quitAndInstall) — nothing left to do here.
              });
            }}
          >
            {installing ? t("update.installing") : t("update.installRestart")}
          </button>
        )}
        <button className="update-banner-later" disabled={installing} onClick={dismiss} title={t("update.laterTitle")}>
          {t("update.remindLater")}
        </button>
      </div>
      {error && <span className="update-banner-error">{error}</span>}
      {showNotes && releaseNotes && <pre className="update-banner-notes">{releaseNotes}</pre>}
    </div>
  );
}
