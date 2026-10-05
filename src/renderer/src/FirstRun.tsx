import { t, type Locale } from "../../shared/i18n";
import { AppLogo } from "./AppLogo";
import styles from "./FirstRun.module.css";

/**
 * Tela 2 — first run. Shown only for a profile that has no sessions, no
 * account and never made this choice. The two paths are sign in with an
 * account, or use this machine only; the language can be changed here.
 */
export function FirstRun({
  locale,
  onLanguage,
  onSignIn,
  onLocal,
}: {
  locale: Locale;
  onLanguage: (locale: Locale) => void;
  onSignIn: () => void;
  onLocal: () => void;
}) {
  return (
    <div className={styles.wrap}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <AppLogo size={64} />
          <h1 className={styles.title}>{t("firstRun.title")}</h1>
          <p className={styles.intro}>{t("firstRun.intro")}</p>
        </div>

        <div className={styles.choices}>
          <button type="button" className={styles.choice} data-role="firstrun-account" onClick={onSignIn}>
            <span className={styles.choiceIcon}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--v2-accent-soft)" strokeWidth="1.5" aria-hidden="true">
                <circle cx="10" cy="7" r="3" />
                <path d="M4 16.5c.7-3 3-4.6 6-4.6s5.3 1.6 6 4.6" />
              </svg>
            </span>
            <span className={styles.choiceTitle}>{t("firstRun.account.title")}</span>
            <span className={styles.choiceDesc}>{t("firstRun.account.desc")}</span>
            <span className={styles.choiceLink}>
              {t("firstRun.account.link")}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" />
              </svg>
            </span>
          </button>

          <button type="button" className={styles.choice} data-role="firstrun-local" onClick={onLocal}>
            <span className={`${styles.choiceIcon} ${styles.choiceIconAlt}`}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--v2-text-2)" strokeWidth="1.5" aria-hidden="true">
                <rect x="3" y="4" width="14" height="10" rx="1.6" />
                <path d="M7 17h6M10 14v3" />
              </svg>
            </span>
            <span className={styles.choiceTitle}>{t("firstRun.local.title")}</span>
            <span className={styles.choiceDesc}>{t("firstRun.local.desc")}</span>
            <span className={styles.choiceLink}>
              {t("firstRun.local.link")}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" />
              </svg>
            </span>
          </button>
        </div>

        <div className={styles.langRow}>
          <span>{t("firstRun.language")}</span>
          <div className={styles.segGroup} role="group" aria-label={t("firstRun.language")}>
            <button
              type="button"
              className={`${styles.seg}${locale === "pt-BR" ? ` ${styles.segOn}` : ""}`}
              aria-pressed={locale === "pt-BR"}
              onClick={() => onLanguage("pt-BR")}
            >
              Português
            </button>
            <button
              type="button"
              className={`${styles.seg}${locale === "en" ? ` ${styles.segOn}` : ""}`}
              aria-pressed={locale === "en"}
              onClick={() => onLanguage("en")}
            >
              English
            </button>
          </div>
          <span>·</span>
          <span>{t("firstRun.languageHint")}</span>
        </div>
      </div>
    </div>
  );
}
