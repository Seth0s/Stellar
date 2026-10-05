import { useCallback, useEffect, useState } from "react";
import { t, getLocale } from "../../shared/i18n";
import type {
  WorkHomeConflictChoice,
  WorkHomeConflictInfo,
  WorkHomePlanInfo,
  WorkHomePushOutcome,
  WorkHomeStatusInfo,
  WorkHomeTool,
  WorkHomeToolCounts,
} from "../../preload/index";
import { canWrite, decidePlanAccess, describePlanFailure } from "./PlanAccess";
import { PlanNotice } from "./PlanGate";
import { useCloudPlan, usePlansUrl } from "./PlanHooks";
import styles from "./WorkHomePage.module.css";

const TOOLS: WorkHomeTool[] = ["claude", "codex", "cursor", "gemini", "stellar"];

const TOOL_CLASS: Record<WorkHomeTool, string> = {
  claude: styles.toolClaude,
  codex: styles.toolCodex,
  cursor: styles.toolCursor,
  gemini: styles.toolGemini,
  stellar: styles.toolStellar,
};

const TOOL_INITIAL: Record<WorkHomeTool, string> = {
  claude: "C",
  codex: "X",
  cursor: "R",
  gemini: "A",
  stellar: "S",
};

const ACTION_TAG: Record<string, { className: string; key: "workhome.incoming.add" | "workhome.incoming.update" | "workhome.incoming.pending" | "workhome.incoming.conflict" | "workhome.incoming.neutral" }> = {
  add: { className: styles.tagAdd, key: "workhome.incoming.add" },
  update: { className: styles.tagUpdate, key: "workhome.incoming.update" },
  pending: { className: styles.tagPending, key: "workhome.incoming.pending" },
  conflict: { className: styles.tagConflict, key: "workhome.incoming.conflict" },
};

function actionTag(action: string): { className: string; label: string } {
  const entry = ACTION_TAG[action];
  if (!entry) return { className: styles.tagNeutral, label: t("workhome.incoming.neutral") };
  return { className: entry.className, label: t(entry.key) };
}

function whenLabel(ms: number | null): string {
  return ms === null ? t("workhome.never") : new Date(ms).toLocaleString(getLocale());
}

/**
 * Work home page (tela 9). Status, what travels per tool, what never leaves
 * the machine, and what arrived from another machine. The logic lives in the
 * main process; this screen reads state and fires actions. Per-tool counts
 * come from the collector; a revision history is not offered because no IPC
 * exposes one yet.
 */
export function WorkHomePage() {
  const [status, setStatus] = useState<WorkHomeStatusInfo | null>(null);
  const [counts, setCounts] = useState<Partial<Record<WorkHomeTool, WorkHomeToolCounts>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<WorkHomePlanInfo | null>(null);
  const [pullChoices, setPullChoices] = useState<Record<string, WorkHomeConflictChoice>>({});
  const [pushConflicts, setPushConflicts] = useState<{ out: Extract<WorkHomePushOutcome, { kind: "conflicts" }>; choices: Record<string, WorkHomeConflictChoice> } | null>(null);
  const [folderInput, setFolderInput] = useState("");

  const { plan: cloudPlan } = useCloudPlan();
  const plansUrl = usePlansUrl();
  // The sync right is paid: on Free the page explains what Pro unlocks and
  // never calls the server; on an expired plan only reads are allowed.
  const syncAccess = decidePlanAccess(cloudPlan, "sync");
  const canPreviewHome = syncAccess.kind === "granted" || syncAccess.kind === "unknown" || (syncAccess.kind === "expired" && syncAccess.state === "grace");
  const canWriteHome = canWrite(syncAccess);
  const proactiveNotice = syncAccess.kind === "upgrade" || syncAccess.kind === "expired" ? syncAccess : null;
  // A refusal of a feature that is not granted becomes the standard plan notice,
  // never a raw server error; an unknown plan shows no notice until the server refuses.
  const errorDisplay = error ? describePlanFailure(syncAccess, error) : null;
  const planNotice = proactiveNotice ?? (errorDisplay?.kind === "plan" ? errorDisplay.access : null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.workhome.status());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void window.workhome
      .toolSummary()
      .then((res) => {
        if (res.ok) setCounts(res.tools);
      })
      .catch(() => {});
  }, []);

  function toolDesc(tool: WorkHomeTool): string {
    const c = counts[tool];
    if (!c) return t(`workhome.tool.${tool}.desc` as `workhome.tool.${WorkHomeTool}.desc`);
    const parts: string[] = [];
    if (c.skills > 0) parts.push(t("workhome.counts.skills", { n: c.skills }));
    if (c.agents > 0) parts.push(t("workhome.counts.agents", { n: c.agents }));
    if (c.memories > 0) parts.push(t("workhome.counts.memories", { n: c.memories }));
    if (c.rules > 0) parts.push(t("workhome.counts.rules", { n: c.rules }));
    return parts.length > 0 ? parts.join(" · ") : t("workhome.counts.empty");
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch {
      setError(t("workhome.error.generic"));
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function handleSyncNow() {
    await run(async () => {
      const out = await window.workhome.syncNow();
      if (!out.ok) {
        setError(out.error);
        return;
      }
      if (out.kind === "conflicts") {
        setPushConflicts({ out, choices: {} });
        return;
      }
      setNote(`${t("workhome.revision", { revision: String(out.revision) })} · ${t("workhome.copied", { n: String(out.uploaded) })}`);
    });
  }

  async function handlePreview() {
    await run(async () => {
      const res = await window.workhome.preview();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPlan(res.plan);
      setPullChoices({});
    });
  }

  async function handleApply() {
    await run(async () => {
      const res = await window.workhome.apply(pullChoices);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const dir = res.result.backupDir;
      setNote(dir ? t("workhome.backup", { dir }) : t("workhome.nothing"));
      setPlan(null);
      setPullChoices({});
    });
  }

  async function handleResolve() {
    if (!pushConflicts) return;
    await run(async () => {
      const out = await window.workhome.resolveConflicts({
        manifest: pushConflicts.out.manifest,
        conflicts: pushConflicts.out.conflicts,
        remote: pushConflicts.out.remote,
        revision: pushConflicts.out.revision,
        choices: pushConflicts.choices,
      });
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setPushConflicts(null);
      setNote(t("workhome.revision", { revision: String(out.kind === "pushed" ? out.revision : 0) }));
    });
  }

  function toggleTool(tool: WorkHomeTool, on: boolean) {
    const next = new Set(status?.enabledTools ?? TOOLS);
    if (on) next.add(tool);
    else next.delete(tool);
    void run(async () => setStatus(await window.workhome.setTools([...next])));
  }

  const loggedIn = status?.loggedIn ?? false;
  const items = plan?.items ?? [];
  const changeCount = items.filter((i) => i.action === "add" || i.action === "update").length;
  const syncedText =
    status?.lastRevision != null ? t("workhome.status.synced", { revision: String(status.lastRevision), when: whenLabel(status.lastSyncAt) }) : t("workhome.status.ready");
  const syncStatusText = !loggedIn
    ? t("workhome.notLoggedIn")
    : syncAccess.kind === "granted"
      ? `${syncedText} · ${t("plan.sync.via", { source: t(syncAccess.source === "team" ? "plan.origin.team" : "plan.origin.account") })}`
      : syncAccess.kind === "upgrade"
        ? t("workhome.plan.free")
        : syncAccess.kind === "expired"
          ? t("plan.expired.title")
          : syncedText;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleCol}>
          <h1 className={styles.title}>{t("workhome.title")}</h1>
          <div className={styles.statusLine}>
            <span className={`${styles.statusDot}${loggedIn && (syncAccess.kind === "granted" || syncAccess.kind === "unknown") ? "" : ` ${styles.statusDotOff}`}`} />
            {syncStatusText}
          </div>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primaryBtn} disabled={busy || !loggedIn || !canWriteHome} onClick={() => void handleSyncNow()}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 2.5v2.8H8.7" />
            </svg>
            {t("workhome.syncNow")}
          </button>
          <button type="button" className={styles.ghostBtn} disabled={busy || !loggedIn || !canPreviewHome} onClick={() => void handlePreview()}>
            {t("workhome.preview")}
          </button>
        </div>
      </div>

      {loggedIn && planNotice ? <PlanNotice access={planNotice} plansUrl={plansUrl} /> : null}

      {!loggedIn ? (
        <div className={styles.muted}>{t("workhome.notLoggedIn")}</div>
      ) : (
        <>
          <div className={styles.columns}>
            <section className={styles.card} aria-labelledby="wh-travel">
              <div className={styles.cardHead}>
                <h2 id="wh-travel" className={styles.cardTitle}>{t("workhome.travel.title")}</h2>
                <span className={styles.cardSub}>{t("workhome.travel.sub")}</span>
              </div>
              {TOOLS.map((tool) => {
                const root = status?.toolRoots?.[tool] ?? null;
                return (
                  <label key={tool} className={styles.tool}>
                    <span className={`${styles.toolIcon} ${TOOL_CLASS[tool]}`}>{TOOL_INITIAL[tool]}</span>
                    <span className={styles.toolText}>
                      <span className={styles.toolName}>{t(`workhome.tool.${tool}` as `workhome.tool.${WorkHomeTool}`)}</span>
                      <span className={styles.toolDesc} title={root ?? undefined}>
                        {toolDesc(tool)}
                      </span>
                    </span>
                    <input
                      className={styles.switch}
                      type="checkbox"
                      checked={status?.enabledTools.includes(tool) ?? false}
                      disabled={busy}
                      aria-label={t("workhome.toggle", { tool: t(`workhome.tool.${tool}` as `workhome.tool.${WorkHomeTool}`) })}
                      onChange={(e) => toggleTool(tool, e.target.checked)}
                    />
                  </label>
                );
              })}
              <div className={styles.confidential}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--v2-good)" strokeWidth="1.4" aria-hidden="true">
                  <path d="M8 1.8l5 2v4.1c0 3-2.1 5.3-5 6.3-2.9-1-5-3.3-5-6.3V3.8z" />
                </svg>
                <span>{t("workhome.confidential")}</span>
              </div>
              <div className={styles.cardHead}>
                <span className={styles.cardSub}>{t("workhome.workFolders")}</span>
                <ul className={styles.folders}>
                  {(status?.workFolders ?? []).length === 0 ? (
                    <li className={styles.emptyNote}>{t("workhome.folders.none")}</li>
                  ) : (
                    status?.workFolders.map((f) => (
                      <li key={f} className={styles.folder} title={f}>
                        {f}
                      </li>
                    ))
                  )}
                </ul>
                <div className={styles.row}>
                  <input
                    id="wh-folder"
                    className={styles.input}
                    placeholder={t("workhome.folderPlaceholder")}
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    disabled={busy || folderInput.trim() === ""}
                    onClick={() => {
                      const next = [...(status?.workFolders ?? []), folderInput.trim()];
                      setFolderInput("");
                      void run(async () => setStatus(await window.workhome.setWorkFolders(next)));
                    }}
                  >
                    {t("workhome.addFolder")}
                  </button>
                </div>
              </div>
            </section>

            <section className={styles.incoming} aria-labelledby="wh-incoming">
              <div className={styles.incomingHead}>
                <h2 id="wh-incoming" className={styles.incomingTitle}>{t("workhome.incoming.title")}</h2>
              </div>
              {pushConflicts ? (
                <>
                  <span className={styles.incomingMeta}>{t("workhome.conflict.title")}</span>
                  <ul className={styles.items}>
                    {pushConflicts.out.conflicts.map((c: WorkHomeConflictInfo) => (
                      <li key={c.path} className={styles.item}>
                        <span className={`${styles.tag} ${styles.tagConflict}`}>{t("workhome.incoming.conflict")}</span>
                        <span className={styles.path} title={c.path}>
                          {c.path}
                        </span>
                        <span className={styles.choices}>
                          {(["local", "remote", "both"] as const).map((ch) => (
                            <button
                              key={ch}
                              type="button"
                              className={`${styles.chip}${pushConflicts.choices[c.path] === ch ? ` ${styles.chipOn}` : ""}`}
                              onClick={() => setPushConflicts((prev) => (prev ? { ...prev, choices: { ...prev.choices, [c.path]: ch } } : prev))}
                            >
                              {ch === "local" ? t("workhome.keepLocal") : ch === "remote" ? t("workhome.keepRemote") : t("workhome.keepBoth")}
                            </button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className={styles.footRow}>
                    <span className={styles.footNote}>{t("workhome.backupNote")}</span>
                    <button type="button" className={styles.primaryBtn} disabled={busy || !canWriteHome} onClick={() => void handleResolve()}>
                      {t("workhome.apply")}
                    </button>
                  </div>
                </>
              ) : items.length === 0 ? (
                <span className={styles.emptyNote}>{t("workhome.incoming.none")}</span>
              ) : (
                <>
                  <ul className={styles.items}>
                    {items.map((i) => {
                      const tag = actionTag(i.action);
                      return (
                        <li key={i.path} className={styles.item}>
                          <span className={`${styles.tag} ${tag.className}`}>{tag.label}</span>
                          <span className={styles.path} title={i.targetPath ?? i.path}>
                            {i.path}
                          </span>
                          {i.action === "conflict" ? (
                            <span className={styles.choices}>
                              {(["local", "remote", "both"] as const).map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  className={`${styles.chip}${pullChoices[i.path] === c ? ` ${styles.chipOn}` : ""}`}
                                  onClick={() => setPullChoices((prev) => ({ ...prev, [i.path]: c }))}
                                >
                                  {c === "local" ? t("workhome.keepLocal") : c === "remote" ? t("workhome.keepRemote") : t("workhome.keepBoth")}
                                </button>
                              ))}
                            </span>
                          ) : null}
                          {i.action === "pending" ? (
                            <button type="button" className={styles.chip} onClick={() => document.getElementById("wh-folder")?.focus()}>
                              {t("workhome.pointFolder")}
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <div className={styles.footRow}>
                    <span className={styles.footNote}>{t("workhome.backupNote")}</span>
                    <button type="button" className={styles.primaryBtn} disabled={busy || changeCount === 0 || !canWriteHome} onClick={() => void handleApply()}>
                      {t("workhome.applyCount", { n: changeCount })}
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>

          {note ? <div className={styles.note}>{note}</div> : null}
          {errorDisplay?.kind === "raw" ? <div className={styles.error}>{errorDisplay.error}</div> : null}
        </>
      )}
    </div>
  );
}
