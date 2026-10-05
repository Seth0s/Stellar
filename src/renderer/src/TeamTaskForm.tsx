import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import type { TeamMemberInfo, TeamSprintInfo, TeamTaskInfo } from "../../preload/index";
import { canReviewRole, memberAvatar, memberDisplayName } from "./team-board-decisions";
import {
  ASSIGNMENT_LABEL_KEY,
  KIND_HINT_KEY,
  agentPreviewLines,
  draftStorageKey,
  emptyTaskForm,
  readTemplates,
  showsDistribution,
  submitLabelKey,
  territoryConflicts,
  toLocalPrompt,
  toTeamTaskBody,
  validateTaskForm,
  whereAppearsKey,
  writeTemplates,
  type TaskAssignment,
  type TaskDestination,
  type TeamTaskFormState,
} from "./team-task-form-decisions";
import { TEAM_KIND_LABEL_KEY, TEAM_PRIORITY_LABEL_KEY } from "./team-board-decisions";
import styles from "./TeamTaskForm.module.css";

type BoardRef = { id: string; name: string };

const KINDS = ["investigar", "implementar", "corrigir", "medir", "integrar"] as const;
const PRIORITIES = ["baixa", "media", "alta", "urgente"] as const;

function formFromTask(task: TeamTaskInfo): TeamTaskFormState {
  return {
    ...emptyTaskForm(),
    destination: "team",
    title: task.title,
    kind: task.kind,
    territory: [...task.territory],
    gates: task.gates.map((g) => (typeof g === "string" ? { cmd: g, exclusive: false } : { cmd: g.cmd, exclusive: g.exclusive !== undefined })),
    reviewerId: task.reviewerId ?? "",
    provider: task.provider,
    assignment: task.assigneeId ? "person" : task.autoDispatch ? "auto" : "open",
    assigneeId: task.assigneeId ?? "",
    sprintId: task.sprintId ?? "",
    priority: task.priority,
    allowCommit: task.allowCommit,
    reportSchema: [...task.reportSchema],
    maxRetries: task.maxRetries,
  };
}

/**
 * Screen 14 — the full create/edit task form. One form, two destinations: the
 * team API or the local queue (board-only). Drafts autosave per team;
 * Ctrl+Enter submits. Everything testable lives in `team-task-form-decisions`.
 */
export function TeamTaskForm({
  teamId,
  teamName,
  boards,
  members,
  tasks,
  sprints,
  editing = null,
  editingContract = "",
  onClose,
  onCreateTeamTask,
  onUpdateTeamTask,
  onCreateLocalTask,
}: {
  teamId: string;
  teamName: string;
  boards: BoardRef[];
  members: TeamMemberInfo[];
  tasks: TeamTaskInfo[];
  sprints: TeamSprintInfo[];
  editing?: TeamTaskInfo | null;
  editingContract?: string;
  onClose: () => void;
  onCreateTeamTask: (body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  onUpdateTeamTask: (task: TeamTaskInfo, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  onCreateLocalTask: (boardId: string, prompt: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const boardId = boards[0]?.id ?? "";
  const [form, setForm] = useState<TeamTaskFormState>(() =>
    editing ? { ...formFromTask(editing), contract: editingContract } : { ...emptyTaskForm(), destination: "team" },
  );
  const [territoryDraft, setTerritoryDraft] = useState("");
  const [gateDraft, setGateDraft] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const contractRef = useRef<HTMLTextAreaElement | null>(null);

  const draftKey = draftStorageKey(teamId);

  useEffect(() => {
    if (editing) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) setForm((prev) => ({ ...prev, ...(JSON.parse(raw) as Partial<TeamTaskFormState>) }));
    } catch {
      /* unreadable draft: start fresh */
    }
  }, [draftKey, editing]);

  const persistDraft = useCallback(
    (next: TeamTaskFormState) => {
      if (editing) return;
      try {
        localStorage.setItem(draftKey, JSON.stringify(next));
        setSavedAt(Date.now());
      } catch {
        /* storage unavailable */
      }
    },
    [draftKey, editing],
  );

  function set<K extends keyof TeamTaskFormState>(key: K, value: TeamTaskFormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      persistDraft(next);
      return next;
    });
  }

  const conflicts = useMemo(() => territoryConflicts(form.territory, tasks), [form.territory, tasks]);
  const reviewers = members.filter((m) => canReviewRole(m.role));
  const templates = useMemo(() => readTemplates(teamId), [teamId]);
  const validation = validateTaskForm(form);
  const assigneeName = memberDisplayName(members, form.assigneeId);

  function addTerritory() {
    const value = territoryDraft.trim();
    if (value === "" || form.territory.includes(value)) return;
    set("territory", [...form.territory, value]);
    setTerritoryDraft("");
  }
  function addGate() {
    const cmd = gateDraft.trim();
    if (cmd === "") return;
    set("gates", [...form.gates, { cmd, exclusive: false }]);
    setGateDraft("");
  }
  function wrapContract(before: string, after = before) {
    const el = contractRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const next = `${value.slice(0, s)}${before}${value.slice(s, e)}${after}${value.slice(e)}`;
    set("contract", next);
  }

  async function submit(andAnother: boolean) {
    if (!validation.ok) {
      setError(t("teamTask.form.required"));
      return;
    }
    setBusy(true);
    setError(null);
    const res =
      form.destination === "board"
        ? await onCreateLocalTask(boardId, toLocalPrompt(form))
        : editing
          ? await onUpdateTeamTask(editing, toTeamTaskBody(form))
          : await onCreateTeamTask(toTeamTaskBody(form));
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t("teamTask.error"));
      return;
    }
    if (andAnother) {
      setForm((prev) => ({ ...emptyTaskForm(), destination: prev.destination }));
      return;
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit(false);
    }
    if (e.key === "Escape") onClose();
  }

  function applyTemplate(name: string) {
    const template = templates.find((x) => x.name === name);
    if (template) setForm({ ...template.form, title: form.title, destination: form.destination });
  }
  function saveTemplate() {
    const name = window.prompt(t("teamTask.form.saveTemplate"));
    if (!name || name.trim() === "") return;
    const next = [...templates.filter((x) => x.name !== name.trim()), { name: name.trim(), form }];
    writeTemplates(teamId, next);
  }

  const submitKey = submitLabelKey(form.destination, form.assignment);

  return (
    <div className={styles.overlay} role="presentation" onKeyDown={onKeyDown}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={editing ? t("teamTask.form.editTitle") : t("teamTask.form.title")}>
        <header className={styles.head}>
          <h1 className={styles.headTitle}>{editing ? t("teamTask.form.editTitle") : t("teamTask.form.title")}</h1>
          {!editing ? (
            <div className={styles.segments} role="group" aria-label={t("teamTask.form.destination")}>
              <button
                type="button"
                className={`${styles.seg}${form.destination === "team" ? ` ${styles.segOn}` : ""}`}
                aria-pressed={form.destination === "team"}
                onClick={() => set("destination", "team" as TaskDestination)}
              >
                {t("teamTask.form.dest.team", { team: teamName })}
              </button>
              <button
                type="button"
                className={`${styles.seg}${form.destination === "board" ? ` ${styles.segOn}` : ""}`}
                aria-pressed={form.destination === "board"}
                onClick={() => set("destination", "board" as TaskDestination)}
              >
                {t("teamTask.form.dest.board", { board: boards[0]?.name ?? "" })}
              </button>
            </div>
          ) : null}
          <span className={styles.grow} />
          {templates.length > 0 ? (
            <select className={styles.template} aria-label={t("teamTask.form.template", { name: "" })} defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">{t("teamTask.form.template", { name: "" })}</option>
              {templates.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name}
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" className={styles.iconBtn} aria-label={t("teamTask.form.cancel")} onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.label}>{t("teamTask.form.field.title")}</span>
              <input className={styles.titleInput} value={form.title} onChange={(e) => set("title", e.target.value)} autoFocus />
            </label>

            <div className={styles.field}>
              <span className={styles.label}>{t("teamTask.form.field.kind")}</span>
              <div className={styles.pills} role="radiogroup" aria-label={t("teamTask.form.field.kind")}>
                {KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={form.kind === kind}
                    className={`${styles.pill}${form.kind === kind ? ` ${styles.pillOn}` : ""}`}
                    onClick={() => set("kind", kind)}
                  >
                    {t(TEAM_KIND_LABEL_KEY[kind])}
                  </button>
                ))}
              </div>
              <span className={styles.hint}>{t(KIND_HINT_KEY[form.kind])}</span>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t("teamTask.form.field.contract")}</span>
              <div className={styles.contractBox}>
                <div className={styles.toolbar} role="toolbar" aria-label={t("teamTask.form.field.contract")}>
                  <button type="button" className={styles.tool} onClick={() => wrapContract("**")} aria-label="bold">B</button>
                  <button type="button" className={styles.tool} onClick={() => wrapContract("*")} aria-label="italic"><i>I</i></button>
                  <button type="button" className={styles.tool} onClick={() => wrapContract("`")} aria-label="code">{"</>"}</button>
                  <button type="button" className={styles.tool} onClick={() => wrapContract("- ", "")} aria-label="list">•</button>
                  <button type="button" className={styles.tool} onClick={() => wrapContract("- [ ] ", "")} aria-label="checklist">☐</button>
                  <span className={styles.grow} />
                  <button type="button" className={styles.tool} onClick={() => setShowPreview((v) => !v)}>
                    {t("teamTask.form.preview")}
                  </button>
                </div>
                {showPreview ? (
                  <pre className={styles.contractPreview}>{form.contract}</pre>
                ) : (
                  <textarea
                    ref={contractRef}
                    className={styles.contract}
                    value={form.contract}
                    onChange={(e) => set("contract", e.target.value)}
                  />
                )}
              </div>
            </div>

            <div className={styles.grid2}>
              <div className={styles.field}>
                <span className={styles.label}>{t("teamTask.form.field.territory")}</span>
                <div className={styles.chipBox}>
                  {form.territory.map((territory) => (
                    <span key={territory} className={styles.chip}>
                      {territory}
                      <button type="button" className={styles.chipX} aria-label={`remove ${territory}`} onClick={() => set("territory", form.territory.filter((x) => x !== territory))}>
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
                      </button>
                    </span>
                  ))}
                  <input
                    className={styles.chipInput}
                    placeholder={t("teamTask.form.territory.add")}
                    value={territoryDraft}
                    onChange={(e) => setTerritoryDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTerritory();
                      }
                    }}
                  />
                </div>
                <span className={`${styles.hint}${conflicts.length > 0 ? ` ${styles.hintWarn}` : ""}`}>
                  {conflicts.length > 0
                    ? t("teamTask.form.territory.conflict", { tasks: conflicts.map((c) => c.ref).join(", ") })
                    : t("teamTask.form.territory.ok")}
                </span>
              </div>

              <div className={styles.field}>
                <span className={styles.label}>{t("teamTask.form.field.gates")}</span>
                <div className={styles.gates}>
                  {form.gates.map((gate, i) => (
                    <div key={`${gate.cmd}-${i}`} className={styles.gateRow}>
                      <span className={`${styles.chip} ${styles.gateCmd}`}>{gate.cmd}</span>
                      <label className={styles.switch}>
                        <input
                          type="checkbox"
                          checked={gate.exclusive}
                          onChange={(e) => set("gates", form.gates.map((g, j) => (j === i ? { ...g, exclusive: e.target.checked } : g)))}
                        />
                        {t("teamTask.form.gate.exclusive")}
                      </label>
                      <button type="button" className={styles.chipX} aria-label={`remove ${gate.cmd}`} onClick={() => set("gates", form.gates.filter((_, j) => j !== i))}>
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
                      </button>
                    </div>
                  ))}
                  <div className={styles.gateRow}>
                    <input
                      className={styles.gateInput}
                      placeholder="npm test"
                      value={gateDraft}
                      onChange={(e) => setGateDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addGate();
                        }
                      }}
                    />
                    <button type="button" className={styles.ghostSmall} onClick={addGate}>
                      {t("teamTask.form.gate.add")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.grid3}>
              <label className={styles.field}>
                <span className={styles.label}>{t("teamTask.form.field.depends")}</span>
                <input className={styles.input} value={form.dependsOn} onChange={(e) => set("dependsOn", e.target.value)} placeholder="#41" />
                <span className={styles.hint}>{t("teamTask.form.depends.hint")}</span>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{t("teamTask.form.field.review")}</span>
                <select className={styles.input} value={form.reviewerId} onChange={(e) => set("reviewerId", e.target.value)}>
                  <option value="">{t("teamTask.form.review.none")}</option>
                  {reviewers.map((m) => (
                    <option key={m.accountId} value={m.accountId}>
                      {memberDisplayName(members, m.accountId)}
                    </option>
                  ))}
                </select>
                <span className={styles.hint}>{t("teamTask.form.review.hint")}</span>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{t("teamTask.form.field.provider")}</span>
                <input className={styles.input} value={form.provider} onChange={(e) => set("provider", e.target.value)} placeholder={t("teamTask.form.provider.free")} />
                <span className={styles.hint}>{t("teamTask.form.provider.hint")}</span>
              </label>
            </div>

            {showsDistribution(form.destination) ? (
              <div className={styles.distBox}>
                <span className={styles.label}>{t("teamTask.form.field.distribution")}</span>
                <div className={styles.pills} role="radiogroup" aria-label={t("teamTask.form.field.distribution")}>
                  {(["person", "open", "auto"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={form.assignment === mode}
                      className={`${styles.pill}${form.assignment === mode ? ` ${styles.pillOn}` : ""}`}
                      onClick={() => set("assignment", mode as TaskAssignment)}
                    >
                      {t(ASSIGNMENT_LABEL_KEY[mode])}
                    </button>
                  ))}
                </div>
                {form.assignment === "person" ? (
                  <div className={styles.grid3}>
                    <label className={styles.field}>
                      <span className={styles.label}>{t("teamTask.form.field.person")}</span>
                      <select className={styles.input} value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
                        <option value="">—</option>
                        {members.map((m) => {
                          const av = memberAvatar(members, m.accountId);
                          return (
                            <option key={m.accountId} value={m.accountId}>
                              {av.initials} · {memberDisplayName(members, m.accountId)}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span className={styles.label}>{t("teamTask.form.field.sprint")}</span>
                      <select className={styles.input} value={form.sprintId} onChange={(e) => set("sprintId", e.target.value)}>
                        <option value="">{t("teamTask.form.sprint.backlog")}</option>
                        {sprints.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span className={styles.label}>{t("teamTask.form.field.priority")}</span>
                      <select className={styles.input} value={form.priority} onChange={(e) => set("priority", e.target.value as TeamTaskFormState["priority"])}>
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {t(TEAM_PRIORITY_LABEL_KEY[p])}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>
            ) : null}

            <details className={styles.advanced}>
              <summary>{t("teamTask.form.advanced")}</summary>
              <label className={styles.switchRow}>
                <input type="checkbox" checked={form.allowCommit} onChange={(e) => set("allowCommit", e.target.checked)} />
                {t("teamTask.form.commit")}
              </label>
              <div className={styles.field}>
                <span className={styles.label}>{t("teamTask.form.reportFields")}</span>
                <div className={styles.chips}>
                  {form.reportSchema.map((field) => (
                    <span key={field} className={styles.chip}>
                      {field}
                    </span>
                  ))}
                </div>
              </div>
              <label className={styles.switchRow}>
                <input
                  type="number"
                  className={styles.retries}
                  min={0}
                  max={9}
                  value={form.maxRetries}
                  onChange={(e) => set("maxRetries", Math.max(0, Number(e.target.value) || 0))}
                />
                {t("teamTask.form.retries", { n: String(form.maxRetries) })}
              </label>
            </details>
          </div>

          <aside className={styles.preview} aria-label={t("teamTask.form.agentReceives")}>
            <span className={styles.preLabel}>{t("teamTask.form.agentReceives")}</span>
            <pre className={styles.agentBox}>{agentPreviewLines(form, members).join("\n")}</pre>
            <span className={styles.preLabel}>{t("teamTask.form.whereAppears")}</span>
            <div className={styles.whereBox}>
              {t(whereAppearsKey(form.destination, form.assignment), {
                board: boards[0]?.name ?? "",
                name: form.assignment === "person" && form.assigneeId ? assigneeName : "",
              })}
            </div>
            {form.dependsOn.trim() !== "" ? (
              <div className={styles.dependsWarn}>{t("teamTask.form.dependsWaiting", { ref: form.dependsOn.trim() })}</div>
            ) : null}
          </aside>
        </div>

        <footer className={styles.foot}>
          <span className={styles.hint}>
            {savedAt !== null ? `${t("teamTask.form.draftSaved")} · ` : ""}
            {t("teamTask.form.ctrlEnter")}
          </span>
          <span className={styles.grow} />
          {error ? <span className={styles.error}>{error}</span> : null}
          <button type="button" className={styles.ghost} onClick={saveTemplate}>
            {t("teamTask.form.saveTemplate")}
          </button>
          <button type="button" className={styles.ghost} disabled={busy} onClick={() => void submit(true)}>
            {t("teamTask.form.createAnother")}
          </button>
          <button type="button" className={styles.primary} disabled={busy || !validation.ok} onClick={() => void submit(false)}>
            {editing ? t("teamTask.form.save") : t(submitKey, { name: assigneeName })}
          </button>
        </footer>
      </div>
    </div>
  );
}
