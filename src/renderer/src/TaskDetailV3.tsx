import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskBoardItem } from "../../preload/index";
import { parseTaskPrompt } from "../../task-prompt-decision";
import { useModal } from "./useModal";
import {
  describeTransitionTrail,
  originBadge,
  shortTaskId,
  waitingOnDep,
} from "./task-board-model";
import { decideTaskDiffPresentation, TASK_DIFF_KEYS, type TaskDiffFileView } from "./task-diff-presentation";
import { deriveAgoraBanner, deriveTileTypeLabel } from "./task-fila-v3-decision";
import { boardItemTitle, queueFactsFromBoardItem } from "./task-fila-v3-facts";
import { groupDiffFiles, type DiffRow } from "./task-gate-detail";
import {
  extractAcceptanceBullets,
  extractWhatIsBlurb,
  extractMeasuredBlurb,
  measuredGateRows,
} from "./task-detail-v3-sections";
import { Icon } from "./icons";
import { getLocale, t } from "../../shared/i18n";
import styles from "./TaskDetailV3.module.css";

const ENTER_MS = 200;
const EXIT_MS = 140;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function DiffFileRow({ row }: { row: DiffRow }) {
  const territory =
    row.territory === "inside"
      ? t(TASK_DIFF_KEYS.inside)
      : row.territory === "outside"
        ? t(TASK_DIFF_KEYS.outside)
        : t(TASK_DIFF_KEYS.unlabeled);
  return (
    <div className={styles.diffFileRow} data-part="task-diff-file" data-territory={row.territory}>
      <span className={styles.diffStatus}>{row.status.trim() || "·"}</span>
      <span className={styles.diffPath} title={row.path}>
        {row.name}
      </span>
      <span className={styles.diffTag}>{territory}</span>
      {row.untracked ? (
        <span
          className={styles.diffNew}
          data-part="task-diff-untracked"
          title={t(TASK_DIFF_KEYS.untracked)}
          aria-label={t(TASK_DIFF_KEYS.untracked)}
        >
          <Icon name="newFile" size={11} />
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

type TabId = "resumo" | "contrato" | "rel" | "mud" | "trilha";

function formatWhen(at: number): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(at));
}

function formatClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function TaskDetailV3({
  task,
  now,
  readOnly,
  sprintLabel,
  cardId,
  onClose,
  onOpenTask,
}: {
  task: TaskBoardItem;
  now: number;
  readOnly: boolean;
  sprintLabel: string | null;
  cardId: string;
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [phase, setPhase] = useState<"enter" | "open" | "leave">(() =>
    prefersReducedMotion() ? "open" : "enter",
  );
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const frame =
      document.querySelector(`.card-frame[data-card-id="${CSS.escape(cardId)}"] .card-clip`) ??
      document.querySelector(`[data-card-id="${CSS.escape(cardId)}"] .card-clip`);
    setHost(frame instanceof HTMLElement ? frame : null);
  }, [cardId]);

  const requestClose = useCallback(() => {
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setPhase("leave");
    window.setTimeout(() => onClose(), EXIT_MS);
  }, [onClose]);

  useEffect(() => {
    if (phase !== "enter") return;
    const timer = window.setTimeout(() => setPhase("open"), ENTER_MS);
    return () => window.clearTimeout(timer);
  }, [phase, host]);

  const { modalProps } = useModal({ onClose: requestClose });
  const [tab, setTab] = useState<TabId>("resumo");
  const [fullPrompt, setFullPrompt] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<TaskDiffFileView[]>([]);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [lastActivityAgeMs, setLastActivityAgeMs] = useState<number | null>(null);
  const implementer = task.cards.find((c) => c.role === "implementer") ?? task.cards[0] ?? null;
  const facts = queueFactsFromBoardItem(task, {
    contextPercent,
    lastActivityAgeMs,
    hasReportThisRound: task.report != null,
  });
  const agora = deriveAgoraBanner(facts, now);
  const typeLabel = deriveTileTypeLabel(facts);
  const title = boardItemTitle(task);
  const parsed = parseTaskPrompt(fullPrompt);
  const trail = describeTransitionTrail(task.statusTransitions);
  const waiting = waitingOnDep(task.deps, task.depStatuses);
  const creator = originBadge(task.firstActor);
  const reviewer = task.cards.find((c) => c.role === "reviewer") ?? null;
  const superseded = facts.phase === "superseded";
  const whatIs = useMemo(
    () => (extractWhatIsBlurb(fullPrompt) ?? parsed.original) || task.promptPreview || null,
    [fullPrompt, parsed.original, task.promptPreview],
  );
  const acceptance = useMemo(() => extractAcceptanceBullets(fullPrompt), [fullPrompt]);
  const measuredBlurb = useMemo(() => extractMeasuredBlurb(fullPrompt), [fullPrompt]);
  const gateRows = useMemo(() => measuredGateRows(task.gateRun), [task.gateRun]);
  const diffGroups = useMemo(() => groupDiffFiles(diffFiles), [diffFiles]);
  const diffRows = useMemo(
    () =>
      diffFiles.map((file) => {
        const idx = file.path.lastIndexOf("/");
        return { ...file, name: idx >= 0 ? file.path.slice(idx + 1) : file.path };
      }),
    [diffFiles],
  );

  useEffect(() => {
    let cancelled = false;
    if (readOnly && task.promptSnapshot !== undefined) {
      setFullPrompt(task.promptSnapshot);
      return () => {
        cancelled = true;
      };
    }
    void window.tasks.getPrompt(task.id).then((res) => {
      if (cancelled || !res.ok) return;
      setFullPrompt(res.prompt);
    });
    void window.tasks.gateDiff(task.id).then((raw) => {
      if (cancelled || !raw) return;
      const view = decideTaskDiffPresentation(raw);
      if (view.present) setDiffFiles(view.files);
    });
    return () => {
      cancelled = true;
    };
  }, [task.id, readOnly, task.promptSnapshot]);

  useEffect(() => {
    const cardId = implementer?.cardId;
    if (!cardId || !task.cardAlive) {
      setContextPercent(null);
      setLastActivityAgeMs(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      void window.pty.health(cardId).then((h) => {
        if (cancelled || !h) return;
        const used = h.context?.usedTokens;
        const win = h.context?.windowTokens;
        if (used != null && win != null && win > 0) {
          setContextPercent(Math.round((used / win) * 100));
        }
        if (h.lastActivityAt != null) setLastActivityAgeMs(Math.max(0, Date.now() - h.lastActivityAt));
      });
    };
    poll();
    const id = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [implementer?.cardId, task.cardAlive]);

  async function onAgoraAction(id: string) {
    if (id === "open-successor" && task.supersededBy) {
      onOpenTask(task.supersededBy);
      return;
    }
    if (id === "approve-status") {
      await window.tasks.respondStatusAsk(task.id, true);
      return;
    }
    if (id === "deny-status") {
      await window.tasks.respondStatusAsk(task.id, false);
      return;
    }
    if (task.blockedQuestion?.options.some((o) => o.id === id)) {
      await window.tasks.answerBlocked(task.id, id, null);
    }
  }

  async function submitPrompt(mode: "append" | "replace") {
    const trimmed = draft.trim();
    if (!trimmed || busy || readOnly) return;
    setBusy(true);
    setPromptError(null);
    try {
      const res = await window.tasks.updatePrompt(task.id, trimmed, mode);
      if (!res.ok) {
        setPromptError(t("task.detail.error", { error: res.error }));
        return;
      }
      setDraft("");
      setFullPrompt(res.prompt);
    } finally {
      setBusy(false);
    }
  }

  const phaseSteps = (() => {
    if (superseded) return null;
    const steps = [
      { id: "ready", label: t("task.detail.phase.ready") },
      { id: "running", label: t("task.detail.phase.running") },
      { id: "report", label: t("task.detail.phase.report") },
      { id: "review", label: t("task.detail.phase.review") },
      { id: "done", label: t("task.detail.phase.done") },
    ] as const;
    let current = 0;
    if (facts.phase === "running") current = 1;
    else if (facts.phase === "awaiting_review" || facts.phase === "changes_requested") current = 3;
    else if (facts.phase === "done") current = 4;
    else if (task.report) current = 2;
    else if (facts.phase === "ready" || facts.phase === "reserved" || facts.phase === "waiting_deps") current = 0;
    return { steps, current };
  })();

  const agoraClass =
    agora?.variant === "blue"
      ? styles.agoraBlue
      : agora?.variant === "amber"
        ? styles.agoraAmber
        : agora?.variant === "amber-alert"
          ? styles.agoraAmberAlert
          : agora?.variant === "danger"
            ? styles.agoraDanger
            : styles.agoraNeutral;

  if (!host) return null;

  const dialogClass =
    phase === "enter"
      ? `${styles.dialog} ${styles.dialogEnter}`
      : phase === "leave"
        ? `${styles.dialog} ${styles.dialogLeave}`
        : styles.dialog;

  return createPortal(
    <div
      className={styles.root}
      data-part="task-detail-v3"
      data-anim={phase}
      role="presentation"
    >
      <div className={`modal-backdrop ${styles.veil}`} data-part="task-detail-veil" onClick={requestClose} />
      <section className={dialogClass} {...modalProps} aria-labelledby="task-detail-v3-title" role="dialog" aria-modal="true">
        <header className={styles.head}>
          <div className={styles.metaRow}>
            <span className={styles.id} data-part="task-detail-id">
              #{shortTaskId(task.id)}
            </span>
            {typeLabel && <span className={styles.pill}>{typeLabel}</span>}
            {sprintLabel && <span className={`${styles.pill} ${styles.pillSprint}`}>{sprintLabel}</span>}
            <span style={{ flex: 1 }} />
            <button type="button" className={styles.btn}>
              {t("task.detail.actions")}
            </button>
            <button type="button" className={`${styles.btn} ${styles.btnIcon}`} aria-label={t("common.close")} onClick={requestClose}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#c9cede" strokeWidth="1.6" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </div>
          <h1 id="task-detail-v3-title" className={styles.title}>
            {title}
          </h1>
          {superseded ? (
            <div className={styles.supersededNote}>
              <span className={`${styles.pill} ${styles.pillSuperseded}`}>{t("task.detail.superseded.badge")}</span>
              {t("task.detail.superseded.note")}
            </div>
          ) : (
            phaseSteps && (
              <ol className={styles.phaseTrail} aria-label={t("task.phase.running")}>
                {phaseSteps.steps.map((step, i) => (
                  <li key={step.id} style={{ display: "contents" }}>
                    {i > 0 && (
                      <span
                        aria-hidden="true"
                        className={`${styles.phaseLine}${i <= phaseSteps.current ? ` ${styles.phaseLineDone}` : ""}`}
                      />
                    )}
                    <span
                      className={`${styles.phaseItem}${i === phaseSteps.current ? ` ${styles.phaseCurrent}` : ""}`}
                      aria-current={i === phaseSteps.current ? "step" : undefined}
                    >
                      <span
                        className={`${styles.phaseDot}${
                          i === phaseSteps.current
                            ? ` ${styles.phaseDotCurrent}${facts.phase === "awaiting_review" || facts.phase === "changes_requested" ? ` ${styles.phaseDotCurrentAmber}` : ""}`
                            : i > phaseSteps.current
                              ? ` ${styles.phaseDotHollow}`
                              : ""
                        }`}
                      />
                      {step.label}
                    </span>
                  </li>
                ))}
              </ol>
            )
          )}
        </header>

        {agora && (
          <div className={`${styles.agora} ${agoraClass}`} data-part="agora-banner" data-variant={agora.variant ?? undefined}>
            {agora.variant === "blue" && <span className={styles.agoraDot} />}
            <div className={styles.agoraBody}>
              <span className={styles.agoraTitle}>{agora.title}</span>
              {agora.subtitle && <span className={styles.agoraSub}>{agora.subtitle}</span>}
            </div>
            <div className={styles.agoraActions}>
              {agora.actions.map((action, idx) => (
                <button
                  key={action.id}
                  type="button"
                  className={`${styles.btn}${idx === agora.actions.length - 1 && agora.variant !== "blue" ? ` ${styles.btnPrimary}` : ""}`}
                  disabled={readOnly && action.id !== "open-successor"}
                  onClick={() => void onAgoraAction(action.id)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <nav className={styles.tabs} aria-label={t("shell.sections")} data-part="task-detail-tabs">
          {(
            [
              ["resumo", "task.detail.tab.summary", null],
              ["contrato", "task.detail.tab.contract", null],
              ["rel", "task.detail.tab.reports", task.verdicts.length],
              ["mud", "task.detail.tab.changes", diffFiles.length],
              ["trilha", "task.detail.tab.trail", task.statusTransitions.length],
            ] as const
          ).map(([id, key, count]) => (
            <button
              key={id}
              type="button"
              className={`${styles.tab}${tab === id ? ` ${styles.tabOn}` : ""}`}
              onClick={() => setTab(id)}
            >
              {t(key)}
              {count != null && <span className={styles.tabCount}>{count}</span>}
            </button>
          ))}
        </nav>

        <div className={styles.body}>
          <main className={styles.main}>
            {tab === "resumo" && (
              <>
                <section data-part="task-detail-prompt">
                  <h2 className={styles.sectionKicker}>{superseded ? "O que era" : "O que é"}</h2>
                  <p
                    className={`${styles.sectionBody}${superseded ? ` ${styles.sectionMuted}` : ""}`}
                    data-part="task-detail-prompt-original"
                  >
                    {whatIs || "—"}
                  </p>
                </section>
                {!superseded && (measuredBlurb || gateRows.length > 0) && (
                  <section data-part="task-detail-measured">
                    <h2 className={styles.sectionKicker}>{t("task.detail.measured")}</h2>
                    {measuredBlurb ? (
                      <div className={styles.panel} data-part="task-detail-measured-blurb">
                        {measuredBlurb}
                      </div>
                    ) : (
                      <div className={styles.panel}>
                        {gateRows.map((row) => (
                          <div key={row.cmd} className={styles.diffRow}>
                            <span className={row.ok ? styles.diffAdd : undefined}>{row.ok ? "✓" : "✕"}</span>
                            <span className={styles.mono} style={{ flex: 1 }}>
                              {row.cmd}
                            </span>
                            {row.detail && <span className={styles.sectionMuted}>{row.detail}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                {!superseded && acceptance.length > 0 && (
                  <section data-part="task-detail-acceptance">
                    <h2 className={styles.sectionKicker}>{t("task.detail.acceptance")}</h2>
                    <ul className={styles.acceptanceList}>
                      {acceptance.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                )}
                {!superseded && parsed.additions.length > 0 && (
                  <section>
                    <h2 className={styles.sectionKicker}>Adendos</h2>
                    <ul className={styles.sectionBody}>
                      {parsed.additions.map((addition, i) => (
                        <li key={`${addition.at}-${i}`} data-part="task-detail-prompt-added">
                          {addition.text}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {!superseded && !readOnly && (
                  <section className={styles.briefEdit}>
                    <div className={styles.briefEditHead}>
                      <h2 className={styles.sectionKicker} style={{ margin: 0 }}>
                        Briefing
                      </h2>
                      <span className={styles.sectionMuted}>
                        original{parsed.additions.length > 0 ? ` + ${parsed.additions.length} adendo` : ""}
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        className={styles.btn}
                        data-part="task-detail-append"
                        disabled={busy || !draft.trim()}
                        onClick={() => void submitPrompt("append")}
                      >
                        {t("task.detail.append")}
                      </button>
                      <button
                        type="button"
                        className={styles.btn}
                        data-part="task-detail-replace"
                        disabled={busy || !draft.trim()}
                        onClick={() => void submitPrompt("replace")}
                      >
                        {t("task.detail.replace")}
                      </button>
                    </div>
                    <textarea
                      data-part="task-detail-prompt-draft"
                      data-no-drag
                      className={styles.draft}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t("task.detail.promptPlaceholder")}
                      disabled={busy}
                      aria-label={t("task.detail.prompt")}
                    />
                    {promptError && (
                      <p className={styles.promptError} data-part="task-detail-error" role="alert">
                        {promptError}
                      </p>
                    )}
                  </section>
                )}
                {superseded && (
                  <section>
                    <h2 className={styles.sectionKicker}>O que aconteceu</h2>
                    <ol className={styles.trail}>
                      {task.statusTransitions
                        .slice()
                        .reverse()
                        .map((tr) => (
                          <li key={`${tr.at}-${tr.toValue}`} className={styles.trailItem}>
                            <span className={styles.trailTime}>{formatClock(tr.at)}</span>
                            <span>
                              {tr.toValue === "superseded" && task.supersededBy
                                ? `marcada como substituída por #${shortTaskId(task.supersededBy)}`
                                : `status → ${tr.toValue}`}
                            </span>
                          </li>
                        ))}
                    </ol>
                  </section>
                )}
              </>
            )}

            {tab === "contrato" && (
              <>
                <section className={styles.panel}>
                  <h2 className={styles.sectionKicker}>Briefing</h2>
                  <pre className={styles.sectionBody} style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                    {fullPrompt ?? task.promptPreview ?? "—"}
                  </pre>
                </section>
                <div className={styles.contractGrid}>
                  <div className={styles.panel}>
                    <span className={styles.sectionKicker}>Território</span>
                    {(task.territory ?? []).length === 0 && <span className={styles.sectionMuted}>—</span>}
                    {(task.territory ?? []).map((p) => (
                      <span key={p} className={styles.mono}>
                        {p}
                      </span>
                    ))}
                  </div>
                  <div className={styles.panel}>
                    <span className={styles.sectionKicker}>Provider</span>
                    <span>{task.provider ?? "—"}</span>
                  </div>
                </div>
              </>
            )}

            {tab === "rel" &&
              (task.verdicts.length === 0 ? (
                <div className={styles.emptyReports}>
                  Nenhum report nesta task ainda. Quando chegar, cada rodada aparece aqui com os campos do contrato e os gates
                  medidos ao lado.
                </div>
              ) : (
                task.verdicts.map((v, i) => (
                  <div key={`${v.at}-${i}`} className={styles.panel}>
                    <span className={styles.sectionKicker}>
                      Rodada {i + 1} · {v.role} · {formatWhen(v.at)}
                    </span>
                    <span>{v.verdict ?? t("task.detail.verdictNone")}</span>
                  </div>
                ))
              ))}

            {tab === "mud" && (
              <section>
                <span className={styles.sectionMuted}>
                  {diffFiles.length} {t(TASK_DIFF_KEYS.sectionTitle).toLowerCase()}
                </span>
                <div className={styles.panel} style={{ padding: 0, overflow: "hidden" }} data-part="task-diff-files">
                  {diffGroups
                    ? diffGroups.map((group) => (
                        <div key={group.folder || "/"} data-part="task-diff-group">
                          {group.folder && <div className={styles.diffGroupLabel}>{group.folder}</div>}
                          {group.rows.map((row) => (
                            <DiffFileRow key={row.path} row={row} />
                          ))}
                        </div>
                      ))
                    : diffRows.map((row) => <DiffFileRow key={row.path} row={row} />)}
                  {diffFiles.length === 0 && <div className={styles.emptyReports}>Sem mudanças capturadas.</div>}
                </div>
              </section>
            )}

            {tab === "trilha" && (
              <ol className={styles.trail}>
                {task.statusTransitions
                  .slice()
                  .reverse()
                  .map((tr) => (
                    <li key={`${tr.at}-${tr.toValue}`} className={styles.trailItem}>
                      <span className={styles.trailTime}>{formatClock(tr.at)}</span>
                      <span>status → {tr.toValue}</span>
                    </li>
                  ))}
                {trail == null && task.statusTransitions.length === 0 && (
                  <li className={styles.sectionMuted}>Sem trilha ainda.</li>
                )}
              </ol>
            )}
          </main>

          <aside
            className={`${styles.aside}${superseded ? ` ${styles.asideSuperseded}` : ""}`}
            aria-label={t("task.detail.side.details")}
          >
            {!superseded && (
              <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <h2 className={styles.sectionKicker}>{t("task.detail.side.who")}</h2>
                {implementer ? (
                  <div className={styles.whoRow}>
                    <span className={`${styles.whoAvatar} ${styles.whoAvatarCl}`}>
                      {(implementer.label ?? implementer.provider ?? "??").slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <div className={styles.whoName}>{implementer.label ?? implementer.provider ?? implementer.cardId}</div>
                      <div className={styles.whoMeta}>
                        {implementer.role}
                        {task.cardAlive ? " · vivo" : " · parado"}
                        {contextPercent != null ? ` · ctx ${contextPercent}%` : ""}
                      </div>
                    </div>
                  </div>
                ) : (
                  <span className={styles.sectionMuted}>{t("task.detail.side.noCards")}</span>
                )}
                {reviewer ? (
                  <div className={styles.whoRow}>
                    <span className={`${styles.whoAvatar} ${styles.whoAvatarRv}`}>RV</span>
                    <div>
                      <div className={styles.whoName}>{reviewer.label ?? "REVISOR"}</div>
                      <div className={styles.whoMeta}>{reviewer.provider ?? reviewer.role}</div>
                    </div>
                  </div>
                ) : (
                  facts.review !== "wanted" && (
                    <div className={styles.whoRow} style={{ opacity: 0.75 }}>
                      <span className={`${styles.whoAvatar} ${styles.whoAvatarEmpty}`}>+</span>
                      <span className={styles.sectionMuted}>Sem revisor (não exigido)</span>
                    </div>
                  )
                )}
              </section>
            )}
            {!superseded && (
              <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <h2 className={styles.sectionKicker}>{t("task.detail.side.depends")}</h2>
                {waiting ? (
                  <button type="button" className={styles.link} onClick={() => onOpenTask(waiting.depId)}>
                    #{shortTaskId(waiting.depId)}
                  </button>
                ) : (
                  <span className={styles.sectionMuted}>{t("task.detail.side.none")}</span>
                )}
                <h2 className={styles.sectionKicker} style={{ marginTop: 6 }}>
                  {t("task.detail.side.blocks")}
                </h2>
                <span className={styles.sectionMuted}>{t("task.detail.side.none")}</span>
              </section>
            )}
            <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <h2 className={styles.sectionKicker}>{t("task.detail.side.details")}</h2>
              <div className={styles.detailRow} data-part="task-detail-creator">
                <span className={styles.detailLabel}>{t("task.detail.side.createdBy")}</span>
                <span>{creator ? t("task.detail.createdBy", { actor: creator }) : "—"}</span>
              </div>
              {!superseded && (
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t("task.detail.side.provider")}</span>
                  <span>{task.provider ?? "—"}</span>
                </div>
              )}
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t("task.detail.side.retries")}</span>
                <span>{task.retryCount}</span>
              </div>
              {superseded && task.supersededBy && (
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t("task.detail.side.supersededBy")}</span>
                  <button type="button" className={styles.link} onClick={() => onOpenTask(task.supersededBy!)}>
                    #{shortTaskId(task.supersededBy)}
                  </button>
                </div>
              )}
            </section>
          </aside>
        </div>
      </section>
    </div>,
    host,
  );
}
