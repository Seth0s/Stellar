import { t } from "../../shared/i18n";
import { saveStateTone, type SaveState } from "./account-session-decision";
import { usePlansUrl } from "./PlanHooks";
import styles from "./AccountSession.module.css";

/** The state beside the save button: not saved, saved at a revision, changed elsewhere, offline. */
export function AccountSessionPill({ state }: { state: SaveState }) {
  const text =
    state.kind === "saved"
      ? t("accountSession.pill.saved", { n: state.revision })
      : state.kind === "conflict"
        ? t("accountSession.pill.conflict")
        : state.kind === "offline"
          ? t("accountSession.pill.offline")
          : t("accountSession.pill.unsaved");
  return (
    <span className={styles.pill} data-tone={saveStateTone(state)} data-role="account-session-pill" data-state={state.kind} role="status">
      {text}
    </span>
  );
}

/** What a profile without the right plan sees: what the account would keep, and the way out. */
export function AccountSessionPlan({ expired, onLocal }: { expired?: boolean; onLocal?: () => void }) {
  const plansUrl = usePlansUrl();
  return (
    <div className={styles.plan} data-role="account-session-plan">
      <span className={styles.planIcon} aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M4.6 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 12 6.6a2.95 2.95 0 0 1-.2 5.9z" />
          <path d="M8 6.5v4.5M6.2 8.3L8 6.5l1.8 1.8" />
        </svg>
      </span>
      <h3 className={styles.planTitle}>{t("accountSession.plan.title")}</h3>
      <p className={styles.planText}>{expired ? t("accountSession.plan.expired") : t("accountSession.plan.text")}</p>
      <div className={styles.planBox}>
        <div className={styles.bulletsHead}>{t("accountSession.plan.goes")}</div>
        <ul className={styles.bullets} data-tone="goes">
          <li>{t("accountSession.plan.goes1")}</li>
          <li>{t("accountSession.plan.goes2")}</li>
        </ul>
        <div className={styles.bulletsHead}>{t("accountSession.plan.stays")}</div>
        <ul className={styles.bullets}>
          <li>{t("accountSession.plan.stays1")}</li>
          <li>{t("accountSession.plan.stays2")}</li>
        </ul>
      </div>
      <div className={styles.planActions}>
        <a className={styles.planLink} href={plansUrl} target="_blank" rel="noreferrer" data-role="account-session-plans">
          {t("accountSession.plan.see")}
        </a>
        {onLocal ? (
          <button type="button" className={styles.ghost} data-role="account-session-plan-local" onClick={onLocal}>
            {t("accountSession.plan.local")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The offline panel: nothing was sent, nothing was lost. */
export function AccountSessionOffline({ detail, onRetry, busy }: { detail: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <div className={styles.notice} data-tone="warn" data-role="account-session-offline" role="alert">
      <span className={styles.noticeTitle}>{t("accountSession.offline.title")}</span>
      <span>{detail}</span>
      {onRetry ? (
        <div className={styles.noticeActions}>
          <button type="button" className={styles.ghost} onClick={onRetry} disabled={busy}>
            {t("accountSession.offline.retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
