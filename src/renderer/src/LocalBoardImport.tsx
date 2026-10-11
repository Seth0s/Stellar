/**
 * Import from a local board (steps Boards → Prévia → Importar). Follows the
 * local-* states of docs/design/app-v2/prototipo/Import.dc.html. Reads the open
 * tasks through the app's own store bridges and sends them to the team as
 * "json" import jobs of at most 200 rows, one after the other.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import {
  LOCAL_IMPORT_BATCH_SIZE,
  addPreviewTotals,
  chunkRows,
  initialBatches,
  localImportBody,
  newTaskCount,
  openCount,
  pickSample,
  processedLines,
  summarizeBatches,
  totalLines,
  totalOpen,
  totalOutOfScope,
  type LocalBatchState,
  type LocalBoardSummary,
  type LocalImportOutcome,
  type LocalImportRow,
  type LocalPreviewTotals,
  type LocalSampleItem,
} from "./local-board-import-decisions";
import {
  collectLocalImportRows,
  loadLocalBoards,
  type LocalBoardsSnapshot,
  type LocalImportReader,
} from "./local-board-import";
import wiz from "./ImportWizard.module.css";
import s from "./LocalBoardImport.module.css";

export type LocalImportStep = 2 | 3 | 4;

export type LocalBoardImportProps = {
  teamId: string;
  teamName: string;
  canManage: boolean;
  /** Reports the step (2 boards, 3 preview, 4 import) and whether the run ended. */
  onProgress: (step: LocalImportStep, finished: boolean) => void;
  onBoardCount: (n: number) => void;
  /** Back from the first step: returns to the source choice. */
  onBack: () => void;
  onOpenTeamBoard: () => void;
  /** Smoke/tests may inject a reader; the app reads through the store bridges. */
  reader?: LocalImportReader;
};

const windowReader: LocalImportReader = {
  listBoards: async () => (await window.store.boards.list()).map((b) => ({ id: b.id, name: b.name })),
  listBoardTasks: async (boardId) =>
    (await window.tasks.listByBoard(boardId)).map((task) => ({ id: task.id, status: task.status, purpose: task.purpose })),
  getPrompt: (taskId) => window.tasks.getPrompt(taskId),
};

type PreviewData = {
  rows: LocalImportRow[];
  totals: LocalPreviewTotals;
  sample: (LocalSampleItem & { meta: string | null })[];
  outOfScope: number;
};

function boardsLabel(summaries: readonly LocalBoardSummary[], selected: ReadonlySet<string>): string {
  return summaries
    .filter((b) => selected.has(b.id))
    .map((b) => b.name)
    .join(" e ");
}

function capitalize(word: string): string {
  return word === "" ? word : word[0].toUpperCase() + word.slice(1);
}

function stripJsonPrefix(externalId: string): string {
  return externalId.startsWith("json:") ? externalId.slice("json:".length) : externalId;
}

export function LocalBoardImport({
  teamId,
  teamName,
  canManage,
  onProgress,
  onBoardCount,
  onBack,
  onOpenTeamBoard,
  reader = windowReader,
}: LocalBoardImportProps) {
  const [step, setStep] = useState<LocalImportStep>(2);
  const [snapshot, setSnapshot] = useState<LocalBoardsSnapshot | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [ack, setAck] = useState(false);
  const [batches, setBatches] = useState<LocalBatchState[]>([]);
  const [running, setRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [outcome, setOutcome] = useState<LocalImportOutcome | null>(null);
  const stopRef = useRef(false);
  const mountedRef = useRef(true);
  const previewSeq = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const goTo = useCallback(
    (next: LocalImportStep, finished = false) => {
      setStep(next);
      onProgress(next, finished);
    },
    [onProgress],
  );

  const loadBoards = useCallback(async () => {
    setError(null);
    setSnapshot(null);
    try {
      const loaded = await loadLocalBoards(reader);
      if (!mountedRef.current) return;
      setSnapshot(loaded);
      onBoardCount(loaded.summaries.length);
      setSelected(new Set(loaded.summaries.filter((b) => openCount(b) > 0).map((b) => b.id)));
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error && e.message ? e.message : t("teamImport.local.readError"));
    }
  }, [reader, onBoardCount]);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  const summaries = useMemo(() => snapshot?.summaries ?? [], [snapshot]);
  const selectedOpen = totalOpen(summaries, selected);
  const selectedOut = totalOutOfScope(summaries, selected);
  const selectedBoards = summaries.filter((b) => selected.has(b.id));

  const toggleBoard = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const loadPreview = async () => {
    if (!snapshot || !canManage) return;
    const seq = ++previewSeq.current;
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    setAck(false);
    goTo(3);
    try {
      const { rows, boardOf } = await collectLocalImportRows(reader, snapshot, selected);
      let totals: LocalPreviewTotals = { total: 0, duplicates: 0 };
      let sampleSource: LocalSampleItem[] = [];
      const chunks = chunkRows(rows);
      for (let i = 0; i < chunks.length; i++) {
        const res = await window.team.previewImport(teamId, localImportBody(chunks[i]));
        if (!res.ok) throw new Error(res.error);
        totals = addPreviewTotals(totals, { total: res.preview.total, duplicates: res.preview.duplicates });
        if (i === 0) sampleSource = res.preview.items.map((it) => ({ title: it.title, externalId: it.externalId, duplicate: it.duplicate, existingRef: it.existingRef }));
      }
      if (!mountedRef.current || seq !== previewSeq.current) return;
      const byExternal = new Map(rows.map((r) => [r.external_id, r]));
      const sample = pickSample(sampleSource).map((item) => {
        const key = stripJsonPrefix(item.externalId);
        const row = byExternal.get(key);
        const meta = row ? `${capitalize(row.kind)} · ${boardOf.get(key) ?? ""} · local:${key.slice("local:".length, "local:".length + 8)}` : null;
        return { ...item, meta };
      });
      const dropped = selectedOpen - rows.length;
      setPreview({ rows, totals, sample, outOfScope: selectedOut + Math.max(0, dropped) });
      setPreviewLoading(false);
    } catch (e) {
      if (!mountedRef.current || seq !== previewSeq.current) return;
      setPreviewLoading(false);
      setError(e instanceof Error && e.message ? e.message : t("teamImport.local.readError"));
    }
  };

  const runImport = async () => {
    if (!preview || !canManage || !ack || running) return;
    const chunks = chunkRows(preview.rows);
    const state = initialBatches(preview.rows.length);
    stopRef.current = false;
    setStopRequested(false);
    setOutcome(null);
    setError(null);
    setBatches(state);
    setRunning(true);
    goTo(4);
    let stopped = false;
    for (let i = 0; i < chunks.length; i++) {
      if (stopRef.current) {
        stopped = true;
        break;
      }
      state[i] = { ...state[i], status: "running" };
      if (mountedRef.current) setBatches([...state]);
      const res = await window.team.createImport(teamId, localImportBody(chunks[i]));
      if (!res.ok || res.job.status === "failed") {
        const message = !res.ok ? res.error : res.job.error || res.job.status;
        state[i] = { ...state[i], status: "failed", error: message };
        if (mountedRef.current) setBatches([...state]);
        break;
      }
      state[i] = { ...state[i], status: "done", created: res.job.createdCount, skipped: res.job.skippedCount };
      if (mountedRef.current) setBatches([...state]);
    }
    if (!mountedRef.current) return;
    setOutcome(summarizeBatches(state, stopped));
    setRunning(false);
    onProgress(4, true);
  };

  const pickAnother = () => {
    setPreview(null);
    setOutcome(null);
    setBatches([]);
    setAck(false);
    goTo(2);
    void loadBoards();
  };

  const batchCount = Math.max(1, Math.ceil((preview?.rows.length ?? 0) / LOCAL_IMPORT_BATCH_SIZE));
  const live = batches.reduce((sum, b) => sum + b.created, 0);
  const liveSkipped = batches.reduce((sum, b) => sum + b.skipped, 0);
  const currentBatch = Math.max(1, batches.findIndex((b) => b.status === "running") + 1 || batches.filter((b) => b.status === "done").length);
  const done = processedLines(batches);
  const total = totalLines(batches);

  function dupLabel(item: LocalSampleItem): string {
    if (!item.existingRef) return t("teamImport.local.dupPlain");
    const ref = item.existingRef.startsWith("#") ? item.existingRef : `#${item.existingRef}`;
    return t("teamImport.local.dupExisting", { ref });
  }

  const outcomeTitle = outcome?.error
    ? t("teamImport.local.errorTitle")
    : outcome?.stopped
      ? t("teamImport.local.stoppedTitle")
      : t("teamImport.local.doneTitle");

  return (
    <main className={wiz.main}>
      {step === 2 ? (
        <section className={s.panel} data-part="local-pick">
          <div className={wiz.scroll}>
            {!canManage ? <div className={wiz.readonlyBanner}>{t("teamImport.memberReadonly")}</div> : null}
            <div>
              <h1 className={wiz.title}>{t("teamImport.local.pickTitle")}</h1>
              <p className={wiz.lead}>{t("teamImport.local.pickLead", { team: teamName })}</p>
            </div>
            {error ? <div className={wiz.error}>{error}</div> : null}
            {!snapshot && !error ? <p className={s.hint}>{t("teamImport.local.boardsLoading")}</p> : null}
            {snapshot && summaries.length === 0 ? <p className={s.hint}>{t("teamImport.local.boardsNone")}</p> : null}
            {snapshot && summaries.length > 0 ? (
              <div className={`${wiz.mapCard} ${s.card}`} data-part="local-boards">
                <div className={s.listHead}>
                  <span>{t("teamImport.local.boardsHead")}</span>
                  <span>{t("teamImport.local.tasksHead")}</span>
                </div>
                {summaries.map((b) => {
                  const open = openCount(b);
                  const off = open === 0;
                  return (
                    <label key={b.id} className={`${s.board} ${off ? s.boardOff : ""}`} data-part="local-board" data-board-id={b.id}>
                      <input
                        type="checkbox"
                        checked={selected.has(b.id)}
                        disabled={off || !canManage}
                        onChange={() => toggleBoard(b.id)}
                      />
                      <span className={s.boardText}>
                        <span className={s.boardName}>{b.name}</span>
                        <span className={s.boardSub}>
                          {off
                            ? t("teamImport.local.boardSubEmpty", { other: String(b.other) })
                            : t("teamImport.local.boardSub", { pending: String(b.pending), blocked: String(b.blocked), other: String(b.other) })}
                        </span>
                      </span>
                      <span className={`${s.pill} ${off ? s.pillMute : s.pillInfo}`}>{t("teamImport.local.openCount", { n: String(open) })}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
            {snapshot && summaries.length > 0 ? (
              <>
                <div className={`${s.box} ${s.boxInfo}`} data-part="local-scope">
                  {t("teamImport.local.scopeA")}
                  <strong>{t("teamImport.local.scopeB")}</strong>
                  {t("teamImport.local.scopeC", { n: String(selectedOut) })}
                </div>
                <p className={s.hint}>{t("teamImport.local.idNote")}</p>
              </>
            ) : null}
          </div>
          <div className={wiz.footer}>
            <span className={s.footNote} data-part="local-selection">
              {t(selectedBoards.length === 1 ? "teamImport.local.selectionOne" : "teamImport.local.selectionMany", {
                boards: String(selectedBoards.length),
                n: String(selectedOpen),
              })}
            </span>
            <button type="button" className={wiz.ghost} data-part="import-back" onClick={onBack}>
              {t("teamImport.back")}
            </button>
            <button
              type="button"
              className={wiz.primary}
              data-part="local-to-preview"
              disabled={!canManage || !snapshot || selectedOpen === 0}
              onClick={() => void loadPreview()}
            >
              {t("teamImport.local.previewCta", { n: String(selectedOpen) })}
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className={s.panel} data-part="local-preview">
          <div className={wiz.scroll}>
            <div>
              <h1 className={wiz.title}>{t("teamImport.local.reviewTitle")}</h1>
              <p className={wiz.lead}>{t("teamImport.local.reviewLead", { boards: boardsLabel(summaries, selected), team: teamName })}</p>
            </div>
            {error ? <div className={wiz.error}>{error}</div> : null}
            {previewLoading ? <p className={s.hint} data-part="local-preview-loading">{t("teamImport.local.previewLoading")}</p> : null}
            {preview && preview.rows.length === 0 ? <p className={s.hint}>{t("teamImport.local.previewNothing")}</p> : null}
            {preview && preview.rows.length > 0 ? (
              <>
                <div className={s.stats} data-part="local-counts">
                  <div className={`${wiz.mapCard} ${s.card} ${s.stat}`}>
                    <span className={`${s.statValue} ${s.toneGood}`} data-part="local-count-new">{newTaskCount(preview.totals)}</span>
                    <span className={s.statLabel}>{t("teamImport.local.countNew")}</span>
                  </div>
                  <div className={`${wiz.mapCard} ${s.card} ${s.stat}`}>
                    <span className={`${s.statValue} ${s.toneWarn}`} data-part="local-count-dup">{preview.totals.duplicates}</span>
                    <span className={s.statLabel}>{t("teamImport.local.countDup")}</span>
                  </div>
                  <div className={`${wiz.mapCard} ${s.card} ${s.stat}`}>
                    <span className={`${s.statValue} ${s.toneMute}`} data-part="local-count-out">{preview.outOfScope}</span>
                    <span className={s.statLabel}>{t("teamImport.local.countOut")}</span>
                  </div>
                </div>

                <div className={`${s.box} ${s.boxWarn}`} role="note" data-part="local-visibility">
                  <strong>{t("teamImport.local.visibilityStrong")}</strong>
                  {t("teamImport.local.visibilityRest")}
                </div>

                <div className={`${wiz.mapCard} ${s.card}`} data-part="local-not-included">
                  <div className={s.cardTitle}>{t("teamImport.local.notIncluded")}</div>
                  <div className={s.chips}>
                    <span className={`${s.pill} ${s.pillMute}`}>{t("teamImport.local.notDeps")}</span>
                    <span className={`${s.pill} ${s.pillMute}`}>{t("teamImport.local.notCards")}</span>
                    <span className={`${s.pill} ${s.pillMute}`}>{t("teamImport.local.notTerritory")}</span>
                    <span className={`${s.pill} ${s.pillMute}`}>{t("teamImport.local.notGates")}</span>
                  </div>
                </div>

                <div className={`${wiz.mapCard} ${s.card}`} data-part="local-mapping">
                  <div className={`${s.mapRowLocal} ${s.mapHeadRow}`}>
                    <span>{t("teamImport.local.mapFrom")}</span>
                    <span />
                    <span>{t("teamImport.local.mapTo")}</span>
                  </div>
                  <div className={s.mapRowLocal}>
                    <span>{t("teamImport.local.mapTitle")}</span>
                    <span className={wiz.mapArrow}>→</span>
                    <span>{t("teamImport.local.mapTitleTo")}</span>
                  </div>
                  <div className={s.mapRowLocal}>
                    <span>{t("teamImport.local.mapPrompt")}</span>
                    <span className={wiz.mapArrow}>→</span>
                    <span>{t("teamImport.local.mapPromptTo")}</span>
                  </div>
                  <div className={s.mapRowLocal}>
                    <span>{t("teamImport.local.mapPurpose")}</span>
                    <span className={wiz.mapArrow}>→</span>
                    <span>{t("teamImport.local.mapPurposeTo")}</span>
                  </div>
                  <div className={s.mapRowLocal}>
                    <span>{t("teamImport.local.mapPriority")}</span>
                    <span className={wiz.mapArrow}>→</span>
                    <span>{t("teamImport.local.mapPriorityTo")}</span>
                  </div>
                  <div className={s.mapRowLocal}>
                    <span>{t("teamImport.local.mapId")}</span>
                    <span className={wiz.mapArrow}>→</span>
                    <span>
                      <span className={s.monoId}>local:&lt;id&gt;</span> · {t("teamImport.local.mapIdTo")}
                    </span>
                  </div>
                </div>

                <div className={s.stack}>
                  <div className={s.sampleHead}>
                    <h2>{t("teamImport.local.sampleTitle", { shown: String(preview.sample.length), total: String(preview.rows.length) })}</h2>
                    <span className={wiz.previewHint}>
                      {batchCount === 1 ? t("teamImport.local.batchesOne") : t("teamImport.local.batchesMany", { n: String(batchCount) })}
                    </span>
                  </div>
                  <div className={`${wiz.mapCard} ${s.card}`} data-part="local-sample">
                    {preview.sample.map((item) => (
                      <label key={item.externalId} className={`${wiz.row} ${s.sampleRow} ${item.duplicate ? wiz.rowDup : ""}`}>
                        <input type="checkbox" checked={!item.duplicate} disabled style={{ marginTop: 3 }} />
                        <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                          <span className={wiz.rowTitle}>{item.title}</span>
                          {item.duplicate ? <span className={wiz.rowDupMeta}>{dupLabel(item)}</span> : <span className={s.rowMetaMono}>{item.meta ?? ""}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </div>
          <div className={wiz.footer}>
            <label className={s.footNote} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={ack}
                disabled={!preview || preview.rows.length === 0 || !canManage}
                data-part="local-ack"
                onChange={(e) => setAck(e.target.checked)}
              />
              {t("teamImport.local.ack")}
            </label>
            <button type="button" className={wiz.ghost} data-part="import-back" onClick={() => goTo(2)}>
              {t("teamImport.back")}
            </button>
            <button
              type="button"
              className={wiz.primary}
              data-part="local-run"
              disabled={!preview || !canManage || !ack || newTaskCount(preview.totals) === 0}
              onClick={() => void runImport()}
            >
              {t("teamImport.local.run", { n: String(preview ? newTaskCount(preview.totals) : 0) })}
            </button>
          </div>
        </section>
      ) : null}

      {step === 4 && running ? (
        <section className={s.panel} data-part="local-running">
          <div className={wiz.scroll}>
            <div>
              <h1 className={wiz.title}>{t("teamImport.local.runningTitle", { n: String(total) })}</h1>
              <p className={wiz.lead}>{t("teamImport.local.runningLead", { batches: String(batches.length) })}</p>
            </div>
            <div className={s.stack} style={{ gap: 8 }} data-part="local-progress">
              <div className={s.progressHead}>
                <span className={s.progressLabel}>{t("teamImport.local.batchOf", { i: String(currentBatch), n: String(batches.length) })}</span>
                <span className={s.progressCount}>{t("teamImport.local.linesOf", { done: String(done), total: String(total) })}</span>
              </div>
              <div
                className={s.bar}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
                aria-label={t("teamImport.local.progressAria")}
              >
                <span className={s.barFill} style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
              </div>
            </div>
            <div className={`${wiz.mapCard} ${s.card}`} data-part="local-batches">
              {batches.map((b, i) => (
                <div key={i} className={s.batch} data-batch-status={b.status}>
                  <span className={`${wiz.n} ${b.status === "done" ? wiz.nDone : b.status === "running" ? wiz.nActive : wiz.nTodo}`}>
                    {b.status === "done" ? "✓" : i + 1}
                  </span>
                  <span className={s.batchText}>
                    <span className={wiz.rowTitle}>{t("teamImport.local.batchName", { i: String(i + 1), lines: String(b.lines) })}</span>
                    <span className={s.boardSub}>
                      {b.status === "done"
                        ? t("teamImport.local.batchDone", { created: String(b.created), skipped: String(b.skipped) })
                        : b.status === "running"
                          ? t("teamImport.local.batchRunning")
                          : t("teamImport.local.batchQueued")}
                    </span>
                  </span>
                  <span className={`${s.pill} ${b.status === "done" ? s.pillOk : b.status === "running" ? s.pillInfo : s.pillMute}`}>
                    {b.status === "done" ? t("teamImport.local.pillDone") : b.status === "running" ? t("teamImport.local.pillRunning") : t("teamImport.local.pillQueued")}
                  </span>
                </div>
              ))}
            </div>
            <p className={s.hint}>{t("teamImport.local.runningHint")}</p>
          </div>
          <div className={wiz.footer}>
            <span className={s.footNoteMute} data-part="local-partial">
              {t("teamImport.local.partial", { created: String(live), skipped: String(liveSkipped) })}
            </span>
            <button
              type="button"
              className={wiz.ghost}
              data-part="local-stop"
              disabled={stopRequested}
              onClick={() => {
                stopRef.current = true;
                setStopRequested(true);
              }}
            >
              {stopRequested ? t("teamImport.local.stopping") : t("teamImport.local.stop")}
            </button>
          </div>
        </section>
      ) : null}

      {step === 4 && !running && outcome ? (
        <section className={s.panel} data-part="local-done">
          <div className={wiz.scroll}>
            <div>
              <h1 className={wiz.title}>{outcomeTitle}</h1>
              <p className={wiz.lead}>
                {outcome.stopped
                  ? t("teamImport.local.stoppedLead", { done: String(outcome.batchesDone), total: String(outcome.batchesTotal) })
                  : t("teamImport.local.doneLead", { boards: boardsLabel(summaries, selected), team: teamName })}
              </p>
            </div>
            {outcome.error ? <div className={`${s.box} ${s.boxError}`} data-part="local-error">{outcome.error}</div> : null}
            <div className={`${s.box} ${s.boxOk}`} data-part="local-result">
              {t("teamImport.local.result", { created: String(outcome.created), skipped: String(outcome.skipped), batches: String(outcome.batchesDone) })}
            </div>
            <div className={s.stats}>
              <div className={`${wiz.mapCard} ${s.card} ${s.stat}`}>
                <span className={`${s.statValue} ${s.toneGood}`} data-part="local-done-created">{outcome.created}</span>
                <span className={s.statLabel}>{t("teamImport.local.statCreated")}</span>
              </div>
              <div className={`${wiz.mapCard} ${s.card} ${s.stat}`}>
                <span className={`${s.statValue} ${s.toneWarn}`} data-part="local-done-skipped">{outcome.skipped}</span>
                <span className={s.statLabel}>{t("teamImport.local.statSkipped")}</span>
              </div>
              <div className={`${wiz.mapCard} ${s.card} ${s.stat}`}>
                <span className={`${s.statValue} ${s.toneMute}`} data-part="local-done-errors">{outcome.notImported}</span>
                <span className={s.statLabel}>{outcome.stopped ? t("teamImport.local.statNotSent") : t("teamImport.local.statErrors")}</span>
              </div>
            </div>
            <div className={`${s.box} ${s.boxInfo}`}>{t("teamImport.local.doneNote")}</div>
          </div>
          <div className={wiz.footer}>
            <span style={{ flex: 1 }} />
            <button type="button" className={wiz.ghost} data-part="local-again" onClick={pickAnother}>
              {t("teamImport.local.again")}
            </button>
            <button type="button" className={wiz.primary} data-part="local-open-board" onClick={onOpenTeamBoard}>
              {t("teamImport.local.openTeamBoard")}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
