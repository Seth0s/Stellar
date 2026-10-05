/**
 * PLAN GATE — the shared renderer surface for the paid-feature states.
 *
 * `useCloudPlan` keeps the effective plan in sync with the account status;
 * `PlanNotice` renders the upgrade call-to-action or the read-only expiry band;
 * `PlanBadge` marks a paid option. The decisions themselves live in
 * `PlanAccess.ts`; the copy lives in the i18n catalogs.
 */

import { getLocale, t } from "../../shared/i18n";
import type { PlanLock } from "./PlanAccess";
import styles from "./PlanGate.module.css";

function planName(plan: string): string {
  return plan === "team" ? t("plan.name.team") : t("plan.name.pro");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  return new Date(at).toLocaleDateString(getLocale());
}

export function PlanBadge({ plan }: { plan: "pro" | "team" }) {
  return <span className={styles.badge}>{planName(plan)}</span>;
}

/** The upgrade call-to-action or the read-only expiry band. */
export function PlanNotice({ access, plansUrl }: { access: PlanLock; plansUrl: string }) {
  if (access.kind === "expired") {
    return (
      <div className={styles.notice} data-kind="expired" role="status">
        <span className={styles.noticeIcon} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v3.2l2 1.3" />
          </svg>
        </span>
        <div className={styles.noticeText}>
          <span className={styles.noticeTitle}>{t("plan.expired.title")}</span>
          <p className={styles.noticeBody}>
            {t("plan.expired.body", { date: formatDate(access.expiresAt), until: formatDate(access.readOnlyUntil) })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.notice} data-kind="upgrade" data-feature={access.feature} role="status">
      <div className={styles.noticeHead}>
        <PlanBadge plan={access.requiredPlan} />
        <span className={styles.noticeTitle}>{t("plan.upgrade.title", { plan: planName(access.requiredPlan) })}</span>
      </div>
      <p className={styles.noticeBody}>
        {access.feature === "sync" ? t("plan.upgrade.sync") : t("plan.upgrade.team")}
      </p>
      <a className={styles.cta} href={plansUrl} target="_blank" rel="noreferrer">
        {t("plan.upgrade.cta")}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M4 7h6M7.5 3.5L11 7l-3.5 3.5" />
        </svg>
      </a>
    </div>
  );
}

/** "O time usa todos os N assentos" — the seats refusal on an invite. */
export function PlanSeatsNotice({ seats }: { seats: number | null }) {
  return (
    <div className={styles.seats} data-part="plan-seats" role="alert">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <circle cx="5.8" cy="5.6" r="2.3" />
        <circle cx="11" cy="6.3" r="1.8" />
        <path d="M1.8 13c.4-2.3 2-3.6 4-3.6s3.6 1.3 4 3.6M10 9.6c1.9 0 3.4 1.1 3.9 3.4" />
      </svg>
      <span>{t("plan.seats.exceeded", { n: seats ?? 0 })}</span>
    </div>
  );
}
