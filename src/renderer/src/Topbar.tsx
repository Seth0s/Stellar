import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import { SessionModal } from "./SessionModal";
import { useAgentAvailability } from "./useAgentAvailability";
import type { SessionTemplate } from "./useBoardStore";
import { groupByProject, StatusDot, type Board, type BoardCounts as Counts } from "./sessions";
import { t } from "../../shared/i18n";
import { GlobalComposer } from "./GlobalComposer";

type ModalState = { mode: "create" } | { mode: "edit"; board: Board } | null;

export function Topbar({
  boards,
  activeBoardId,
  boardCounts,
  rootName,
  workspaceRoot,
  defaultCwd,
  onChangeRoot,
  onNavigateRoot,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  bgStyleLabel,
  onCycleBgStyle,
  onOpenRemote,
  onGoHome,
  onSwitchBoard,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onSuggestInstall,
  orchestratorCardPresent = true,
}: {
  boards: Board[];
  activeBoardId: string;
  boardCounts: Record<string, Counts>;
  /** Last path segment of the current workspace root — "📁 {rootName}" in
   * the breadcrumb. Was a hardcoded "Projects" until the root itself
   * became changeable (see App.tsx's `workspaceRoot`). */
  rootName: string;
  /** Workspace root — PathPicker's tree is rooted here. */
  workspaceRoot: string;
  /** Starting path for a brand-new session (App.tsx's DEFAULT_CWD). */
  defaultCwd: string;
  /** PathPicker's "mudar pasta raiz" — threaded through to SessionModal. */
  onChangeRoot: () => void;
  onNavigateRoot: (path: string) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** DESIGN-BACKLOG.md item 12, achado 6 — direct entry + slider. `pct` is
   * the target zoom as a whole percentage (e.g. 150 for 150%). */
  onZoomTo: (pct: number) => void;
  bgStyleLabel: string;
  onCycleBgStyle: () => void;
  onOpenRemote: () => void;
  /** DESIGN-BACKLOG.md item 8 — back to the session grid. */
  onGoHome: () => void;
  onSwitchBoard: (id: string) => void;
  onCreateBoard: (name: string, cwd: string, template: SessionTemplate) => void;
  onUpdateBoard: (id: string, name: string, cwd: string) => void;
  onDeleteBoard: (id: string) => void;
  /** Achado ao vivo, 2026-09-03 — botão "abrir terminal" do aviso de CLI
   * ausente abaixo. Mesma ação que já existia (App.tsx's
   * `openInstallTerminal`), só que disparada daqui em vez de um botão que
   * só aparecia depois de um spawn já ter falhado. */
  onSuggestInstall: (providerId: string, command: string) => void;
  /**
   * Whether `activeBoard.orchestrator_card_id` still resolves to a card on
   * this board. Closing a terminal clears the mark in the store — so a
   * missing id means an orphan (manual DB edit, race, or a bug), not the
   * normal close path. We show it honestly and do NOT auto-clear: silent
   * cleanup would hide the inconsistency the human needs to see.
   */
  orchestratorCardPresent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomDraft, setZoomDraft] = useState("");
  const [agentsOpen, setAgentsOpen] = useState(false);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const zoomBtnRef = useRef<HTMLButtonElement>(null);
  const agentsBtnRef = useRef<HTMLButtonElement>(null);
  const activeBoard = boards.find((b) => b.id === activeBoardId);
  const activeCounts = boardCounts[activeBoardId];
  const [fullscreen, setFullscreen] = useState(false);
  const { missing: missingAgents } = useAgentAvailability();

  // 2026-08-27 revisit — real fullscreen (F11, Titlebar.tsx hides the
  // header for it) already worked, but had NO visible trigger at all
  // (deliberately removed earlier as "redundant with F11") — the user
  // kept clicking the zoom-pill's old "ajustar à tela" button (zoom-to-
  // fit, same spot) expecting fullscreen from it instead ("ele apenas faz
  // zoom"). That button is gone now too (item 21, ponto 2 — moved
  // per-card, see CardFrame.tsx's `onFocus`), so this is the only
  // corner-brackets-looking icon left here. Lives in Topbar (not
  // Titlebar) specifically because it stays mounted/reachable even once
  // fullscreen hides the titlebar, giving a visible way back out too, not
  // just F11.
  useEffect(() => {
    window.winControls.isFullscreen().then(setFullscreen);
    const off = window.winControls.onFullscreenChange(setFullscreen);
    return () => {
      off();
    };
  }, []);

  return (
    <>
      {/* Own top-level `position: absolute`, NOT a `.topbar` child — the
          topbar's flex row starts at `left: 72px` (clearing the rail), so a
          button living inside it can never land on the rail's own
          centerline (`left: 12px`, 48px wide). This stacks directly above
          the rail instead, same left/width, reading as one floating column
          instead of two disconnected pieces (bug reported live). */}
      <button className="topbar-home" title={t("topbar.home")} aria-label={t("topbar.homeAria")} onClick={onGoHome}>
        <Icon name="home" size={17} />
      </button>
      <div className="topbar">
        <button
          ref={titleBtnRef}
          className="topbar-title"
          aria-label={t("topbar.sessionCurrent", { name: activeBoard?.name ?? t("topbar.sessionFallback") })}
          onClick={() => setOpen((o) => !o)}
        >
          📁 {rootName}
          <Icon name="chevronDown" size={11} />
          <span className="topbar-crumb-sep">›</span>
          {activeBoard?.project || t("session.ungrouped")}
          <span className="topbar-crumb-sep">›</span>
          <strong>{activeBoard?.name ?? t("topbar.sessionFallback")}</strong>
          {activeBoard?.autonomous && (
            <span className="topbar-autonomous-badge" title={t("topbar.autonomousTitle")}>
              {t("topbar.autonomous")}
            </span>
          )}
          {activeBoard?.orchestrator_card_id && (
            <span
              className={`topbar-orchestrator-badge${orchestratorCardPresent ? "" : " topbar-orchestrator-badge-missing"}`}
              data-role="topbar-orchestrator-badge"
              data-missing={orchestratorCardPresent ? undefined : "true"}
              title={
                orchestratorCardPresent
                  ? t("topbar.orchestratorTitle", { id: activeBoard.orchestrator_card_id })
                  : t("topbar.orchestratorMissingTitle", { id: activeBoard.orchestrator_card_id })
              }
            >
              {orchestratorCardPresent ? t("topbar.orchestrator") : t("topbar.orchestratorMissing")}
            </span>
          )}
          {activeCounts && (
            <span className="topbar-counts">
              <StatusDot counts={activeCounts} />
              {t("home.agentsCount", { agents: activeCounts.agents, active: activeCounts.active })}
            </span>
          )}
        </button>
      {/* Just the switcher now (DESIGN-BACKLOG.md item 11) — pick a session,
          jump to its pencil to edit, or "+ nova sessão" for the dedicated
          create modal. Editing/renaming/deleting a session both moved out
          of this cramped space into SessionModal (mode="edit"), same
          fields/layout as create. */}
      <Popover anchorRef={titleBtnRef} open={open} onClose={() => setOpen(false)}>
        <div className="board-list">
          <div className="board-list-heading">{t("topbar.sessions")}</div>
          {groupByProject(boards).map(([project, group]) => (
            <div key={project} className="board-project-group">
              <div className="board-project-label">{project.toUpperCase()}</div>
              {group.map((b) => {
                const counts = boardCounts[b.id];
                return (
                  <div key={b.id} className={`board-row${b.id === activeBoardId ? " active" : ""}`}>
                    <button
                      className="board-row-name"
                      title={b.cwd || undefined}
                      onClick={() => {
                        onSwitchBoard(b.id);
                        setOpen(false);
                      }}
                    >
                      <span className="board-row-name-line">
                        {b.name}
                        {b.id === activeBoardId && <Icon name="check" size={14} />}
                      </span>
                      <span className="board-row-counts">
                        <StatusDot counts={counts} />
                        {counts
                          ? t("home.agentsCount", { agents: counts.agents, active: counts.active })
                          : t("home.agentsZero")}
                      </span>
                    </button>
                    <button data-role="edit-session" title={t("topbar.editSession")} onClick={() => setModal({ mode: "edit", board: b })}>
                      <Icon name="pen" size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="popover-actions popover-actions-stretch board-create">
          <button
            className="primary"
            onClick={() => {
              setOpen(false);
              setModal({ mode: "create" });
            }}
          >
            {t("topbar.newSession")}
          </button>
        </div>
      </Popover>
      {modal?.mode === "create" && (
        <SessionModal
          mode="create"
          defaultCwd={defaultCwd}
          workspaceRoot={workspaceRoot}
          onChangeRoot={onChangeRoot}
          onNavigateRoot={onNavigateRoot}
          onCreate={onCreateBoard}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.mode === "edit" && (
        <SessionModal
          mode="edit"
          board={boards.find((b) => b.id === modal.board.id) ?? modal.board}
          workspaceRoot={workspaceRoot}
          onChangeRoot={onChangeRoot}
          onNavigateRoot={onNavigateRoot}
          canDelete={boards.length > 1}
          onSave={onUpdateBoard}
          onDelete={onDeleteBoard}
          onClose={() => setModal(null)}
        />
      )}
      <div className="zoom-pill">
        {/* Achado ao vivo, 2026-09-03 — "aviso antes mesmo de abrir um
            agente": checagem proativa (useAgentAvailability.ts), visível
            só quando falta alguma CLI, sempre ANTES de qualquer tentativa
            de spawn (não mais um botão que só aparecia depois de uma
            falha real). */}
        {missingAgents.length > 0 && (
          <button
            ref={agentsBtnRef}
            className="topbar-agents-warn"
            title={t("topbar.missingCli", {
              count: missingAgents.length,
              s: missingAgents.length === 1 ? "" : "s",
            })}
            onClick={() => setAgentsOpen((o) => !o)}
          >
            <Icon name="warning" size={16} />
          </button>
        )}
        <Popover anchorRef={agentsBtnRef} open={agentsOpen} onClose={() => setAgentsOpen(false)}>
          <div className="board-list-heading">{t("topbar.missingCliTitle")}</div>
          <div className="agent-availability-list">
            {missingAgents.map((a) => (
              <div key={a.id} className="agent-availability-row">
                <span>{a.label}</span>
                {a.installCommand && (
                  <button
                    className="agent-availability-install-btn"
                    title={t("topbar.installHint", { cmd: a.installCommand! })}
                    onClick={() => {
                      onSuggestInstall(a.id, a.installCommand!);
                      setAgentsOpen(false);
                    }}
                  >
                    <Icon name="terminal" size={12} />
                    {t("topbar.install")}
                  </button>
                )}
              </div>
            ))}
          </div>
        </Popover>
        <button onClick={onZoomOut} title={t("topbar.zoomOut")} aria-label={t("topbar.zoomOut")}>
          <Icon name="zoomOut" size={16} />
        </button>
        <button
          ref={zoomBtnRef}
          className="zoom-readout"
          title={t("topbar.zoomDrag")}
          aria-label={t("topbar.zoomCurrent", { pct: Math.round(zoom * 100) })}
          onClick={() => {
            setZoomDraft(String(Math.round(zoom * 100)));
            setZoomOpen((o) => !o);
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        {/* DESIGN-BACKLOG.md item 12, achado 6 — direct entry + slider,
            opens to the LEFT (`side="left"`): the zoom-pill sits at
            `.topbar`'s far right, and the default rightward popover would
            overflow off-screen there. */}
        <Popover anchorRef={zoomBtnRef} open={zoomOpen} onClose={() => setZoomOpen(false)} side="left">
          <div className="zoom-popover">
            <input
              className="resume-input zoom-input"
              type="number"
              min={20}
              max={300}
              value={zoomDraft}
              onChange={(e) => setZoomDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const n = Number(zoomDraft);
                  if (Number.isFinite(n)) onZoomTo(n);
                } else if (e.key === "Escape") {
                  setZoomOpen(false);
                }
              }}
              onBlur={() => {
                const n = Number(zoomDraft);
                if (Number.isFinite(n)) onZoomTo(n);
              }}
            />
            <span className="zoom-popover-pct">%</span>
            <input
              className="zoom-slider"
              type="range"
              min={20}
              max={300}
              step={5}
              value={Math.round(zoom * 100)}
              onChange={(e) => {
                setZoomDraft(e.target.value);
                onZoomTo(Number(e.target.value));
              }}
            />
          </div>
        </Popover>
        <button onClick={onZoomIn} title={t("topbar.zoomIn")} aria-label={t("topbar.zoomIn")}>
          <Icon name="zoomIn" size={16} />
        </button>
        <button
          onClick={() => void window.winControls.toggleFullscreen()}
          title={fullscreen ? t("topbar.fullscreenExit") : t("topbar.fullscreenEnter")}
          aria-label={fullscreen ? t("topbar.fullscreenExit") : t("topbar.fullscreen")}
        >
          <Icon name={fullscreen ? "fullscreenExit" : "fullscreenEnter"} size={16} />
        </button>
        <button
          onClick={onCycleBgStyle}
          title={t("topbar.bgTitle", { style: bgStyleLabel })}
          aria-label={t("topbar.bgAria", { style: bgStyleLabel })}
        >
          <Icon name="bgStyle" size={16} />
        </button>
        <button
          onClick={onOpenRemote}
          title={t("topbar.remote")}
          aria-label={t("topbar.remote")}
        >
          <Icon name="remoteControl" size={16} />
        </button>
      </div>
      </div>
      <GlobalComposer boardId={activeBoardId} />
    </>
  );
}
