/**
 * Screen 18 — import wizard (Fonte → Conectar → Mapear → Revisar e importar).
 * Follows docs/design/app-v2/prototipo/Import.dc.html.
 */

import { useCallback, useEffect, useState } from "react";
import type { TeamImportJobInfo, TeamImportPreviewInfo, TeamIntegrationInfo, TeamRole } from "../../preload/index";
import { t, type MessageKey } from "../../shared/i18n";
import {
  IMPORT_SOURCES,
  apiMappingFromRows,
  canManageImport,
  defaultSlackMapping,
  duplicateLabel,
  selectedImportCount,
  togglePreviewSelection,
  updateMappingTarget,
  wizardStepState,
  type ImportPreviewRow,
  type ImportSourceId,
  type MappingRow,
  type MappingTarget,
} from "./import-decisions";
import { findByKind, isConnected } from "./integration-decisions";
import { LocalBoardImport, type LocalImportStep } from "./LocalBoardImport";
import styles from "./ImportWizard.module.css";

export type ImportWizardProps = {
  teamId: string;
  teamName: string;
  role: TeamRole | null;
  onBack: () => void;
  /** Opens the team board; the local-board import offers it when it ends. */
  onOpenTeamBoard?: () => void;
};

const STEP_LABELS = [
  { n: 1 as const, key: "teamImport.step.source" as const },
  { n: 2 as const, key: "teamImport.step.connect" as const },
  { n: 3 as const, key: "teamImport.step.map" as const },
  { n: 4 as const, key: "teamImport.step.review" as const },
];

/** The local-board source has its own steps: it connects nothing and maps nothing. */
const LOCAL_STEP_LABELS = [
  { n: 1 as const, key: "teamImport.step.source" as const },
  { n: 2 as const, key: "teamImport.local.step.boards" as const },
  { n: 3 as const, key: "teamImport.local.step.preview" as const },
  { n: 4 as const, key: "teamImport.local.step.run" as const },
];

function logoClass(tone: string): string {
  if (tone === "slack") return styles.logoSlack;
  if (tone === "linear") return styles.logoLinear;
  if (tone === "jira") return styles.logoJira;
  if (tone === "github") return styles.logoGithub;
  if (tone === "local") return styles.logoLocal;
  return styles.logoCsv;
}

export function ImportWizard({ teamId, teamName, role, onBack, onOpenTeamBoard }: ImportWizardProps) {
  const canManage = canManageImport(role);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [source, setSource] = useState<ImportSourceId>("slack");
  const [integrations, setIntegrations] = useState<TeamIntegrationInfo[]>([]);
  const [channel] = useState("backlog");
  const [reaction] = useState("ticket");
  const [period, setPeriod] = useState<"30d" | "all">("30d");
  const [ruleMsg, setRuleMsg] = useState<"reaction" | "todo" | "all">("reaction");
  const [mapping, setMapping] = useState<MappingRow[]>(() => defaultSlackMapping());
  const [fileData, setFileData] = useState("");
  const [continueImport, setContinueImport] = useState(true);
  const [preview, setPreview] = useState<ImportPreviewRow[]>([]);
  const [previewMeta, setPreviewMeta] = useState<Pick<TeamImportPreviewInfo, "total" | "duplicates"> | null>(null);
  const [job, setJob] = useState<TeamImportJobInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local-board source: the panel owns its steps and reports them for the aside.
  const [localStep, setLocalStep] = useState<LocalImportStep>(2);
  const [localFinished, setLocalFinished] = useState(false);
  const [localBoardCount, setLocalBoardCount] = useState<number | null>(null);
  const isLocal = source === "local";
  const inLocalFlow = isLocal && step >= 2;

  const loadIntegrations = useCallback(async () => {
    const res = await window.team.listIntegrations(teamId);
    if (res.ok) setIntegrations(res.integrations);
  }, [teamId]);

  useEffect(() => {
    void loadIntegrations();
  }, [loadIntegrations]);

  const kindForApi = source === "local" ? "json" : source === "csv" ? (fileData.trim().startsWith("[") || fileData.trim().startsWith("{") ? "json" : "csv") : source;
  const integKind = source === "csv" || source === "local" ? null : source;
  const connected = integKind ? isConnected(findByKind(integrations, integKind)) : true;

  const buildBody = (): Record<string, unknown> => {
    const map = source === "csv" || source === "slack" ? apiMappingFromRows(mapping) : apiMappingFromRows(mapping);
    return {
      kind: kindForApi,
      rule: {
        channel: source === "slack" ? channel : "",
        reaction: source === "slack" ? (ruleMsg === "reaction" ? reaction : "") : "",
        limit: period === "30d" ? 200 : 0,
      },
      mapping: map,
      data: source === "csv" ? fileData : "",
      continue: continueImport,
    };
  };

  const runPreview = async () => {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    const res = await window.team.previewImport(teamId, buildBody());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPreview(
      res.preview.items.map((i) => ({
        title: i.title,
        externalId: i.externalId,
        duplicate: i.duplicate,
        existingRef: i.existingRef,
        meta: i.meta,
        selected: i.selected,
      })),
    );
    setPreviewMeta({ total: res.preview.total, duplicates: res.preview.duplicates });
  };

  const runImport = async () => {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    const res = await window.team.createImport(teamId, buildBody());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setJob(res.job);
  };

  const connectSource = async () => {
    if (!canManage || !integKind) return;
    setBusy(true);
    setError(null);
    if (integKind === "slack") {
      const res = await window.team.startIntegrationOAuth(teamId, "slack");
      setBusy(false);
      if (!res.ok) setError(res.error);
      return;
    }
    // Credential kinds: open connect with placeholder secrets filled by smoke/fake.
    const defaults: Record<string, { config: Record<string, unknown>; secrets: Record<string, string> }> = {
      github: { config: { repo: "Seth0s/demo", label: "stellar" }, secrets: { access_token: "fake", webhook_secret: "wh" } },
      linear: { config: { project_id: "proj-1" }, secrets: { api_key: "fake", webhook_secret: "wh" } },
      jira: { config: { base_url: "https://example.atlassian.net", email: "a@b.c", jql: "project = DEMO" }, secrets: { api_token: "fake" } },
    };
    const body = defaults[integKind];
    if (!body) {
      setBusy(false);
      return;
    }
    const res = await window.team.connectIntegration(teamId, integKind, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else await loadIntegrations();
  };

  useEffect(() => {
    return window.team.onIntegrationOAuth(() => {
      void loadIntegrations();
    });
  }, [loadIntegrations]);

  const selectedCount = selectedImportCount(preview);
  const sourceOpt = IMPORT_SOURCES.find((s) => s.id === source)!;

  return (
    <div className={styles.screen} data-part="import-wizard">
      <div className={styles.body}>
        <aside className={styles.aside} aria-label={t("teamImport.stepsAria")}>
          <div className={styles.steps}>
            {(isLocal ? LOCAL_STEP_LABELS : STEP_LABELS).map((s) => {
              const asideStep = inLocalFlow ? (localFinished && localStep === 4 ? 5 : localStep) : step;
              const state = wizardStepState(asideStep, s.n);
              return (
                <div
                  key={s.n}
                  className={`${styles.step} ${state === "active" ? styles.stepActive : state === "done" ? styles.stepDone : ""}`}
                  data-step={s.n}
                  data-step-state={state}
                >
                  <span className={`${styles.n} ${state === "done" ? styles.nDone : state === "active" ? styles.nActive : styles.nTodo}`}>
                    {state === "done" ? "✓" : s.n}
                  </span>
                  {t(s.key as MessageKey)}
                </div>
              );
            })}
          </div>
          <div className={styles.divider} />
          <div className={styles.sourceList}>
            <span className={styles.asideLabel}>{t("teamImport.chosenSource")}</span>
            <div className={`${styles.src} ${styles.srcOn}`} data-part="import-source-selected">
              <span className={`${styles.logo} ${logoClass(sourceOpt.tone)}`}>{sourceOpt.letter}</span>
              <span className={styles.srcMeta}>
                <span>{t(sourceOpt.labelKey as MessageKey)}</span>
                {source === "slack" ? (
                  <small>
                    workspace idy · #{channel}
                  </small>
                ) : null}
                {isLocal ? (
                  <small>
                    {localBoardCount !== null && step >= 2
                      ? t("teamImport.local.chosenSub", { n: String(localBoardCount) })
                      : t("teamImport.local.sourceSub")}
                  </small>
                ) : null}
              </span>
            </div>
            <span className={styles.asideLabel} style={{ marginTop: 8 }}>
              {t("teamImport.alsoFrom")}
            </span>
            {IMPORT_SOURCES.filter((s) => s.id !== source).map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.src}
                data-part={`import-source-${s.id}`}
                disabled={!canManage}
                onClick={() => {
                  setSource(s.id);
                  setStep(1);
                  setPreview([]);
                  setJob(null);
                  setLocalBoardCount(null);
                  if (s.id === "slack") setMapping(defaultSlackMapping());
                }}
              >
                <span className={`${styles.logo} ${logoClass(s.tone)}`}>{s.letter}</span>
                {t(s.labelKey as MessageKey)}
              </button>
            ))}
          </div>
        </aside>

        {inLocalFlow ? (
          <LocalBoardImport
            teamId={teamId}
            teamName={teamName}
            canManage={canManage}
            onProgress={(next, finished) => {
              setLocalStep(next);
              setLocalFinished(finished);
            }}
            onBoardCount={setLocalBoardCount}
            onBack={() => setStep(1)}
            onOpenTeamBoard={onOpenTeamBoard ?? onBack}
          />
        ) : (
        <main className={styles.main}>
          <div className={styles.scroll}>
            {!canManage ? <div className={styles.readonlyBanner}>{t("teamImport.memberReadonly")}</div> : null}
            {error ? <div className={styles.error}>{error}</div> : null}
            {job ? (
              <div className={styles.jobStatus} data-part="import-job-status">
                {t("teamImport.jobDone", { created: String(job.createdCount), skipped: String(job.skippedCount), status: job.status })}
              </div>
            ) : null}

            {step === 1 ? (
              <>
                <div>
                  <h1 className={styles.title}>{t("teamImport.sourceTitle")}</h1>
                  <p className={styles.lead}>{t("teamImport.sourceLead", { team: teamName })}</p>
                </div>
                <div className={styles.sourceList}>
                  {IMPORT_SOURCES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`${styles.src} ${source === s.id ? styles.srcOn : ""}`}
                      data-part={`import-pick-${s.id}`}
                      disabled={!canManage}
                      onClick={() => setSource(s.id)}
                    >
                      <span className={`${styles.logo} ${logoClass(s.tone)}`}>{s.letter}</span>
                      {t(s.labelKey as MessageKey)}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {step === 2 ? (
              <>
                <div>
                  <h1 className={styles.title}>{t("teamImport.connectTitle", { source: t(sourceOpt.labelKey as MessageKey) })}</h1>
                  <p className={styles.lead}>
                    {connected ? t("teamImport.connectReady") : t("teamImport.connectNeed")}
                  </p>
                </div>
                {source === "csv" ? (
                  <div className={styles.field}>
                    <label htmlFor="import-file">{t("teamImport.csvLabel")}</label>
                    <textarea
                      id="import-file"
                      className={styles.textarea}
                      value={fileData}
                      disabled={!canManage}
                      onChange={(e) => setFileData(e.target.value)}
                      placeholder={'title,kind\n"Fila de retries",corrigir'}
                      data-part="import-file-data"
                    />
                  </div>
                ) : (
                  <div>
                    <p className={styles.lead} data-part="import-connect-status">
                      {connected ? t("teamImport.connected") : t("teamImport.notConnected")}
                    </p>
                    {!connected && canManage ? (
                      <button type="button" className={styles.primary} data-part="import-connect-btn" disabled={busy} onClick={() => void connectSource()}>
                        {t("teamImport.connect")}
                      </button>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}

            {step === 3 ? (
              <>
                <div>
                  <h1 className={styles.title}>{t("teamImport.mapTitle")}</h1>
                  <p className={styles.lead}>{t("teamImport.mapLead", { channel, n: "214" })}</p>
                </div>
                {source === "slack" ? (
                  <div className={styles.grid2}>
                    <div className={styles.field}>
                      <label htmlFor="r1">{t("teamImport.whichMessages")}</label>
                      <select
                        id="r1"
                        className={styles.sel}
                        value={ruleMsg}
                        disabled={!canManage}
                        onChange={(e) => setRuleMsg(e.target.value as typeof ruleMsg)}
                      >
                        <option value="reaction">{t("teamImport.rule.reaction")}</option>
                        <option value="todo">{t("teamImport.rule.todo")}</option>
                        <option value="all">{t("teamImport.rule.all")}</option>
                      </select>
                    </div>
                    <div className={styles.field}>
                      <label htmlFor="r2">{t("teamImport.period")}</label>
                      <select
                        id="r2"
                        className={styles.sel}
                        value={period}
                        disabled={!canManage}
                        onChange={(e) => setPeriod(e.target.value as typeof period)}
                      >
                        <option value="30d">{t("teamImport.period.30d")}</option>
                        <option value="all">{t("teamImport.period.all")}</option>
                      </select>
                    </div>
                  </div>
                ) : null}
                <div className={styles.mapCard} data-part="import-mapping">
                  <div className={styles.mapHead}>
                    <span>{t("teamImport.mapFrom")}</span>
                    <span />
                    <span>{t("teamImport.mapTo")}</span>
                  </div>
                  {mapping.map((row) => (
                    <div key={row.sourceKey} className={styles.mapRow}>
                      <span>{row.sourceLabel}</span>
                      <span className={styles.mapArrow}>→</span>
                      <select
                        className={styles.sel}
                        aria-label={row.sourceLabel}
                        value={row.target}
                        disabled={!canManage}
                        onChange={(e) => setMapping(updateMappingTarget(mapping, row.sourceKey, e.target.value as MappingTarget))}
                      >
                        <option value="title">{t("teamImport.target.title")}</option>
                        <option value="contract">{t("teamImport.target.contract")}</option>
                        <option value="assignee">{t("teamImport.target.assignee")}</option>
                        <option value="archived">{t("teamImport.target.archived")}</option>
                        <option value="territory">{t("teamImport.target.territory")}</option>
                        <option value="kind_infer">{t("teamImport.target.kindInfer")}</option>
                        <option value="kind">{t("teamImport.target.kind")}</option>
                        <option value="priority">{t("teamImport.target.priority")}</option>
                        <option value="external_id">{t("teamImport.target.externalId")}</option>
                        <option value="ignore">{t("teamImport.target.ignore")}</option>
                      </select>
                    </div>
                  ))}
                </div>
                <div>
                  <div className={styles.previewHead}>
                    <h2>
                      {t("teamImport.previewTitle", { n: String(previewMeta?.total ?? preview.length) })}
                    </h2>
                    <span className={styles.previewHint}>
                      {t("teamImport.previewSkipped", { n: String(previewMeta?.duplicates ?? 0) })}
                    </span>
                  </div>
                  <div className={styles.mapCard} data-part="import-preview">
                    {preview.length === 0 ? (
                      <div className={styles.row}>
                        <span className={styles.rowMeta}>{t("teamImport.previewEmpty")}</span>
                      </div>
                    ) : (
                      preview.map((row) => {
                        const dup = duplicateLabel(row);
                        return (
                          <label key={row.externalId} className={`${styles.row} ${row.duplicate ? styles.rowDup : ""}`}>
                            <input
                              type="checkbox"
                              checked={row.selected && !row.duplicate}
                              disabled={row.duplicate || !canManage}
                              onChange={() => setPreview(togglePreviewSelection(preview, row.externalId))}
                            />
                            <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                              <span className={styles.rowTitle}>{row.title}</span>
                              {dup ? <span className={styles.rowDupMeta}>{dup}</span> : <span className={styles.rowMeta}>{row.meta ?? ""}</span>}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            ) : null}

            {step === 4 ? (
              <>
                <div>
                  <h1 className={styles.title}>{t("teamImport.reviewTitle")}</h1>
                  <p className={styles.lead}>{t("teamImport.reviewLead", { n: String(selectedCount) })}</p>
                </div>
                <div className={styles.mapCard}>
                  {preview
                    .filter((r) => r.selected && !r.duplicate)
                    .map((row) => (
                      <div key={row.externalId} className={styles.row}>
                        <span className={styles.rowTitle}>{row.title}</span>
                      </div>
                    ))}
                </div>
              </>
            ) : null}
          </div>

          <div className={styles.footer}>
            {step >= 3 ? (
              <label className={styles.continue}>
                <input type="checkbox" checked={continueImport} disabled={!canManage} onChange={(e) => setContinueImport(e.target.checked)} />
                {t("teamImport.continue")}
              </label>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            <button type="button" className={styles.ghost} data-part="import-back" onClick={() => (step === 1 ? onBack() : setStep((step - 1) as 1 | 2 | 3 | 4))}>
              {step === 1 ? t("teamImport.close") : t("teamImport.back")}
            </button>
            {step < 3 ? (
              <button
                type="button"
                className={styles.primary}
                data-part="import-next"
                disabled={busy || (step === 2 && source !== "csv" && !connected)}
                onClick={() => {
                  const next = (step + 1) as 1 | 2 | 3 | 4;
                  if (isLocal) {
                    setLocalStep(2);
                    setLocalFinished(false);
                  }
                  setStep(next);
                  if (next === 3) void runPreview();
                }}
              >
                {t("teamImport.next")}
              </button>
            ) : null}
            {step === 3 ? (
              <button
                type="button"
                className={styles.primary}
                data-part="import-to-review"
                disabled={busy || !canManage || preview.length === 0}
                onClick={() => setStep(4)}
              >
                {t("teamImport.reviewN", { n: String(previewMeta?.total ?? selectedCount) })}
              </button>
            ) : null}
            {step === 4 ? (
              <button type="button" className={styles.primary} data-part="import-run" disabled={busy || !canManage} onClick={() => void runImport()}>
                {t("teamImport.run", { n: String(previewMeta?.total ?? selectedCount) })}
              </button>
            ) : null}
          </div>
        </main>
        )}
      </div>
    </div>
  );
}
