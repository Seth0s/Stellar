import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import type { CloudStatusInfo } from "../../preload/index";
import styles from "./CloudAccount.module.css";

/**
 * Conta Stellar na Home do perfil (A2 — BACKEND_V1.md §4/§7.2): entrar com
 * GitHub ou e-mail, ver o estado logado (nome, identidades) e sair. O login
 * roda no MAIN (listener loopback + PKCE + safeStorage do perfil); aqui só se
 * lê o estado e se dispara a ação. O estado chega por push (`cloud:status-changed`)
 * porque o login fecha no navegador DEPOIS de a ação retornar.
 *
 * Ausência é dita, não inventada: erro do backend aparece como está; o rótulo
 * do gatilho diz "aguardando" enquanto o navegador não volta.
 */
export function CloudAccount() {
  const [status, setStatus] = useState<CloudStatusInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.cloud.status());
    } catch {
      /* main indisponível: o gatilho fica em "entrar" */
    }
  }, []);

  useEffect(() => {
    void refresh();
    return window.cloud.onStatusChanged((next) => setStatus(next));
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function run(fn: () => Promise<CloudStatusInfo>) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
    } catch {
      setError(t("cloud.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state ?? "logged-out";
  const triggerLabel =
    status?.state === "logged-in" ? status.account.displayName : state === "pending" ? t("cloud.pending") : t("cloud.signIn");
  const dotClass = state === "logged-in" ? styles.dotOn : state === "pending" ? styles.dotPending : styles.dot;
  const lastError = status?.state === "logged-out" ? status.lastError : null;
  const shownError = error ?? lastError;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("cloud.title")}
      >
        <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
        {triggerLabel}
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label={t("cloud.title")}>
          <div className={styles.title}>{t("cloud.title")}</div>

          {state === "logged-in" && status?.state === "logged-in" && (
            <>
              <div className={styles.name}>{status.account.displayName}</div>
              {status.account.identities.length > 0 && (
                <ul className={styles.identities}>
                  {status.account.identities.map((id) => (
                    <li key={`${id.kind}:${id.subject}`} className={styles.identity}>
                      <span className={styles.badge}>{id.kind}</span>
                      {id.login ?? id.subject}
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.row}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.wide}`}
                  disabled={busy}
                  onClick={() => void run(() => window.cloud.logout())}
                >
                  {t("cloud.signOut")}
                </button>
              </div>
            </>
          )}

          {state === "pending" && (
            <>
              <div className={styles.muted}>
                {status?.state === "pending" && status.provider === "email"
                  ? t("cloud.waitingEmail", { email })
                  : t("cloud.waitingGithub")}
              </div>
              <div className={styles.row}>
                <button type="button" className={`${styles.btn} ${styles.wide}`} disabled={busy} onClick={() => void run(() => window.cloud.cancel())}>
                  {t("common.cancel")}
                </button>
              </div>
            </>
          )}

          {state === "logged-out" && (
            <>
              <div className={styles.row}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary} ${styles.wide}`}
                  disabled={busy}
                  onClick={() => void run(() => window.cloud.login("github"))}
                >
                  {t("cloud.withGithub")}
                </button>
              </div>
              <div className={styles.row}>
                <input
                  className={styles.input}
                  type="email"
                  placeholder={t("cloud.emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && email.trim() !== "") void run(() => window.cloud.login("email", email.trim()));
                  }}
                />
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy || email.trim() === ""}
                  onClick={() => void run(() => window.cloud.login("email", email.trim()))}
                >
                  {t("cloud.withEmail")}
                </button>
              </div>
            </>
          )}

          {shownError && <div className={styles.error}>{shownError}</div>}
          {status && <div className={styles.muted}>{t("cloud.apiLabel")}: {status.apiBaseUrl}</div>}
        </div>
      )}
    </div>
  );
}
