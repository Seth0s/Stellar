import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import { AppLogo } from "./AppLogo";
import styles from "./Boot.module.css";

type StageState = "pending" | "active" | "done";

/**
 * Tela 1 — cold start. Shown while the app is coming up, with the real boot
 * steps in order: profile, sessions, providers. It hides itself once all
 * three have actually finished, so no step is ever asserted done before it is.
 *
 * The profile and sessions signals come from the shell that mounts this
 * component; the providers signal is this component's own real check against
 * the provider registry.
 */
export function Boot({
  profileReady,
  profileName,
  sessionsReady,
  onReady,
}: {
  profileReady: boolean;
  profileName: string | null;
  sessionsReady: boolean;
  onReady: () => void;
}) {
  const [providersReady, setProvidersReady] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.agents
      .checkAvailability()
      .catch(() => null)
      .then(() => {
        if (alive) setProvidersReady(true);
      });
    window.system
      .getBuildIdentity()
      .then((id) => {
        if (alive) setVersion(id.version);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (profileReady && sessionsReady && providersReady) onReady();
  }, [profileReady, sessionsReady, providersReady, onReady]);

  const steps: { key: "profile" | "sessions" | "providers"; done: boolean }[] = [
    { key: "profile", done: profileReady },
    { key: "sessions", done: sessionsReady },
    { key: "providers", done: providersReady },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);

  const label = (key: string): string => {
    if (key === "profile") return profileName ? t("boot.profileNamed", { name: profileName }) : t("boot.profile");
    return t(`boot.${key}` as "boot.sessions" | "boot.providers");
  };

  return (
    <div className={styles.wrap} data-boot>
      <div className={styles.stageLogo}>
        <div className={styles.halo} aria-hidden="true" />
        <div className={styles.logo}>
          <AppLogo size={112} />
        </div>
      </div>

      <div className={styles.brand}>
        <div className={styles.wordmark}>stellar</div>
        <div className={styles.tagline}>{t("boot.tagline")}</div>
      </div>

      <div className={styles.progress}>
        <div className={styles.track}>
          <div className={styles.bar} />
        </div>
        <div className={styles.steps} role="status" aria-live="polite">
          {steps.map((step, i) => {
            const state: StageState = step.done ? "done" : i === activeIndex ? "active" : "pending";
            return (
              <div
                key={step.key}
                className={`${styles.step} ${state === "done" ? styles.stepDone : state === "active" ? styles.stepActive : styles.stepPending}`}
              >
                <span className={styles.mark}>
                  {state === "done" ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--v2-good)" strokeWidth="1.6" aria-hidden="true">
                      <path d="M3 7.2l2.6 2.6L11 4.4" />
                    </svg>
                  ) : state === "active" ? (
                    <span className={styles.dotActive} />
                  ) : (
                    <span className={styles.dotPending} />
                  )}
                </span>
                <span>{label(step.key)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.foot}>
        {version ? <span>v{version}</span> : null}
        {profileName ? (
          <>
            <span>·</span>
            <span>{profileName}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
