import { useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type { TeamRole } from "../../preload/index";
import styles from "./InviteDialog.module.css";

const ACCEPT_REASON_KEYS: Record<string, MessageKey> = {
  "identity-mismatch": "team.accept.identity-mismatch",
  expired: "team.accept.expired",
  used: "team.accept.used",
  revoked: "team.accept.revoked",
  "not-found": "team.accept.not-found",
  "already-member": "team.accept.already-member",
  "seats-exceeded": "team.accept.seats-exceeded",
  error: "team.accept.error",
};

export type InvitePreview = {
  teamName: string;
  inviterName: string;
  role: TeamRole;
  expiresInDays: number;
  email: string;
  skills: number;
  agents: number;
  rules: number;
};

const ROLE_KEYS: Record<TeamRole, MessageKey> = {
  member: "invite.role.member",
  admin: "invite.role.admin",
  owner: "invite.role.owner",
};

/**
 * Team invite (tela 7). Opened by the `stellar://invite` link. When a
 * preview is available (fixture or future peek API), the dialog shows the
 * inviter, team, role badge, expiry and team-house counts from the
 * prototype; otherwise it keeps the honest unknown-team fallback.
 */
export function InviteDialog({
  token,
  preview,
  onClose,
  onAccepted,
}: {
  token: string;
  preview?: InvitePreview | null;
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

  const teamName = preview?.teamName ?? null;
  const inviterName = preview?.inviterName ?? null;
  const role = preview?.role ?? "member";
  const avatarLetter = (teamName ?? "T").trim().charAt(0).toUpperCase() || "T";
  const expiresLabel =
    preview == null
      ? null
      : preview.expiresInDays === 1
        ? t("invite.expiresInDay")
        : t("invite.expiresInDays", { n: preview.expiresInDays });

  return (
    <div className={styles.scrim} role="dialog" aria-labelledby="invite-title" data-invite-dialog>
      <div className={styles.dialog}>
        <div className={styles.head}>
          <span className={styles.avatar}>{avatarLetter}</span>
          <div className={styles.headText}>
            <div className={styles.inviter}>
              {inviterName ? t("invite.invitedBy", { name: inviterName }) : t("invite.invited")}
            </div>
            <h1 id="invite-title" className={styles.teamName}>
              {teamName ?? t("invite.unknownTeam")}
            </h1>
          </div>
          <span className={styles.spacer} />
          {preview ? <span className={styles.role}>{t(ROLE_KEYS[role])}</span> : null}
        </div>

        {preview ? (
          <div className={styles.withTeam}>
            <div className={styles.withTeamTitle}>{t("invite.withTeam.title")}</div>
            <div className={styles.withTeamGrid}>
              <div className={styles.stat}>
                <span className={styles.statN}>{preview.skills}</span>
                <span className={styles.statLabel}>{t("invite.withTeam.skills")}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statN}>{preview.agents}</span>
                <span className={styles.statLabel}>{t("invite.withTeam.agents")}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statN}>{preview.rules}</span>
                <span className={styles.statLabel}>{t("invite.withTeam.rules")}</span>
              </div>
            </div>
          </div>
        ) : null}

        <div className={styles.benefits}>
          <div className={styles.benefit}>
            <svg className={styles.benefitIcon} width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="var(--v2-good)" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 7.2l2.6 2.6L11 4.4" />
            </svg>
            <span>
              {preview?.email
                ? t("invite.benefit.identityNamed", { email: preview.email })
                : t("invite.benefit.identity")}
            </span>
          </div>
          <div className={styles.benefit}>
            <svg className={styles.benefitIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--v2-accent-soft)" strokeWidth="1.4" aria-hidden="true">
              <rect x="2" y="3" width="5" height="10" rx="1.2" />
              <rect x="9" y="3" width="5" height="10" rx="1.2" />
            </svg>
            <span>
              {teamName ? t("invite.benefit.profileNamed", { name: teamName }) : t("invite.benefit.profile")}
            </span>
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
          {expiresLabel ? <span className={styles.expires}>{expiresLabel}</span> : <span className={styles.grow} />}
          <button type="button" className={styles.ghostBtn} disabled={busy} onClick={onClose}>
            {t("invite.decline")}
          </button>
          <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void accept()}>
            {t("invite.acceptOpen")}
          </button>
        </div>
      </div>
    </div>
  );
}
