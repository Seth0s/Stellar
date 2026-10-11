/**
 * Create-task modal (app-v3 / CriarTask.dc.html) for local board tasks.
 * Team destination keeps TeamTaskForm — this modal is local-board only.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { TASK_PURPOSES, type TaskPurpose } from "../../task-purpose";
import {
  PURPOSE_META,
  agentReceivesPreview,
  beforeCreateChecklist,
  canSubmitCreate,
  emptyCreateTaskForm,
  formToCreateContract,
  primaryCtaLabel,
  territoryConflictsForCreate,
  whereCardLine,
  whereColumn,
  type ActiveTerritoryTask,
  type CreateTaskFormState,
  type CreateWhen,
} from "./create-task-form-decisions";
import styles from "./CreateTaskModal.module.css";

export type CreateTaskModalProps = {
  open: boolean;
  boardId: string;
  boardName: string;
  sprintLabel?: string;
  seed?: Partial<CreateTaskFormState> | null;
  activeTasks?: readonly ActiveTerritoryTask[];
  onClose: () => void;
  onCreated: (taskId: string) => void;
};

type ProviderOpt = { id: string; name: string; dot: string; quota: string; qColor: string };

const PROVIDERS: ProviderOpt[] = [
  { id: "claude", name: "Claude", dot: "#f0883e", quota: "cota 77% na semana", qColor: "#e6cfae" },
  { id: "antigravity", name: "Antigravity", dot: "#5b8cff", quota: "Gemini ok · Claude/GPT sem cota", qColor: "#e6cfae" },
  { id: "commandcode", name: "Command Code", dot: "#e85d9b", quota: "sem cota até sex", qColor: "#f2a093" },
  { id: "codex", name: "Codex", dot: "#8d94a6", quota: "sem crédito", qColor: "#f2a093" },
];

const WHEN_OPTS: { id: CreateWhen; label: string }[] = [
  { id: "deps", label: "Quando as dependências concluírem" },
  { id: "now", label: "Agora, num card novo" },
  { id: "reserve", label: "Reservar para o card" },
];

function switchStyle(on: boolean): CSSProperties {
  return { background: on ? "#4a5fe0" : "#2a2f3d" };
}

function knobStyle(on: boolean): CSSProperties {
  return { left: on ? 19 : 3, background: on ? "#fff" : "#8d94a6" };
}

export function CreateTaskModal({
  open,
  boardId,
  boardName,
  sprintLabel = "",
  seed = null,
  activeTasks = [],
  onClose,
  onCreated,
}: CreateTaskModalProps): React.JSX.Element | null {
  const [form, setForm] = useState<CreateTaskFormState>(() => emptyCreateTaskForm(seed ?? undefined));
  const [pathDraft, setPathDraft] = useState("");
  const [depDraft, setDepDraft] = useState("");
  const [schemaDraft, setSchemaDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keepOpen, setKeepOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(emptyCreateTaskForm({ ...(seed ?? {}), sprintLabel: seed?.sprintLabel ?? sprintLabel }));
    setPathDraft("");
    setDepDraft("");
    setSchemaDraft("");
    setSubmitting(false);
    setError(null);
    setKeepOpen(false);
  }, [open, seed, sprintLabel]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onClose();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void submit(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // submit closes over latest form via state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, submitting, onClose, form]);

  const conflicts = useMemo(
    () => territoryConflictsForCreate(form.territory, activeTasks),
    [form.territory, activeTasks],
  );
  const checklist = useMemo(() => beforeCreateChecklist(form, conflicts), [form, conflicts]);
  const preview = useMemo(() => agentReceivesPreview(form), [form]);
  const cta = primaryCtaLabel(form.when);

  if (!open) return null;

  const patch = (partial: Partial<CreateTaskFormState>): void => {
    setForm((prev) => ({ ...prev, ...partial }));
  };

  const wrapBrief = (before: string, after = before): void => {
    const area = document.getElementById("create-task-brief") as HTMLTextAreaElement | null;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = form.briefing.slice(start, end) || "texto";
    const next = form.briefing.slice(0, start) + before + selected + after + form.briefing.slice(end);
    patch({ briefing: next });
  };

  const addPath = (): void => {
    const path = pathDraft.trim();
    if (!path) return;
    if (form.territory.some((t) => t.path === path)) {
      setPathDraft("");
      return;
    }
    const conflict = activeTasks.find(
      (t) =>
        (t.phase === "running" || t.phase === "awaiting_review" || t.phase === "changes_requested") &&
        t.territory.some((owned) => owned.includes(path) || path.includes(owned)),
    );
    patch({
      territory: [
        ...form.territory,
        {
          path,
          shared: Boolean(conflict),
          sharedNote: conflict ? "coordenar com task ativa" : "",
        },
      ],
    });
    setPathDraft("");
  };

  const addGate = (): void => {
    patch({ gates: [...form.gates, { cmd: "", exclusiveMachine: false }] });
  };

  const addDep = (): void => {
    const raw = depDraft.trim();
    if (!raw) return;
    const id = raw.replace(/^#/, "");
    if (form.deps.some((d) => d.id === id)) {
      setDepDraft("");
      return;
    }
    patch({ deps: [...form.deps, { id, title: id.slice(0, 8), statusLabel: "pendente" }] });
    setDepDraft("");
  };

  const addSchema = (): void => {
    const f = schemaDraft.trim();
    if (!f || form.reportSchema.includes(f)) {
      setSchemaDraft("");
      return;
    }
    patch({ reportSchema: [...form.reportSchema, f] });
    setSchemaDraft("");
  };

  async function submit(andAnother: boolean): Promise<void> {
    if (!canSubmitCreate(form) || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (typeof window.tasks.createFull !== "function") {
        setError("IPC createFull não ligado (preload + registerCreateTaskIpc).");
        return;
      }
      const contract = formToCreateContract(form);
      const result = await window.tasks.createFull({
        boardId,
        prompt: contract.prompt,
        purpose: contract.purpose,
        territory: contract.territory,
        gates: contract.gates,
        reportSchema: contract.reportSchema,
        allowCommit: false,
        review: contract.review,
        provider: contract.provider,
        deps: contract.deps,
        maxRetries: contract.maxRetries,
        fallbackProviders: contract.fallbackProviders,
        cwd: contract.cwd,
        suggestedOrder: contract.suggestedOrder,
        spawnProfile: form.spawnProfile.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated(result.taskId);
      if (andAnother || keepOpen) {
        setForm(emptyCreateTaskForm({ sprintLabel, provider: form.provider, purpose: form.purpose }));
        setKeepOpen(false);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className={styles.root}
      role="presentation"
      data-part="create-task-modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-modal-title"
        data-part="create-task-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h1 id="create-task-modal-title" className={styles.title}>
            Nova task
          </h1>
          <span className={styles.hint}>
            {boardName}
            {sprintLabel ? ` · ${sprintLabel}` : ""}
          </span>
          <div className={styles.spacer} />
          {(form.title.trim() || form.briefing.trim()) && (
            <span className={styles.hint}>Rascunho salvo há 4 s</span>
          )}
          <button
            type="button"
            className={styles.btn}
            style={{ width: 36, padding: 0, justifyContent: "center" }}
            aria-label="Fechar"
            disabled={submitting}
            onClick={onClose}
            data-part="create-task-close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#c9cede" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.form}>
            <section className={styles.sec} aria-labelledby="create-s1">
              <h2 id="create-s1" className={styles.sh}>
                1 · O que é
              </h2>
              <label className={styles.stack}>
                <span className={styles.lbl}>Título</span>
                <input
                  className={styles.field}
                  data-part="create-task-title"
                  value={form.title}
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </label>
              <div className={styles.stackGap8}>
                <span className={styles.lbl} id="create-tp">
                  Tipo
                </span>
                <div role="radiogroup" aria-labelledby="create-tp" className={styles.row}>
                  {TASK_PURPOSES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={form.purpose === p}
                      className={`${styles.pill}${form.purpose === p ? ` ${styles.pillOn}` : ""}`}
                      data-part={`create-task-purpose-${p}`}
                      onClick={() => patch({ purpose: p as TaskPurpose })}
                    >
                      {PURPOSE_META[p].label}
                    </button>
                  ))}
                </div>
                <span className={styles.hint}>{PURPOSE_META[form.purpose].hint}</span>
              </div>
              <div className={styles.stack}>
                <div className={styles.row}>
                  <span className={styles.lbl}>Briefing</span>
                  <span className={styles.hint}>markdown · é o que o agente lê</span>
                  <div className={styles.spacer} />
                  <button type="button" className={`${styles.btn} ${styles.btnSm}`} disabled>
                    Usar modelo…
                  </button>
                </div>
                <div className={styles.briefBox}>
                  <div className={styles.briefBar}>
                    <button type="button" className={styles.tb} aria-label="Negrito" style={{ fontWeight: 700 }} onClick={() => wrapBrief("**")}>
                      B
                    </button>
                    <button type="button" className={styles.tb} aria-label="Itálico" style={{ fontStyle: "italic" }} onClick={() => wrapBrief("_")}>
                      I
                    </button>
                    <button type="button" className={`${styles.tb} ${styles.mono}`} aria-label="Código" onClick={() => wrapBrief("`")}>
                      {"{}"}
                    </button>
                    <button type="button" className={styles.tb} aria-label="Lista" onClick={() => wrapBrief("\n- ", "")}>
                      •
                    </button>
                    <button type="button" className={styles.tb} aria-label="Checklist" onClick={() => wrapBrief("\n- [ ] ", "")}>
                      ☐
                    </button>
                    <span className={styles.spacer} />
                    <button
                      type="button"
                      className={styles.tb}
                      style={{ width: "auto", padding: "0 10px" }}
                      data-part="create-task-preview-toggle"
                    >
                      Pré-visualizar
                    </button>
                  </div>
                  <textarea
                    id="create-task-brief"
                    className={styles.briefArea}
                    data-part="create-task-brief"
                    aria-label="Briefing"
                    value={form.briefing}
                    onChange={(e) => patch({ briefing: e.target.value })}
                  />
                </div>
              </div>
            </section>

            <section className={styles.sec} aria-labelledby="create-s2">
              <h2 id="create-s2" className={styles.sh}>
                2 · O contrato
              </h2>
              <div className={styles.stackGap8}>
                <span className={styles.lbl}>
                  Território <span className={styles.hint}>· arquivos que a task pode tocar</span>
                </span>
                <div className={styles.row}>
                  {form.territory.map((tag) => (
                    <span
                      key={tag.path}
                      className={`${styles.tag} ${styles.mono}${tag.shared ? ` ${styles.tagShared}` : ""}`}
                    >
                      {tag.path}
                      {tag.shared ? <span className={styles.tagSharedNote}>compartilhado</span> : null}
                      <button
                        type="button"
                        className={`${styles.tb} ${styles.tbTiny}`}
                        aria-label="Remover"
                        onClick={() => patch({ territory: form.territory.filter((t) => t.path !== tag.path) })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className={`${styles.field} ${styles.fieldMono} ${styles.fieldSm}`}
                    style={{ width: 220 }}
                    aria-label="Adicionar caminho"
                    placeholder="+ caminho ou glob"
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addPath())}
                  />
                </div>
                {conflicts.length > 0 ? (
                  <div className={styles.warn} data-part="create-task-territory-conflict">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="#f0b25c"
                      strokeWidth="1.5"
                      aria-hidden="true"
                      style={{ flex: "none", marginTop: 2 }}
                    >
                      <path d="M8 2l6.5 11.5h-13z" />
                      <path d="M8 6.5v3M8 11.5h.01" />
                    </svg>
                    <span>
                      App.tsx também está no território de{" "}
                      <a className={styles.linkish} href={`#${conflicts[0]!.id}`}>
                        #{conflicts[0]!.id.slice(0, 6)}
                      </a>
                      , rodando. Declarei como compartilhado; escreva a nota de coordenação:{" "}
                      <span className={styles.mono}>
                        &quot;só o handler de visibilidade; releia antes de editar&quot;
                      </span>
                    </span>
                  </div>
                ) : null}
              </div>

              <div className={styles.stackGap8}>
                <span className={styles.lbl}>
                  Gates <span className={styles.hint}>· o app roda depois do report, numa worktree isolada</span>
                </span>
                {form.gates.map((g, i) => (
                  <div key={i} className={styles.row}>
                    <input
                      className={`${styles.field} ${styles.fieldMono} ${styles.grow}`}
                      style={{ fontSize: 13 }}
                      value={g.cmd}
                      onChange={(e) => {
                        const gates = form.gates.slice();
                        gates[i] = { ...g, cmd: e.target.value };
                        patch({ gates });
                      }}
                    />
                    <label className={styles.hint} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={g.exclusiveMachine}
                        onChange={(e) => {
                          const gates = form.gates.slice();
                          gates[i] = { ...g, exclusiveMachine: e.target.checked };
                          patch({ gates });
                        }}
                      />
                      exclusivo na máquina
                    </label>
                    {form.gates.length > 1 ? (
                      <button
                        type="button"
                        className={`${styles.tb} ${styles.tbTiny}`}
                        onClick={() => patch({ gates: form.gates.filter((_, j) => j !== i) })}
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                ))}
                <button type="button" className={styles.btn} style={{ alignSelf: "flex-start", minHeight: 30 }} onClick={addGate}>
                  + gate
                </button>
              </div>

              <div className={styles.stackGap8}>
                <span className={styles.lbl}>Campos obrigatórios do report</span>
                <div className={styles.row}>
                  {form.reportSchema.map((f) => (
                    <span key={f} className={`${styles.tag} ${styles.mono}`}>
                      {f}
                      <button
                        type="button"
                        className={`${styles.tb} ${styles.tbTiny}`}
                        onClick={() => patch({ reportSchema: form.reportSchema.filter((x) => x !== f) })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className={`${styles.field} ${styles.fieldMono} ${styles.fieldSm}`}
                    style={{ width: 140 }}
                    value={schemaDraft}
                    onChange={(e) => setSchemaDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSchema())}
                    placeholder="+ campo"
                  />
                  <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={addSchema}>
                    + campo
                  </button>
                </div>
              </div>

              <div className={styles.row} style={{ gap: 24 }}>
                <label className={styles.row}>
                  <button
                    type="button"
                    className={styles.sw}
                    aria-pressed={form.allowCommit}
                    aria-label="Permitir commit"
                    style={switchStyle(false)}
                    onClick={() => patch({ allowCommit: false })}
                  >
                    <span className={styles.swKnob} style={knobStyle(false)} />
                  </button>
                  <span style={{ fontSize: 13.5 }}>Permitir commit</span>
                </label>
                <label className={styles.row}>
                  <button
                    type="button"
                    className={styles.sw}
                    aria-pressed={form.reviewWanted}
                    aria-label="Exigir revisão"
                    style={switchStyle(form.reviewWanted)}
                    onClick={() => patch({ reviewWanted: !form.reviewWanted })}
                  >
                    <span className={styles.swKnob} style={knobStyle(form.reviewWanted)} />
                  </button>
                  <span style={{ fontSize: 13.5 }}>Exigir revisão antes de concluir</span>
                </label>
              </div>
            </section>

            <section className={styles.sec} aria-labelledby="create-s3">
              <h2 id="create-s3" className={styles.sh}>
                3 · Quem faz e quando
              </h2>
              <div className={styles.stackGap8}>
                <span className={styles.lbl} id="create-pv">
                  Provider
                </span>
                <div role="radiogroup" aria-labelledby="create-pv" className={styles.provGrid}>
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={form.provider === p.id}
                      className={`${styles.provBtn}${form.provider === p.id ? ` ${styles.provBtnOn}` : ""}`}
                      onClick={() => patch({ provider: p.id })}
                    >
                      <span className={styles.row} style={{ gap: 8, fontSize: 14 }}>
                        <span className={styles.dot} style={{ background: p.dot }} />
                        {p.name}
                      </span>
                      <span style={{ fontSize: 12, color: p.qColor }}>{p.quota}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.grid3}>
                <label className={styles.stack}>
                  <span className={styles.lbl}>Modelo</span>
                  <input
                    className={styles.field}
                    value={form.model}
                    onChange={(e) => patch({ model: e.target.value })}
                    placeholder="(default)"
                  />
                </label>
                <label className={styles.stack}>
                  <span className={styles.lbl}>Esforço</span>
                  <select className={styles.field} value={form.effort} onChange={(e) => patch({ effort: e.target.value })}>
                    <option value="alto">alto</option>
                    <option value="médio">médio</option>
                    <option value="baixo">baixo</option>
                  </select>
                </label>
                <label className={styles.stack}>
                  <span className={styles.lbl}>Sprint</span>
                  <input
                    className={styles.field}
                    value={form.sprintLabel}
                    onChange={(e) => patch({ sprintLabel: e.target.value })}
                    placeholder="Sem sprint"
                  />
                </label>
              </div>
              <div className={styles.stackGap8}>
                <span className={styles.lbl}>
                  Depende de <span className={styles.hint}>· começa sozinha quando todas concluírem</span>
                </span>
                <div className={styles.row}>
                  {form.deps.map((d) => (
                    <span key={d.id} className={styles.tag}>
                      <span className={styles.mono}>#{d.id.slice(0, 8)}</span> {d.title}
                      <span style={{ color: "#a9b8ff" }}>{d.statusLabel}</span>
                      <button
                        type="button"
                        className={`${styles.tb} ${styles.tbTiny}`}
                        onClick={() => patch({ deps: form.deps.filter((x) => x.id !== d.id) })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className={`${styles.field} ${styles.fieldSm}`}
                    style={{ width: 200 }}
                    aria-label="Adicionar dependência"
                    placeholder="+ #id ou título"
                    value={depDraft}
                    onChange={(e) => setDepDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addDep())}
                  />
                </div>
              </div>
              <div className={styles.stackGap8}>
                <span className={styles.lbl} id="create-qd">
                  Quando começar
                </span>
                <div role="radiogroup" aria-labelledby="create-qd" className={styles.row}>
                  {WHEN_OPTS.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      role="radio"
                      aria-checked={form.when === w.id}
                      className={`${styles.pill}${form.when === w.id ? ` ${styles.pillOn}` : ""}`}
                      onClick={() => patch({ when: w.id })}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className={`${styles.sec} ${styles.secLast}`} aria-labelledby="create-s4">
              <button
                type="button"
                className={styles.advToggle}
                aria-expanded={form.advancedOpen}
                onClick={() => patch({ advancedOpen: !form.advancedOpen })}
              >
                <h2 id="create-s4" className={styles.sh}>
                  4 · Avançado
                </h2>
                <span className={styles.hint}>
                  {form.advancedOpen ? "recolher" : "tentativas, reservas, pasta, perfil, prioridade"}
                </span>
              </button>
              {form.advancedOpen ? (
                <div className={styles.grid3} style={{ marginTop: 12 }}>
                  <label className={styles.stack}>
                    <span className={styles.lbl}>Novas tentativas</span>
                    <input
                      className={styles.field}
                      type="number"
                      min={0}
                      value={form.maxRetries}
                      onChange={(e) => patch({ maxRetries: Number(e.target.value) || 0 })}
                    />
                  </label>
                  <label className={styles.stack}>
                    <span className={styles.lbl}>Providers de reserva</span>
                    <input
                      className={styles.field}
                      value={form.fallbackProviders}
                      onChange={(e) => patch({ fallbackProviders: e.target.value })}
                    />
                  </label>
                  <label className={styles.stack}>
                    <span className={styles.lbl}>Pasta</span>
                    <input
                      className={`${styles.field} ${styles.fieldMono}`}
                      value={form.cwd}
                      onChange={(e) => patch({ cwd: e.target.value })}
                    />
                  </label>
                  <label className={styles.stack}>
                    <span className={styles.lbl}>Perfil de spawn</span>
                    <input
                      className={styles.field}
                      value={form.spawnProfile}
                      onChange={(e) => patch({ spawnProfile: e.target.value })}
                      placeholder="nenhum"
                    />
                  </label>
                  <label className={styles.stack}>
                    <span className={styles.lbl}>Prioridade sugerida</span>
                    <select
                      className={styles.field}
                      value={form.suggestedPriority}
                      onChange={(e) =>
                        patch({ suggestedPriority: e.target.value === "alta" ? "alta" : "normal" })
                      }
                    >
                      <option value="alta">alta</option>
                      <option value="normal">normal</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </section>
          </div>

          <aside className={styles.aside} aria-label="Prévia">
            <section className={styles.asideBlock}>
              <h2 className={styles.sh}>O agente recebe</h2>
              <div className={styles.previewBox} data-part="create-task-preview">
                {preview}
              </div>
            </section>
            <section className={`${styles.asideBlock} ${styles.asideBody}`}>
              <h2 className={styles.sh}>Onde aparece</h2>
              <span>
                Fila, coluna <strong>{whereColumn(form.when)}</strong>
              </span>
              <span>{whereCardLine(form)}</span>
            </section>
            <section className={styles.asideBlock}>
              <h2 className={styles.sh}>Antes de criar</h2>
              {checklist.map((item) => (
                <span key={item.text} className={item.warn ? styles.checkWarn : item.ok ? styles.checkOk : styles.checkWarn}>
                  {item.warn ? "! " : item.ok ? "✓ " : "○ "}
                  {item.text}
                </span>
              ))}
            </section>
          </aside>
        </div>

        <footer className={styles.foot}>
          <span className={styles.hint}>Ctrl Enter cria</span>
          {error ? <span className={styles.error}>{error}</span> : <div className={styles.spacer} />}
          <button type="button" className={styles.btn} disabled>
            Salvar como modelo
          </button>
          <button
            type="button"
            className={styles.btn}
            disabled={submitting || !canSubmitCreate(form)}
            onClick={() => {
              setKeepOpen(true);
              void submit(true);
            }}
          >
            Criar e outra
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            data-part="create-task-submit"
            disabled={submitting || !canSubmitCreate(form)}
            onClick={() => void submit(false)}
          >
            {submitting ? "Criando…" : cta}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
