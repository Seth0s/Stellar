import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import type { CloudStatusInfo, WorkHomeTool } from "../../preload/index";
import { AppLogo } from "./AppLogo";
import styles from "./LoginScreen.module.css";

const ALL_TOOLS: WorkHomeTool[] = ["claude", "codex", "cursor", "gemini", "stellar"];
type SyncChoice = "all" | "some" | "none";

const STEP_NAMES = ["LoginScreen.step.browser", "LoginScreen.step.authorize", "LoginScreen.step.account", "LoginScreen.step.sync"] as const;

function Spinner({ size = 36 }: { size?: number }) {
  return (
    <svg className={styles.spinner} width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <circle cx="18" cy="18" r="14" stroke="var(--v2-line-mid)" strokeWidth="3" />
      <path d="M18 4a14 14 0 0 1 14 14" stroke="var(--v2-accent)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Login (telas 5 and 6). The account login runs in the main process (loopback
 * listener + PKCE + safeStorage); this screen drives the browser step by step
 * and, at the end, decides what syncs. "Do not sync anything" logs in with the
 * account but leaves the work home off.
 */
export function LoginScreen({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"choose" | 0 | 1 | 2 | 3>("choose");
  const [provider, setProvider] = useState<"github" | "email">("github");
  const [email, setEmail] = useState("");
  const [cloud, setCloud] = useState<CloudStatusInfo | null>(null);
  const [choice, setChoice] = useState<SyncChoice>("all");
  const [tools, setTools] = useState<Set<WorkHomeTool>>(new Set(["claude", "codex", "gemini", "stellar"]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.cloud.status().then(setCloud).catch(() => {});
    return window.cloud.onStatusChanged(setCloud);
  }, []);

  const loggedIn = cloud?.state === "logged-in";

  useEffect(() => {
    if (loggedIn && (mode === 0 || mode === 1)) setMode(2);
  }, [loggedIn, mode]);

  async function start(p: "github" | "email") {
    setProvider(p);
    setError(null);
    setMode(0);
    try {
      setCloud(await window.cloud.login(p, p === "email" ? email.trim() : undefined));
    } catch {
      setError(t("cloud.error.generic"));
    }
  }

  async function cancelAndClose() {
    try {
      await window.cloud.cancel();
    } catch {
      /* nothing to cancel is fine */
    }
    onClose();
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const selected = choice === "all" ? ALL_TOOLS : choice === "none" ? [] : [...tools];
      await window.workhome.setTools(selected);
      onDone();
    } catch {
      setError(t("workhome.error.generic"));
      setBusy(false);
    }
  }

  function toggleTool(tool: WorkHomeTool, on: boolean) {
    setTools((prev) => {
      const next = new Set(prev);
      if (on) next.add(tool);
      else next.delete(tool);
      return next;
    });
  }

  const stepIndex = mode === "choose" ? 0 : mode;

  return (
    <div className={styles.wrap}>
      <section className={styles.left}>
        <svg className={styles.deco} width="560" height="420" viewBox="0 0 560 420" fill="none" aria-hidden="true">
          <path d="M40 360L150 280L220 330L340 210L470 250" stroke="var(--v2-deco)" strokeWidth="1.2" />
          <path d="M340 210L380 90L520 60" stroke="var(--v2-deco)" strokeWidth="1.2" />
          <circle cx="40" cy="360" r="3" fill="var(--v2-deco)" />
          <circle cx="150" cy="280" r="4" fill="var(--v2-accent-3)" />
          <circle cx="220" cy="330" r="3" fill="var(--v2-deco)" />
          <circle cx="340" cy="210" r="5" fill="var(--v2-accent-3)" />
          <circle cx="470" cy="250" r="3" fill="var(--v2-deco)" />
          <circle cx="380" cy="90" r="3.5" fill="var(--v2-accent-3)" />
          <circle cx="520" cy="60" r="3" fill="var(--v2-deco)" />
        </svg>
        <div className={styles.brandRow}>
          <AppLogo size={40} />
          <span className={styles.brandName}>stellar</span>
        </div>
        <div className={styles.leftBody}>
          <h2 className={styles.leftTitle}>{t("LoginScreen.marketing.title")}</h2>
          <div className={styles.features}>
            <div className={styles.feature}>
              <span className={styles.featureIcon}>
                <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                  <path d="M2.5 7.2L8 2.8l5.5 4.4V13a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8z" />
                </svg>
              </span>
              <span className={styles.featureText}>
                <span className={styles.featureTitle}>{t("LoginScreen.marketing.anyMachine.title")}</span>
                <span className={styles.featureDesc}>{t("LoginScreen.marketing.anyMachine.desc")}</span>
              </span>
            </div>
            <div className={styles.feature}>
              <span className={styles.featureIcon}>
                <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                  <rect x="2" y="3" width="5" height="10" rx="1.2" />
                  <rect x="9" y="3" width="5" height="10" rx="1.2" />
                </svg>
              </span>
              <span className={styles.featureText}>
                <span className={styles.featureTitle}>{t("LoginScreen.marketing.separate.title")}</span>
                <span className={styles.featureDesc}>{t("LoginScreen.marketing.separate.desc")}</span>
              </span>
            </div>
            <div className={styles.feature}>
              <span className={styles.featureIcon}>
                <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                  <circle cx="5.8" cy="5.6" r="2.3" />
                  <circle cx="11" cy="6.3" r="1.8" />
                  <path d="M1.8 13c.4-2.3 2-3.6 4-3.6s3.6 1.3 4 3.6M10 9.6c1.9 0 3.4 1.1 3.9 3.4" />
                </svg>
              </span>
              <span className={styles.featureText}>
                <span className={styles.featureTitle}>{t("LoginScreen.marketing.team.title")}</span>
                <span className={styles.featureDesc}>{t("LoginScreen.marketing.team.desc")}</span>
              </span>
            </div>
          </div>
        </div>
        <div className={styles.secure}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--v2-good)" strokeWidth="1.4" aria-hidden="true">
            <path d="M8 1.8l5 2v4.1c0 3-2.1 5.3-5 6.3-2.9-1-5-3.3-5-6.3V3.8z" />
          </svg>
          {t("LoginScreen.secure")}
        </div>
      </section>

      <section className={styles.right}>
        <div className={styles.closeRow}>
          <button type="button" className={styles.close} aria-label={t("LoginScreen.close")} onClick={() => void cancelAndClose()}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className={styles.rightCenter}>
          {mode === "choose" ? (
            <div className={styles.form}>
              <div className={styles.formHead}>
                <h1 className={styles.title}>{t("cloud.title")}</h1>
                <p className={styles.sub}>{t("LoginScreen.choose.sub")}</p>
              </div>
              <button type="button" className={styles.githubBtn} onClick={() => void start("github")}>
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 .3a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .3z" />
                </svg>
                {t("cloud.withGithub")}
              </button>
              <div className={styles.divider}>
                <span className={styles.dividerLine} />
                {t("LoginScreen.orEmail")}
                <span className={styles.dividerLine} />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="lg-email">
                  {t("LoginScreen.email")}
                </label>
                <input
                  id="lg-email"
                  className={styles.input}
                  type="email"
                  placeholder={t("cloud.emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <button type="button" className={styles.primaryBtn} disabled={email.trim() === ""} onClick={() => void start("email")}>
                {t("LoginScreen.sendLink")}
              </button>
              <p className={styles.terms}>{t("LoginScreen.terms")}</p>
              <div className={styles.hr} />
              <button type="button" className={styles.noAccount} onClick={onDone}>
                {t("LoginScreen.localOnly")}
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" />
                </svg>
              </button>
              {error ? <div className={styles.error}>{error}</div> : null}
            </div>
          ) : (
            <div className={styles.panel}>
              <div className={styles.panelProgress}>
                <div className={styles.stepMeta}>
                  <span>{t("LoginScreen.stepOf", { n: stepIndex + 1, name: t(STEP_NAMES[stepIndex]) })}</span>
                  <button type="button" className={styles.noAccount} onClick={() => void cancelAndClose()}>
                    {t("common.cancel")}
                  </button>
                </div>
                <div className={styles.segments} role="progressbar" aria-valuemin={1} aria-valuemax={4} aria-valuenow={stepIndex + 1}>
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className={`${styles.seg} ${i < stepIndex ? styles.segDone : i === stepIndex ? styles.segActive : ""}`} />
                  ))}
                </div>
              </div>

              {mode === 0 && (
                <div className={styles.stepBody}>
                  <Spinner />
                  <div>
                    <h1 className={styles.stepTitle}>{t("LoginScreen.browser.title")}</h1>
                    <p className={styles.stepText}>{t("LoginScreen.browser.text")}</p>
                  </div>
                  <div className={styles.stepActions}>
                    <button type="button" className={styles.ghostBtn} onClick={() => void start(provider)}>
                      {t("LoginScreen.browser.again")}
                    </button>
                    <span className={styles.grow} />
                    <button type="button" className={styles.primaryBtn} onClick={() => setMode(1)}>
                      {t("LoginScreen.browser.opened")}
                    </button>
                  </div>
                </div>
              )}

              {mode === 1 && (
                <div className={styles.stepBody}>
                  <span className={`${styles.stepIcon} ${styles.stepIconGithub}`}>
                    <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M8 .3a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .3z" />
                    </svg>
                  </span>
                  <div>
                    <h1 className={styles.stepTitle}>
                      {provider === "github" ? t("LoginScreen.authorize.title") : t("LoginScreen.authorize.emailTitle")}
                    </h1>
                    <p className={styles.stepText}>
                      {provider === "github" ? t("LoginScreen.authorize.text") : t("LoginScreen.authorize.emailText", { email: email.trim() })}
                    </p>
                  </div>
                  <div className={styles.waitBox}>
                    <Spinner size={14} />
                    {t("LoginScreen.waiting")}
                  </div>
                  <div className={styles.stepActions}>
                    <button type="button" className={styles.ghostBtn} onClick={() => setMode(0)}>
                      {t("common.back")}
                    </button>
                    <span className={styles.grow} />
                  </div>
                </div>
              )}

              {mode === 2 && (
                <div className={styles.stepBody}>
                  <span className={`${styles.stepIcon} ${styles.stepIconGood}`}>
                    <svg width="22" height="22" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <path d="M3 7.2l2.6 2.6L11 4.4" />
                    </svg>
                  </span>
                  <div>
                    <h1 className={styles.stepTitle}>{t("LoginScreen.connected.title")}</h1>
                    <p className={styles.stepText}>
                      {t("LoginScreen.connected.text", { name: loggedIn ? cloud.account.displayName : "" })}
                    </p>
                  </div>
                  <div className={styles.stepActions}>
                    <span className={styles.grow} />
                    <button type="button" className={styles.primaryBtn} onClick={() => setMode(3)}>
                      {t("LoginScreen.continue")}
                    </button>
                  </div>
                </div>
              )}

              {mode === 3 && (
                <div className={styles.stepBody}>
                  <div>
                    <h1 className={styles.stepTitle}>{t("LoginScreen.sync.title")}</h1>
                    <p className={styles.stepText}>{t("LoginScreen.sync.text")}</p>
                  </div>
                  <button type="button" className={`${styles.choice}${choice === "all" ? ` ${styles.choiceOn}` : ""}`} onClick={() => setChoice("all")}>
                    <span className={`${styles.dot}${choice === "all" ? ` ${styles.dotOn}` : ""}`} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceTitle}>{t("LoginScreen.sync.all")}</span>
                      <span className={styles.choiceDesc}>{t("LoginScreen.sync.allDesc")}</span>
                    </span>
                  </button>
                  <button type="button" className={`${styles.choice}${choice === "some" ? ` ${styles.choiceOn}` : ""}`} onClick={() => setChoice("some")}>
                    <span className={`${styles.dot}${choice === "some" ? ` ${styles.dotOn}` : ""}`} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceTitle}>{t("LoginScreen.sync.some")}</span>
                      <span className={styles.choiceDesc}>{t("LoginScreen.sync.someDesc")}</span>
                    </span>
                  </button>
                  {choice === "some" ? (
                    <div className={styles.subChoices}>
                      {ALL_TOOLS.map((tool) => (
                        <label key={tool} className={styles.subRow}>
                          <input className={styles.sw} type="checkbox" checked={tools.has(tool)} onChange={(e) => toggleTool(tool, e.target.checked)} />
                          {t(`workhome.tool.${tool}` as `workhome.tool.${WorkHomeTool}`)}
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <button type="button" className={`${styles.choice}${choice === "none" ? ` ${styles.choiceOn}` : ""}`} onClick={() => setChoice("none")}>
                    <span className={`${styles.dot}${choice === "none" ? ` ${styles.dotOn}` : ""}`} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceTitle}>{t("LoginScreen.sync.none")}</span>
                      <span className={styles.choiceDesc}>{t("LoginScreen.sync.noneDesc")}</span>
                    </span>
                  </button>
                  <div className={styles.stepActions}>
                    <button type="button" className={styles.ghostBtn} onClick={() => setMode(2)}>
                      {t("common.back")}
                    </button>
                    <span className={styles.grow} />
                    <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void finish()}>
                      {choice === "none" ? t("LoginScreen.finish.noSync") : t("LoginScreen.finish.sync")}
                    </button>
                  </div>
                </div>
              )}

              {error ? <div className={styles.error}>{error}</div> : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
