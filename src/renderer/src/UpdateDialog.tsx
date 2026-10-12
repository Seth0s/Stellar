import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t, getLocale, type MessageKey } from "../../shared/i18n";
import { useModal } from "./useModal";
import { useUpdateStatus } from "./useUpdateStatus";
import { deriveVersionJump } from "./update-jump";
import {
  canCloseDialog,
  closeLabelKey,
  errorCopy,
  runningParts,
  runningWarning,
  sessionsKey,
  type RunningCounts,
} from "./update-dialog-decision";
import {
  errorDetailLine,
  formatMegabytes,
  formatSpeed,
  formatWholeMegabytes,
  parseChangelogNotes,
  remainingTime,
} from "./update-format";
import styles from "./UpdateDialog.module.css";

/**
 * The update dialog (Atualizacao.dc.html): one window for every step — offer,
 * download with real progress, ready to restart, installing, failure, and the
 * manual path for installs that cannot update themselves.
 *
 * It only ever REPORTS and ASKS. The download runs in the main process and
 * survives this window closing; the app restarts only from "Reiniciar agora".
 */

const svgProps = {
  width: 22,
  height: 22,
  viewBox: "0 0 22 22",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function IconDown() {
  return (
    <svg {...svgProps} strokeWidth={1.7}>
      <path d="M11 3.5v10M6.8 9.6L11 13.8l4.2-4.2M4.5 17.5h13" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg {...svgProps} strokeWidth={1.8}>
      <path d="M4.8 11.4l4.2 4.2 8.2-8.6" />
    </svg>
  );
}
function IconWarn() {
  return (
    <svg {...svgProps} strokeWidth={1.7}>
      <path d="M11 4.2l8 14H3z" />
      <path d="M11 9.6v4M11 16v.2" />
    </svg>
  );
}
function IconBox() {
  return (
    <svg {...svgProps} strokeWidth={1.7}>
      <path d="M3.5 7.2L11 3.5l7.5 3.7v7.6L11 18.5l-7.5-3.7z" />
      <path d="M3.8 7.4L11 11l7.2-3.6M11 11v7.2" />
    </svg>
  );
}
function IconWarnSmall() {
  return (
    <svg className={styles.boxIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.3l6.2 11H1.8z" />
      <path d="M8 6.8v3M8 11.8v.2" />
    </svg>
  );
}
function IconCheckSmall() {
  return (
    <svg className={styles.boxIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.4 8.4l3 3 6-6.4" />
    </svg>
  );
}

export function UpdateDialog() {
  const u = useUpdateStatus();
  const { snapshot } = u;
  const { phase, version } = snapshot;
  const locale = getLocale();
  const [counts, setCounts] = useState<RunningCounts | null | "unknown">(null);
  const [copied, setCopied] = useState(false);
  const primaryRef = useRef<HTMLElement | null>(null);

  // What a restart would end — asked once the update is ready, never polled.
  useEffect(() => {
    if (phase !== "ready") {
      setCounts(null);
      return;
    }
    let cancelled = false;
    window.updater
      .runningCounts()
      .then((c) => {
        if (!cancelled) setCounts(c);
      })
      .catch(() => {
        if (!cancelled) setCounts("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  // Closing is "not now" while an offer is open, plain closing otherwise; never during the restart.
  const close = canCloseDialog(phase) ? (phase === "available" || phase === "manual" ? u.postpone : u.closeDialog) : () => {};
  const closeRef = useRef(close);
  closeRef.current = close;
  const stableClose = useCallback(() => closeRef.current(), []);
  const { modalProps } = useModal({ onClose: stableClose });

  // The focused button disappears when the step changes; keep focus in the dialog.
  useEffect(() => {
    const root = modalProps.ref.current;
    if (!root || root.contains(document.activeElement)) return;
    (primaryRef.current ?? root.querySelector<HTMLElement>("button, a[href]"))?.focus();
  }, [phase, modalProps.ref]);

  const title: Record<string, MessageKey> = {
    available: "update.dialog.available.title",
    downloading: "update.dialog.downloading.title",
    ready: "update.dialog.ready.title",
    installing: "update.dialog.installing.title",
    error: "update.dialog.error.title",
    manual: "update.dialog.manual.title",
  };
  const view = phase === "idle" ? "available" : phase;
  const subtitle =
    view === "available"
      ? u.currentVersion
        ? t("update.dialog.available.subtitle", { version: version ?? "", current: u.currentVersion })
        : t("update.dialog.subtitle", { version: version ?? "" })
      : view === "ready"
        ? t("update.dialog.ready.subtitle", { version: version ?? "" })
        : view === "manual"
          ? t("update.dialog.manual.subtitle", { version: version ?? "" })
          : t("update.dialog.subtitle", { version: version ?? "" });
  const jump = view === "available" && version && u.currentVersion ? deriveVersionJump(u.currentVersion, version) : null;
  const tone = view === "ready" ? styles.toneOk : view === "error" ? styles.toneError : view === "manual" ? styles.toneWarn : styles.toneInfo;
  const icon =
    view === "ready" ? <IconCheck /> : view === "error" ? <IconWarn /> : view === "manual" ? <IconBox /> : <IconDown />;

  const releaseLink = (label: MessageKey, className: string, part: string, ref?: boolean): ReactNode =>
    u.releaseUrl ? (
      <a
        className={className}
        href={u.releaseUrl}
        target="_blank"
        rel="noreferrer"
        data-part={part}
        ref={ref ? (el) => void (primaryRef.current = el) : undefined}
      >
        {t(label)}
      </a>
    ) : null;

  const primary = (label: string, onClick: () => void, disabled = false): ReactNode => (
    <button
      type="button"
      className={`${styles.btn} ${styles.btnPrimary}`}
      data-part="update-primary"
      disabled={disabled}
      onClick={onClick}
      ref={(el) => void (primaryRef.current = el)}
    >
      {label}
    </button>
  );

  const progress = snapshot.progress;
  const pct = progress ? Math.min(100, Math.floor(progress.percent)) : 0;
  const eta = progress ? remainingTime(progress) : null;
  const notes = parseChangelogNotes(snapshot.changelog);
  const warning = runningWarning(counts);
  const error = snapshot.error;
  const copy = error ? errorCopy(error) : null;

  return (
    <div
      className={styles.root}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className={styles.veil} />
      <section
        {...modalProps}
        className={styles.dialog}
        aria-labelledby="ud-title"
        data-part="update-dialog"
        data-state={view}
      >
        <header className={styles.header}>
          <span className={`${styles.tile} ${tone}`}>{icon}</span>
          <div className={styles.heading}>
            <h1 id="ud-title" className={styles.title}>
              {t(title[view] ?? title.available)}
            </h1>
            <div className={styles.subtitleRow}>
              <span>{subtitle}</span>
              {jump && (
                <span className={styles.jump} data-part="update-jump">
                  {t(`update.jump.${jump}` as MessageKey)}
                </span>
              )}
            </div>
          </div>
          {canCloseDialog(phase) && (
            <button
              type="button"
              className={styles.closeBtn}
              aria-label={t(closeLabelKey(phase))}
              title={t(closeLabelKey(phase))}
              onClick={close}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </button>
          )}
        </header>

        <div className={styles.body}>
          {view === "available" && (
            <>
              {(notes.length > 0 || u.releaseUrl) && (
                <div className={styles.notes} data-part="update-notes">
                  <h2 className={styles.sectionHead}>{t("update.dialog.available.notesHeading")}</h2>
                  {notes.map((n, i) => (
                    <div key={i} className={styles.note}>
                      <span className={styles.noteDot} />
                      <span>{n}</span>
                    </div>
                  ))}
                  {releaseLink("update.dialog.available.allChanges", styles.link, "update-all-changes")}
                </div>
              )}
              <div className={styles.hint}>{t("update.dialog.available.note")}</div>
            </>
          )}

          {view === "downloading" && progress && (
            <>
              <div className={styles.progress} data-part="update-progress">
                <div className={styles.progressTop}>
                  <span className={`${styles.mono} ${styles.percent}`}>{pct}%</span>
                  <span className={styles.spacer} />
                  <span className={`${styles.mono} ${styles.transferred}`}>
                    {t("update.dialog.downloading.of", {
                      done: formatMegabytes(progress.transferred, locale),
                      total: formatMegabytes(progress.total, locale),
                    })}
                  </span>
                </div>
                <div
                  className={styles.bar}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-label={t("update.dialog.downloading.title")}
                >
                  <div className={styles.fill} style={{ width: `${pct}%` }} />
                </div>
                <div className={styles.speedRow}>
                  <span className={styles.mono}>{t("update.dialog.downloading.speed", { speed: formatSpeed(progress.bytesPerSecond, locale) })}</span>
                  {eta && (
                    <span>
                      {t(eta.unit === "s" ? "update.dialog.downloading.etaSeconds" : "update.dialog.downloading.etaMinutes", {
                        n: String(eta.value),
                      })}
                    </span>
                  )}
                </div>
              </div>
              <div className={styles.hint}>{t("update.dialog.downloading.note")}</div>
            </>
          )}

          {view === "ready" && (
            <>
              <div className={styles.text}>{t("update.dialog.ready.body", { version: version ?? "" })}</div>
              {warning.kind === "some" && (() => {
                const { parts, total } = runningParts(warning);
                const what =
                  parts.length === 2
                    ? t("update.dialog.running.and", {
                        a: t(parts[0].key, { count: String(parts[0].count) }),
                        b: t(parts[1].key, { count: String(parts[1].count) }),
                      })
                    : t(parts[0].key, { count: String(parts[0].count) });
                return (
                  <div className={`${styles.box} ${styles.boxWarn}`} role="alert" data-part="update-running-warning">
                    <IconWarnSmall />
                    <span className={styles.boxText}>
                      <span className={styles.boxStrong}>{t("update.dialog.running.title")}</span>
                      <span className={styles.boxSoft}>
                        {t(total === 1 ? "update.dialog.running.someOne" : "update.dialog.running.some", {
                          what,
                          sessions: t(sessionsKey(warning.sessions), { count: String(warning.sessions) }),
                        })}
                      </span>
                    </span>
                  </div>
                );
              })()}
              {warning.kind === "unknown" && (
                <div className={`${styles.box} ${styles.boxWarn}`} role="alert" data-part="update-running-warning">
                  <IconWarnSmall />
                  <span className={styles.boxText}>
                    <span className={styles.boxStrong}>{t("update.dialog.running.title")}</span>
                    <span className={styles.boxSoft}>{t("update.dialog.running.unknown")}</span>
                  </span>
                </div>
              )}
              {warning.kind === "none" && (
                <div className={`${styles.box} ${styles.boxOk}`} data-part="update-running-warning">
                  <IconCheckSmall />
                  <span>{t("update.dialog.running.none")}</span>
                </div>
              )}
              <div className={styles.hint}>{t("update.dialog.ready.note")}</div>
            </>
          )}

          {view === "installing" && (
            <div className={styles.progress} data-part="update-installing">
              <div className={styles.bar} role="progressbar" aria-label={t("update.dialog.installing.title")} aria-busy="true">
                <div className={styles.slide} />
              </div>
              <div className={styles.text}>{t("update.dialog.installing.text")}</div>
              <div className={styles.hint}>{t("update.dialog.installing.note")}</div>
            </div>
          )}

          {view === "error" && error && copy && (
            <>
              <div className={`${styles.box} ${styles.boxError}`} role="alert" data-part="update-error-message">
                <span className={styles.boxText}>
                  <span className={styles.boxStrong}>{t(copy.titleKey)}</span>
                  <span className={styles.boxSoftError}>
                    {t(copy.textKey, {
                      percent: String(error.percent ?? ""),
                      needed: error.neededBytes !== null ? formatWholeMegabytes(error.neededBytes, locale) : "",
                      free: error.freeBytes !== null ? formatWholeMegabytes(error.freeBytes, locale) : "",
                    })}
                  </span>
                </span>
              </div>
              <div className={styles.detail}>
                <span className={styles.detailLabel}>{t("update.dialog.error.detailLabel")}</span>
                <code className={styles.code} data-part="update-error-detail">
                  {errorDetailLine(error, locale)}
                </code>
                {error.swapLogPath !== null && (
                  <code className={styles.code} data-part="update-swap-log">
                    {t("update.dialog.error.swapLog", { path: error.swapLogPath })}
                  </code>
                )}
              </div>
              <div className={styles.hint}>
                {t(copy.hintKey)} {t("update.dialog.error.suffix")}
              </div>
            </>
          )}

          {view === "manual" && (
            <>
              <div className={styles.text}>
                {t(
                  snapshot.manual?.manager === "apt"
                    ? "update.dialog.manual.bodyDeb"
                    : snapshot.manual?.manager
                      ? "update.dialog.manual.bodyRpm"
                      : "update.dialog.manual.body",
                )}
              </div>
              <div className={styles.steps} data-part="update-manual-steps">
                <div className={styles.step}>
                  <span className={styles.stepNo}>1</span>
                  <span>{t("update.dialog.manual.step1", { version: version ?? "" })}</span>
                </div>
                <div className={styles.step}>
                  <span className={styles.stepNo}>2</span>
                  <span className={styles.stepBody}>
                    <span>{snapshot.manual?.command ? t("update.dialog.manual.step2") : t("update.dialog.manual.step2NoCommand")}</span>
                    {snapshot.manual?.command && (
                      <span className={styles.command}>
                        <code className={styles.commandText}>{snapshot.manual.command}</code>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSmall}`}
                          onClick={() => {
                            void navigator.clipboard?.writeText(snapshot.manual?.command ?? "").then(() => setCopied(true));
                          }}
                        >
                          {copied ? t("update.dialog.manual.copied") : t("update.dialog.manual.copy")}
                        </button>
                      </span>
                    )}
                  </span>
                </div>
                <div className={styles.step}>
                  <span className={styles.stepNo}>3</span>
                  <span>{t("update.dialog.manual.step3")}</span>
                </div>
              </div>
              <div className={styles.hint}>{t("update.dialog.manual.note")}</div>
            </>
          )}
        </div>

        <footer className={styles.footer}>
          {view === "available" && (
            <>
              <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={u.postpone}>
                {t("update.dialog.notNow")}
              </button>
              {primary(
                snapshot.downloadBytes !== null
                  ? t("update.dialog.downloadSize", { size: formatWholeMegabytes(snapshot.downloadBytes, locale) })
                  : t("update.dialog.download"),
                u.download,
              )}
            </>
          )}
          {view === "downloading" && (
            <>
              <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={u.cancelDownload}>
                {t("update.dialog.downloading.cancel")}
              </button>
              <button
                type="button"
                className={styles.btn}
                onClick={u.closeDialog}
                ref={(el) => void (primaryRef.current = el)}
              >
                {t("update.dialog.downloading.background")}
              </button>
            </>
          )}
          {view === "ready" && (
            <>
              <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={u.closeDialog}>
                {t("update.dialog.ready.later")}
              </button>
              {primary(t("update.dialog.ready.now"), u.restart)}
            </>
          )}
          {view === "installing" && <span className={styles.status}>{t("update.dialog.installing.status")}</span>}
          {view === "error" && (
            <>
              {releaseLink("update.dialog.releases", `${styles.btn} ${styles.btnQuiet}`, "update-releases-link")}
              {primary(t("update.dialog.error.retry"), u.retry)}
            </>
          )}
          {view === "manual" && (
            <>
              <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={u.postpone}>
                {t("update.dialog.notNow")}
              </button>
              {releaseLink("update.dialog.releases", `${styles.btn} ${styles.btnPrimary}`, "update-primary", true)}
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
