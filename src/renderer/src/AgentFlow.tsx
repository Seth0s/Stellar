/**
 * The "Novo agente" flow — who runs (providers with their quota), then how to
 * open it (folder, model, effort, session, extra instructions). One piece of UI
 * shared by the rail's panel and the right-click menu's side panel, so the two
 * never drift. It only reads and sets the form values it is given; creating the
 * card stays with the caller.
 */

import { providerAccentVar } from "./provider-icon-map";
import { effortLabel, type AgentFormValues, type AgentProviderRow } from "./agent-flow-model";
import { t } from "../../shared/i18n";
import styles from "./Rail.module.css";

/** Step 1 — who runs. */
export function AgentWhoStep({
  rows,
  onPick,
  back,
}: {
  rows: AgentProviderRow[];
  onPick: (row: AgentProviderRow) => void;
  /** Link above the list (the rail's "‹ Novo card"); none inside the menu's panel. */
  back?: { label: string; onClick: () => void };
}) {
  return (
    <>
      {back && (
        <button type="button" className={styles.back} onClick={back.onClick}>
          ‹ {back.label}
        </button>
      )}
      <span className={styles.sectionHead}>{t("rail.v3.whoRuns")}</span>
      <div className={styles.section} style={{ gap: 6 }} data-role="agent-who-list">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            data-provider={row.id}
            className={`${styles.tile} ${styles.tileRow}${row.disabled ? ` ${styles.tileRowDisabled}` : ""}`}
            disabled={row.disabled}
            onClick={() => onPick(row)}
          >
            <span
              className={`${styles.providerDot}${row.id === "bash" ? ` ${styles.providerDotBash}` : ""}`}
              style={row.id === "bash" ? undefined : { background: providerAccentVar(row.id) }}
            />
            <span className={styles.providerName}>{row.label}</span>
            {row.quota && (
              <span className={`${styles.providerQuota}${row.quota.warn ? ` ${styles.providerQuotaWarn}` : ""}`}>{row.quota.text}</span>
            )}
          </button>
        ))}
      </div>
    </>
  );
}

/** Step 2 — how to open it. */
export function AgentHowStep({
  form,
  pickedLabel,
  effortValues,
  onBack,
  onCreate,
}: {
  form: AgentFormValues;
  pickedLabel: string;
  effortValues: string[];
  onBack: () => void;
  onCreate: () => void;
}) {
  const showAgentFields = form.newProvider !== "bash";
  const mode: "new" | "continue" | "resume" = form.newResumeId.trim() ? "resume" : form.newContinueLast ? "continue" : "new";
  function setMode(next: "new" | "continue" | "resume") {
    if (next === "new") {
      form.setNewContinueLast(false);
      form.setNewResumeId("");
    } else if (next === "continue") {
      form.setNewContinueLast(true);
      form.setNewResumeId("");
    } else {
      form.setNewContinueLast(false);
      if (!form.newResumeId.trim()) form.setNewResumeId("");
    }
  }
  return (
    <>
      <button type="button" className={styles.back} onClick={onBack}>
        ‹ {pickedLabel}
      </button>
      <label className={styles.fieldLabel}>
        {t("rail.v3.label.folder")}
        <input className={`${styles.field} ${styles.fieldMono}`} value={form.newCwd} onChange={(e) => form.setNewCwd(e.target.value)} />
      </label>
      {showAgentFields && (
        <>
          <div className={styles.formGrid}>
            <label className={styles.fieldLabel}>
              {t("rail.v3.label.model")}
              <select className={styles.field} value={form.newModel} onChange={(e) => form.setNewModel(e.target.value)}>
                <option value="">{t("rail.providerDefault")}</option>
                <option value="Sonnet 5.5">Sonnet 5.5</option>
                <option value="Opus 5.5">Opus 5.5</option>
              </select>
            </label>
            <label className={styles.fieldLabel}>
              {t("rail.v3.label.effort")}
              <select className={styles.field} value={form.newEffort} onChange={(e) => form.setNewEffort(e.target.value)}>
                <option value="">{t("rail.providerDefault")}</option>
                {(effortValues.length > 0 ? effortValues : ["alto", "médio", "baixo"]).map((v) => (
                  <option key={v} value={v}>
                    {effortLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className={styles.sectionHead}>{t("rail.v3.session")}</span>
          <div className={styles.sessionList}>
            <label className={styles.sessionOption}>
              <input type="radio" name="agent-flow-session" checked={mode === "new"} onChange={() => setMode("new")} />
              {t("rail.v3.session.new")}
            </label>
            <label className={styles.sessionOption}>
              <input type="radio" name="agent-flow-session" checked={mode === "continue"} onChange={() => setMode("continue")} />
              {t("rail.v3.session.continue")}
            </label>
            <label className={styles.sessionOption}>
              <input type="radio" name="agent-flow-session" checked={mode === "resume"} onChange={() => setMode("resume")} />
              {t("rail.v3.session.resume")}
            </label>
          </div>
          {mode === "resume" && (
            <input
              className={styles.field}
              value={form.newResumeId}
              placeholder={t("rail.label.resumeId")}
              onChange={(e) => form.setNewResumeId(e.target.value)}
            />
          )}
          <label className={styles.fieldLabel}>
            <span>
              {t("rail.v3.label.extra")} <span className={styles.fieldOptional}>{t("rail.v3.label.optional")}</span>
            </span>
            <textarea
              className={`${styles.field} ${styles.fieldArea}`}
              value={form.newSystemPrompt}
              placeholder={t("rail.v3.label.extraPlaceholder")}
              onChange={(e) => form.setNewSystemPrompt(e.target.value)}
            />
          </label>
        </>
      )}
      <div className={styles.actions}>
        <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={onBack}>
          {t("rail.v3.back")}
        </button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-role="agent-flow-create" onClick={onCreate}>
          {t("rail.v3.openCard")} <span className={`${styles.kbd} ${styles.btnKbd}`}>⏎</span>
        </button>
      </div>
    </>
  );
}
