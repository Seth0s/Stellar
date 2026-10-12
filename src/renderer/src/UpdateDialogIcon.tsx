import { t } from "../../shared/i18n";
import { useUpdateStatus } from "./useUpdateStatus";
import styles from "./UpdateDialog.module.css";

/**
 * The update's presence in the title bar. It stays while an update exists in
 * any state — the dialog can be closed ("Agora não", "Continuar em segundo
 * plano", "Reiniciar depois") without the update being forgotten — and a click
 * reopens the dialog on whatever step it is in:
 *
 *   available / manual  a dot
 *   downloading         a ring that fills with the real percentage
 *   ready               a check ("pronta, reinicie quando quiser")
 *   error               a warning triangle
 *   installing          a spinner
 */
const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function UpdateTitlebarIcon() {
  const u = useUpdateStatus();
  const { phase, version, progress } = u.snapshot;
  if (phase === "idle" || version === null) return null;

  const pct = progress ? Math.min(100, Math.floor(progress.percent)) : 0;
  const label =
    phase === "downloading"
      ? t("update.icon.downloading", { percent: String(pct) })
      : phase === "ready"
        ? t("update.icon.ready", { version })
        : phase === "error"
          ? t("update.icon.error")
          : phase === "installing"
            ? t("update.icon.installing")
            : t("update.icon.available", { version });

  return (
    <button
      type="button"
      className="titlebar-update-dot"
      data-role="update-icon"
      data-phase={phase}
      title={label}
      aria-label={label}
      onClick={u.openDialog}
    >
      {phase === "downloading" && (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={RING_RADIUS} fill="none" className={styles.ringTrack} strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            className={styles.ringFill}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - pct / 100)}
            transform="rotate(-90 8 8)"
          />
        </svg>
      )}
      {phase === "ready" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={styles.iconOk} aria-hidden="true">
          <path d="M3.4 8.4l3 3 6-6.4" stroke="currentColor" />
        </svg>
      )}
      {phase === "error" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={styles.iconError} aria-hidden="true">
          <path d="M8 2.3l6.2 11H1.8zM8 6.8v3M8 11.8v.2" stroke="currentColor" />
        </svg>
      )}
      {phase === "installing" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" strokeWidth="2" strokeLinecap="round" className={`${styles.iconSpin} ${styles.ringFill}`} aria-hidden="true">
          <path d="M8 2a6 6 0 1 0 6 6" stroke="currentColor" />
        </svg>
      )}
      {(phase === "available" || phase === "manual") && <span className="titlebar-update-dot-mark" />}
    </button>
  );
}
