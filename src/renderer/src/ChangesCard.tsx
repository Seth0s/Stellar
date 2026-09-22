import { memo, useCallback, useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import { CardFrame } from "./CardFrame";
import { ConfirmModal } from "./ConfirmModal";
import { Icon } from "./icons";
import type { Rect } from "./board-model";
import type {
  GitAttribution,
  GitAttributionFile,
  GitSliceResult,
  GitStatus,
} from "../../preload/index";
import styles from "./ChangesCard.module.css";

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function ChangesCardInner({
  rect,
  zoom,
  zIndex,
  root,
  interactionMode,
  selected,
  reflowing,
  closing,
  displayName,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onConnectorStart,
  onSelectStart,
  screenProjected,
  panX,
  panY,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  root: string;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  displayName: string;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through, same pattern StickyCard/BrowserCard already use. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [attribution, setAttribution] = useState<GitAttribution | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GitSliceResult | null>(null);
  const [orientNotice, setOrientNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(null);
    setAttribution(null);
    setResult(null);
    setSelectedPaths(new Set());
    const [nextStatus, nextAttribution] = await Promise.all([
      window.git.status(root),
      window.git.attribution(root),
    ]);
    setStatus(nextStatus);
    setAttribution(nextAttribution);
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const files = attribution?.files ?? [];
  const attrOf = (path: string): GitAttributionFile | undefined =>
    files.find((f) => f.path === path);
  const gates = attribution?.gates ?? [];

  function toggle(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** O MODO ORIENTADO: pede ao main o MESMO plano, sem executar, e copia os
   * comandos. Recusar a verificação não deixa o humano sem nada. */
  async function copyCommands() {
    const plan = await window.git.slicePlan(root, [...selectedPaths]);
    if (!plan.ok) {
      setOrientNotice(plan.error);
      return;
    }
    const text = [
      `# fatia por ${selectedPaths.size} arquivo(s) — via de cada um:`,
      ...plan.routes.map(
        (r) => `#   ${r.route === "tracked-patch" ? "tracked " : "untracked"} ${r.path}`,
      ),
      ...plan.commands.map((c) => c.command),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setOrientNotice(t("changes.slice.copied"));
    } catch {
      setOrientNotice(text);
    }
  }

  async function runVerification() {
    setConfirming(false);
    setBusy(true);
    const res = await window.git.verifySlice(root, [...selectedPaths]);
    setBusy(false);
    setResult(res);
  }

  const verdictOf = (r: GitSliceResult): string => {
    if (!r.ok) return t("changes.slice.failed", { error: r.error });
    if (r.outcome.verdict === "compila") return t("changes.slice.verdictOk");
    if (r.outcome.verdict === "nao-compila") return t("changes.slice.verdictNo");
    return t("changes.slice.verdictMounted");
  };

  return (
    <CardFrame
      className=""
      kind="changes"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      displayName={displayName}
      onRename={onRename}
      interactionMode={interactionMode}
      selected={selected}
      accent="var(--accent-changes)"
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="changes" size={14} />
          </span>
          <span className="card-head-actions">
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
      footerContent={root}
    >
      <div className={styles.changesCardBody}>
        {!status && <div className={styles.changesMsg}>{t("common.loading")}</div>}
        {status && !status.repo && <div className={styles.changesMsg}>{t("changes.notGit")}</div>}
        {status && status.repo && (
          <>
            <div className={styles.changesHeader}>
              <span>{status.branch}</span>
              <span className="changes-totals">
                <span className={styles.changesIns}>+{status.insertions}</span>{" "}
                <span className={styles.changesDel}>−{status.deletions}</span>
              </span>
              <button onClick={() => void refresh()}>{t("changes.refresh")}</button>
            </div>

            {/* O LIMITE, declarado onde a decisão acontece (não em rodapé). */}
            {selectedPaths.size > 0 && (
              <div className={styles.sliceWarning} data-role="changes-file-granularity">
                {t("changes.slice.fileGranularity", { count: selectedPaths.size })}
              </div>
            )}

            {attribution?.silentCards && attribution.silentCards.length > 0 && (
              <div className={styles.sliceWarning} data-role="changes-silent-cards">
                {t("changes.slice.silentCards", {
                  count: attribution.silentCards.length,
                  who: attribution.silentCards.map((c) => c.label ?? c.cardId).join(", "),
                })}
              </div>
            )}

            {attribution?.unreadableReports && attribution.unreadableReports.length > 0 && (
              <div className={styles.sliceWarning} data-role="changes-unreadable">
                {t("changes.slice.unreadable", {
                  count: attribution.unreadableReports.length,
                  who: attribution.unreadableReports
                    .map((r) => `${r.cardId} (${r.shape})`)
                    .join(", "),
                })}
              </div>
            )}

            <div className={styles.changesList}>
              {status.entries.length === 0 && (
                <div className={styles.changesMsg}>{t("changes.clean")}</div>
              )}
              {status.entries.map((entry) => {
                const attr = attrOf(entry.path);
                return (
                  <div
                    className={styles.changesEntry}
                    key={entry.path}
                    data-role="changes-entry"
                    data-path={entry.path}
                  >
                    <input
                      type="checkbox"
                      data-role="changes-select"
                      checked={selectedPaths.has(entry.path)}
                      onChange={() => toggle(entry.path)}
                    />
                    <span className={styles.changesEntryStatus}>{entry.status}</span>
                    <span className={styles.changesEntryPath} title={entry.path}>
                      {entry.path}
                    </span>
                    <span className={styles.changesIns}>+{entry.insertions}</span>
                    <span className={styles.changesDel}>−{entry.deletions}</span>
                    {attr && (
                      <span
                        className={styles.attribution}
                        data-role="changes-attribution"
                        data-state={attr.state}
                      >
                        {attr.state === "declared" &&
                          t("changes.attribution.declared", {
                            who: attr.declared[0].label ?? attr.declared[0].cardId,
                          })}
                        {attr.state === "disputed" &&
                          t("changes.attribution.disputed", {
                            count: attr.declared.length,
                            who: attr.declared.map((c) => c.label ?? c.cardId).join(", "),
                          })}
                        {attr.state === "window" &&
                          (attr.window && attr.window.cardIds.length > 0
                            ? t("changes.attribution.window", {
                                from: new Date(attr.window.from).toLocaleTimeString(),
                                to: new Date(attr.window.to).toLocaleTimeString(),
                                count: attr.window.cardIds.length,
                              })
                            : t("changes.attribution.windowNobody", {
                                from: new Date(attr.window?.from ?? 0).toLocaleTimeString(),
                                to: new Date(attr.window?.to ?? 0).toLocaleTimeString(),
                              }))}
                        {attr.state === "mention" &&
                          t("changes.attribution.mention", {
                            who: attr.mentions.map((m) => m.label ?? m.cardId).join(", "),
                          })}
                        {attr.state === "unknown" && t("changes.attribution.unknown")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {gates.length > 0 && (
              <div className={styles.sliceNote} data-role="changes-gates">
                {t("changes.slice.gates", { gates: gates.join(" · ") })}
              </div>
            )}
            {gates.length === 0 && status.entries.length > 0 && (
              <div className={styles.sliceNote} data-role="changes-no-gates">
                {t("changes.slice.noGates")}
              </div>
            )}
            {/* O QUE CADA GATE COBRE: só o medido. A fonte única de cobertura
                vem da task 9870a781; até lá, o card não inventa. */}
            <div className={styles.sliceNote} data-role="changes-gate-coverage">
              {t("changes.slice.gateCoverage")}
            </div>

            <div className={styles.sliceActions}>
              <button
                type="button"
                className="primary"
                data-role="changes-verify"
                disabled={busy || selectedPaths.size === 0}
                onClick={() => setConfirming(true)}
              >
                {busy ? t("changes.slice.running") : t("changes.slice.verify")}
              </button>
              <button
                type="button"
                className="ghost"
                data-role="changes-orient"
                disabled={busy || selectedPaths.size === 0}
                onClick={() => void copyCommands()}
              >
                {t("changes.slice.orient")}
              </button>
            </div>

            {orientNotice && (
              <div className={styles.sliceNote} data-role="changes-orient-notice">
                {orientNotice}
              </div>
            )}

            {result && (
              <div className={styles.sliceResult} data-role="changes-slice-result">
                <strong>{verdictOf(result)}</strong>
                {result.ok && (
                  <>
                    <div className={styles.sliceNote}>
                      {t("changes.slice.routes")}{" "}
                      {result.outcome.routes
                        .map(
                          (r) =>
                            `${r.path} (${t(r.route === "tracked-patch" ? "changes.slice.routeTracked" : "changes.slice.routeUntracked")})`,
                        )
                        .join(" · ")}
                    </div>
                    <div className={styles.sliceNote}>
                      {result.outcome.cleaned
                        ? t("changes.slice.cleaned")
                        : t("changes.slice.cleanupFailed", {
                            error: result.outcome.cleanupError ?? "",
                          })}
                    </div>
                    {result.outcome.refused && (
                      <div className={styles.sliceNote}>{result.outcome.refused}</div>
                    )}
                    {result.outcome.steps
                      .filter((s) => !s.ok)
                      .map((s, index) => (
                        <pre
                          className={styles.sliceStep}
                          key={`${s.kind}-${index}`}
                          data-role="changes-slice-step"
                        >
                          {`${s.command}\nexit ${s.exitCode}\n${s.stdoutTail}\n${s.stderrTail}`.trim()}
                        </pre>
                      ))}
                  </>
                )}
              </div>
            )}

            {confirming && (
              <ConfirmModal
                title={t("changes.slice.confirmTitle")}
                message={t("changes.slice.confirmMessage", {
                  count: selectedPaths.size,
                  root,
                  gates: gates.length > 0 ? gates.join(" · ") : t("changes.slice.noGates"),
                })}
                confirmLabel={t("changes.slice.confirm")}
                onConfirm={() => void runVerification()}
                onCancel={() => setConfirming(false)}
              />
            )}
          </>
        )}
      </div>
    </CardFrame>
  );
}

export const ChangesCard = memo(ChangesCardInner);
