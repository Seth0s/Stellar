import { useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import styles from "./InviteDialog.module.css";

const ACCEPT_REASON_KEYS: Record<string, MessageKey> = {
  "identity-mismatch": "team.accept.identity-mismatch",
  expired: "team.accept.expired",
  used: "team.accept.used",
  revoked: "team.accept.revoked",
  "not-found": "team.accept.not-found",
  "already-member": "team.accept.already-member",
  error: "team.accept.error",
};

/**
 * Team invite (tela 7). Opened by the `stellar://invite` link. The token
 * arrives by push and the main process holds it; accepting creates (or
 * reuses) the local team profile. The invite payload only carries the token,
 * so the team name is known after accepting — the dialog says so instead of
 * inventing one.
 */
export function InviteDialog({
  token,
  onClose,
  onAccepted,
}: {
  token: string;
  onClose: () => void;
  onAccepted: (teamName: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await window.team.acceptInvite(token);
      if (!res.ok) {
        setError(t(ACCEPT_REASON_KEYS[res.reason] ?? "team.accept.error"));
        setBusy(false);
        return;
      }
      onAccepted(res.value.team.name);
    } catch {
      setError(t("team.error.generic"));
      setBusy(false);
    }
  }

  return (
    <div className={styles.scrim} role="dialog" aria-labelledby="invite-title">
      <div className={styles.dialog}>
        <div className={styles.head}>
          <span className={styles.avatar}>T</span>
          <div className={styles.headText}>
            <div className={styles.inviter}>{t("invite.invited")}</div>
            <h1 id="invite-title" className={styles.teamName}>
              {t("invite.unknownTeam")}
            </h1>
          </div>
          <span className={styles.spacer} />
        </div>

        <div className={styles.benefits}>
          <div className={styles.benefit}>
            <svg className={styles.benefitIcon} width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="var(--v2-good)" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 7.2l2.6 2.6L11 4.4" />
            </svg>
            <span>{t("invite.benefit.identity")}</span>
          </div>
          <div className={styles.benefit}>
            <svg className={styles.benefitIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--v2-accent-soft)" strokeWidth="1.4" aria-hidden="true">
              <rect x="2" y="3" width="5" height="10" rx="1.2" />
              <rect x="9" y="3" width="5" height="10" rx="1.2" />
            </svg>
            <span>{t("invite.benefit.profile")}</span>
          </div>
          <div className={styles.benefit}>
            <svg className={styles.benefitIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--v2-accent-soft)" strokeWidth="1.4" aria-hidden="true">
              <path d="M8 1.8l5 2v4.1c0 3-2.1 5.3-5 6.3-2.9-1-5-3.3-5-6.3V3.8z" />
            </svg>
            <span>{t("invite.benefit.private")}</span>
          </div>
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.actions}>
          <span className={styles.grow} />
          <button type="button" className={styles.ghostBtn} disabled={busy} onClick={onClose}>
            {t("invite.decline")}
          </button>
          <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void accept()}>
            {t("team.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
