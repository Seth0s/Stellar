import { useEffect, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type { CloudStatusInfo, TeamInvitePreviewInfo, TeamRole } from "../../preload/index";
import { isSignupClosedError } from "./account-mode-decision";
import { StellarMark } from "./StellarMark";
import { identityMatchesInvite, inviteStep, splitTemplate, type InviteStep } from "./team-admin-decisions";
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

const ROLE_WORD_KEYS: Record<TeamRole, MessageKey> = {
  member: "invite.roleWord.member",
  admin: "invite.roleWord.admin",
  owner: "invite.roleWord.owner",
};

/** What the public preview tells before login. `targetMasked` keeps only the
 *  first letter of the invited email/login. */
export type InvitePreview = TeamInvitePreviewInfo;

/** Renders a translated template, wrapping each `{slot}` in its own element so a
 *  sentence with a bold name stays ONE translatable string. */
export function Rich({ template, slots }: { template: string; slots: Record<string, { text: string; className?: string }> }): ReactNode {
  return (
    <>
      {splitTemplate(template).map((part, i) => {
        if ("text" in part) return <span key={i}>{part.text}</span>;
        const slot = slots[part.slot];
        return slot ? (
          <span key={i} className={slot.className}>
            {slot.text}
          </span>
        ) : null;
      })}
    </>
  );
}

function initials(label: string): string {
  const letters = label
    .replace(/@.*$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase());
  return (letters.length >= 2 ? letters[0] + letters[1] : (letters[0] ?? "?") + (label.charAt(1) || "")).toUpperCase().slice(0, 2);
}

/** The identity strings the signed-in account holds: the email itself, the
 *  GitHub login. */
function identityLabels(status: CloudStatusInfo | null): string[] {
  if (status?.state !== "logged-in") return [];
  const out: string[] = [];
  for (const id of status.account.identities) {
    const label = id.kind === "email" ? id.subject : id.login;
    if (label) out.push(label);
  }
  return out;
}

function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * Team invite. Opened by the `stellar://invite` link (or a pasted invite link).
 * The public preview tells who invited whom to what BEFORE any login; the guest
 * then signs in with the invited identity (the closed signup lets an invite
 * create the account), accepts, and lands on the joined screen. A signed-in
 * account that is not the invited one gets the explicit wrong-identity state —
 * before trying, when the masked target already rules it out, and after the
 * server's own refusal.
 */
export function InviteDialog({
  token,
  preview: fixturePreview,
  onClose,
  onAccepted,
  onOpenTeam,
}: {
  /** The raw invite token, or the whole pasted invite link. */
  token: string;
  /** A ready preview (fixture): skips the public lookup. */
  preview?: InvitePreview | null;
  onClose: () => void;
  onAccepted?: (team: { id: string; name: string }) => void;
  /** "Open the team board" on the joined screen. */
  onOpenTeam?: (teamId: string) => void;
}) {
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "unavailable">(fixturePreview ? "ready" : "loading");
  const [preview, setPreview] = useState<InvitePreview | null>(fixturePreview ?? null);
  const [status, setStatus] = useState<CloudStatusInfo | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverMismatch, setServerMismatch] = useState(false);
  const [joined, setJoined] = useState<{ teamId: string; teamName: string; role: TeamRole; seats: { used: number; total: number } | null } | null>(null);

  // Public preview: works signed out, names the team and who invited.
  useEffect(() => {
    if (fixturePreview) return;
    let live = true;
    setPreviewState("loading");
    window.team
      .previewInvite(token)
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setPreview(res.preview);
          setPreviewState("ready");
        } else {
          setPreviewState("unavailable");
        }
      })
      .catch(() => live && setPreviewState("unavailable"));
    return () => {
      live = false;
    };
  }, [token, fixturePreview]);

  useEffect(() => {
    void window.cloud.status().then(setStatus).catch(() => {});
    return window.cloud.onStatusChanged(setStatus);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loggedIn = status?.state === "logged-in";
  const identities = identityLabels(status);
  const matches = identityMatchesInvite(identities, preview?.targetMasked ?? "");
  const step: InviteStep = inviteStep({
    previewState: status === null && previewState === "ready" ? "loading" : previewState,
    loggedIn,
    identityMatches: matches,
    serverMismatch,
    joined: joined !== null,
  });
  const signupClosed = status?.state === "logged-out" && isSignupClosedError(status.lastError);
  const pending = status?.state === "pending" ? status.provider : null;

  const teamName = joined?.teamName ?? preview?.teamName ?? t("invite.unknownTeam");
  const avatarLetter = teamName.trim().charAt(0).toUpperCase() || "T";
  const role: TeamRole = joined?.role ?? preview?.role ?? "member";
  const roleWord = t(ROLE_WORD_KEYS[role]);
  const myIdentity = identities[0] ?? "";

  async function signIn(provider: "github" | "email") {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.cloud.login(provider, provider === "email" ? email.trim() : undefined));
    } catch {
      setError(t("cloud.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelLogin() {
    try {
      setStatus(await window.cloud.cancel());
    } catch {
      /* nothing to cancel */
    }
  }

  async function switchAccount() {
    setServerMismatch(false);
    setError(null);
    try {
      setStatus(await window.cloud.logout());
    } catch {
      setError(t("cloud.error.generic"));
    }
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await window.team.acceptInvite(token);
      if (!res.ok) {
        if (res.reason === "identity-mismatch") setServerMismatch(true);
        else setError(t(ACCEPT_REASON_KEYS[res.reason] ?? "team.accept.error"));
        return;
      }
      const joinedTeam = res.value.team;
      // The seats line of the joined screen: read once, only when the plan has a limit.
      let seats: { used: number; total: number } | null = null;
      try {
        const detail = await window.team.detail(joinedTeam.id);
        if (detail.ok && detail.detail.seats) seats = { used: detail.detail.seats.used, total: detail.detail.seats.total };
      } catch {
        /* the seats line is optional */
      }
      setJoined({ teamId: joinedTeam.id, teamName: joinedTeam.name, role: res.value.membership.role, seats });
      onAccepted?.({ id: joinedTeam.id, name: joinedTeam.name });
    } catch {
      setError(t("team.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const strong = (text: string) => ({ text, className: styles.strong });
  const teamBrand = (label: string, name: string) => (
    <div className={styles.brand}>
      <span className={styles.teamAvatar}>{avatarLetter}</span>
      <span className={styles.brandText}>
        <span className={styles.brandLabel}>{label}</span>
        <span className={styles.brandName}>{name}</span>
      </span>
    </div>
  );

  let body: ReactNode;
  if (step === "loading") {
    body = <p className={styles.hint}>{t("invite.loading")}</p>;
  } else if (step === "unavailable") {
    body = (
      <>
        <div className={styles.titleBlock}>
          <h1 id="invite-title" className={styles.title} data-part="unavailable-title">
            {t("invite.unavailable.title")}
          </h1>
          <p className={styles.hint}>{t("invite.unavailable.text")}</p>
        </div>
        <button type="button" className={styles.ghostBtn} onClick={onClose}>
          {t("invite.close")}
        </button>
      </>
    );
  } else if (step === "signin") {
    body = (
      <>
        <div className={styles.brand}>
          <StellarMark size={28} title="Stellar" />
          <span className={styles.brandStellar}>Stellar</span>
        </div>
        <div className={styles.titleBlock}>
          <h1 id="invite-title" className={`${styles.title} ${styles.titleTight}`}>
            {t("invite.signin.title")}
          </h1>
          <p className={styles.hint} data-part="signin-lead">
            {preview?.invitedByName ? (
              <Rich template={t("invite.signin.lead", { inviter: "{inviter}", team: "{team}" })} slots={{ inviter: strong(preview.invitedByName), team: strong(teamName) }} />
            ) : (
              <Rich template={t("invite.signin.leadAnon", { team: "{team}" })} slots={{ team: strong(teamName) }} />
            )}
          </p>
        </div>
        <div className={styles.info} data-part="signin-info">
          {preview?.targetMasked ? (
            <Rich template={t("invite.signin.info", { target: "{target}" })} slots={{ target: { text: preview.targetMasked, className: styles.mono } }} />
          ) : (
            t("invite.signin.infoNoTarget")
          )}
        </div>
        {pending ? (
          <>
            <div className={styles.info} data-part="signin-waiting" role="status">
              {pending === "github" ? t("invite.signin.waitingGithub") : t("invite.signin.waitingEmail", { email: email.trim() })}
            </div>
            <button type="button" className={styles.ghostBtn} onClick={() => void cancelLogin()}>
              {t("invite.signin.cancel")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={styles.ghostBtn} data-part="signin-github" disabled={busy} onClick={() => void signIn("github")}>
              <GithubMark />
              {t("invite.signin.github")}
            </button>
            <div className={styles.divider}>{t("invite.signin.orEmail")}</div>
            <div>
              <label className={styles.label} htmlFor="invite-email">
                {t("invite.signin.emailLabel")}
              </label>
              <input
                id="invite-email"
                className={styles.input}
                data-part="signin-email"
                type="email"
                value={email}
                placeholder={t("invite.signin.emailPlaceholder")}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="button" className={styles.primaryBtn} data-part="signin-submit" disabled={busy || email.trim() === ""} onClick={() => void signIn("email")}>
              {t("invite.signin.submit")}
            </button>
            <p className={`${styles.hint} ${styles.center}`}>{t("invite.signin.foot")}</p>
          </>
        )}
        {signupClosed ? <div className={styles.err}>{t("cloud.error.signupClosed")}</div> : null}
      </>
    );
  } else if (step === "accept") {
    body = (
      <>
        {teamBrand(t("invite.accept.for"), teamName)}
        <div className={styles.titleBlock}>
          <h1 id="invite-title" className={styles.title}>
            {t("invite.accept.title")}
          </h1>
          <p className={styles.hint} data-part="accept-lead">
            <Rich template={t("invite.accept.lead", { role: "{role}" })} slots={{ role: strong(roleWord) }} />
          </p>
        </div>
        <div className={styles.identity} data-part="accept-identity">
          <span className={styles.identityAvatar}>{initials(status?.state === "logged-in" && status.account.displayName ? status.account.displayName : myIdentity)}</span>
          <span className={styles.identityText}>
            <span className={styles.identityName}>{myIdentity}</span>
            <span className={styles.identityHint}>{t("invite.accept.identity")}</span>
          </span>
        </div>
        <div className={styles.ok}>{t("invite.accept.ok")}</div>
        {error ? <div className={styles.err}>{error}</div> : null}
        <button type="button" className={styles.primaryBtn} data-part="accept-submit" disabled={busy} onClick={() => void accept()}>
          {busy ? t("invite.accept.busy") : t("invite.accept.submit")}
        </button>
        <button type="button" className={styles.ghostBtn} data-part="accept-decline" disabled={busy} onClick={onClose}>
          {t("invite.decline")}
        </button>
      </>
    );
  } else if (step === "wrong-id") {
    body = (
      <>
        {teamBrand(t("invite.accept.for"), teamName)}
        <div className={styles.titleBlock}>
          <h1 id="invite-title" className={styles.title}>
            {t("invite.wrong.title")}
          </h1>
          <p className={styles.hint}>{t("invite.wrong.lead")}</p>
        </div>
        <div className={styles.err} data-part="wrong-identity" role="alert">
          <Rich
            template={t("invite.wrong.body", { who: "{who}", target: "{target}" })}
            slots={{ who: { text: myIdentity, className: styles.boldNormal }, target: { text: preview?.targetMasked ?? "", className: styles.boldNormal } }}
          />
        </div>
        <button type="button" className={styles.primaryBtn} data-part="wrong-switch" onClick={() => void switchAccount()}>
          {t("invite.wrong.switch")}
        </button>
        <button type="button" className={styles.ghostBtn} onClick={onClose}>
          {t("invite.close")}
        </button>
      </>
    );
  } else if (joined) {
    body = (
      <>
        {teamBrand(joined.teamName, t("invite.joined.welcome"))}
        <div className={styles.titleBlock}>
          <h1 id="invite-title" className={styles.title}>
            {t("invite.joined.title")}
          </h1>
          <p className={styles.hint} data-part="joined-lead">
            <Rich
              template={
                joined.seats
                  ? t("invite.joined.lead", { role: "{role}", used: joined.seats.used, total: joined.seats.total })
                  : t("invite.joined.leadNoSeats", { role: "{role}" })
              }
              slots={{ role: strong(t(ROLE_WORD_KEYS[joined.role])) }}
            />
          </p>
        </div>
        <div className={styles.ok}>{t("invite.joined.ok")}</div>
        <button
          type="button"
          className={styles.primaryBtn}
          data-part="joined-open"
          onClick={() => {
            onOpenTeam?.(joined.teamId);
            onClose();
          }}
        >
          {t("invite.joined.open")}
        </button>
      </>
    );
  }

  return (
    <div className={styles.scrim} data-invite-dialog data-step={step}>
      <section className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="invite-title" data-part={step}>
        {body}
      </section>
    </div>
  );
}
