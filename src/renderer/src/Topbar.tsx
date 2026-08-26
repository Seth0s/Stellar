import { useRef, useState } from "react";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import { SessionModal } from "./SessionModal";
import type { SessionTemplate } from "./useBoardStore";
import { groupByProject, StatusDot, UNGROUPED_LABEL, type Board, type BoardCounts as Counts } from "./sessions";

type ModalState = { mode: "create" } | { mode: "edit"; board: Board } | null;

export function Topbar({
  boards,
  activeBoardId,
  boardCounts,
  rootName,
  suggestedProject,
  availableProjects,
  onChangeRoot,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFit,
  bgStyleLabel,
  onCycleBgStyle,
  onOpenRemote,
  onGoHome,
  onSwitchBoard,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
}: {
  boards: Board[];
  activeBoardId: string;
  boardCounts: Record<string, Counts>;
  /** Last path segment of the current workspace root — "📁 {rootName}" in
   * the breadcrumb. Was a hardcoded "Projects" until the root itself
   * became changeable (see App.tsx's `workspaceRoot`). */
  rootName: string;
  suggestedProject: string;
  /** Real sibling directories under the current workspace root — best-effort, can be empty. */
  availableProjects: string[];
  /** ProjectPicker's "mudar pasta raiz" — threaded through to SessionModal. */
  onChangeRoot: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** DESIGN-BACKLOG.md item 12, achado 6 — direct entry + slider. `pct` is
   * the target zoom as a whole percentage (e.g. 150 for 150%). */
  onZoomTo: (pct: number) => void;
  onFit: () => void;
  bgStyleLabel: string;
  onCycleBgStyle: () => void;
  onOpenRemote: () => void;
  /** DESIGN-BACKLOG.md item 8 — back to the session grid. */
  onGoHome: () => void;
  onSwitchBoard: (id: string) => void;
  onCreateBoard: (name: string, project: string, template: SessionTemplate) => void;
  onUpdateBoard: (id: string, name: string, project: string) => void;
  onDeleteBoard: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomDraft, setZoomDraft] = useState("");
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const zoomBtnRef = useRef<HTMLButtonElement>(null);
  const activeBoard = boards.find((b) => b.id === activeBoardId);
  const activeCounts = boardCounts[activeBoardId];
  const allProjectOptions = Array.from(
    new Set([...availableProjects, ...boards.map((b) => b.project).filter(Boolean)]),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <>
      {/* Own top-level `position: absolute`, NOT a `.topbar` child — the
          topbar's flex row starts at `left: 72px` (clearing the rail), so a
          button living inside it can never land on the rail's own
          centerline (`left: 12px`, 48px wide). This stacks directly above
          the rail instead, same left/width, reading as one floating column
          instead of two disconnected pieces (bug reported live). */}
      <button className="topbar-home" title="Voltar pra home" onClick={onGoHome}>
        <Icon name="home" size={17} />
      </button>
      <div className="topbar">
        <button ref={titleBtnRef} className="topbar-title" onClick={() => setOpen((o) => !o)}>
          📁 {rootName}
          <Icon name="chevronDown" size={11} />
          <span className="topbar-crumb-sep">›</span>
          {activeBoard?.project || UNGROUPED_LABEL}
          <span className="topbar-crumb-sep">›</span>
          <strong>{activeBoard?.name ?? "sessão"}</strong>
          {activeCounts && (
            <span className="topbar-counts">
              <StatusDot counts={activeCounts} />
              {activeCounts.agents} agente{activeCounts.agents === 1 ? "" : "s"} · {activeCounts.active} ativo
              {activeCounts.active === 1 ? "" : "s"}
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
          <div className="board-list-heading">SESSÕES</div>
          {groupByProject(boards).map(([project, group]) => (
            <div key={project} className="board-project-group">
              <div className="board-project-label">{project.toUpperCase()}</div>
              {group.map((b) => {
                const counts = boardCounts[b.id];
                return (
                  <div key={b.id} className={`board-row${b.id === activeBoardId ? " active" : ""}`}>
                    <button
                      className="board-row-name"
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
                        {counts ? `${counts.agents} agentes · ${counts.active} ativos` : "0 agentes"}
                      </span>
                    </button>
                    <button title="Editar sessão" onClick={() => setModal({ mode: "edit", board: b })}>
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
            + nova sessão
          </button>
        </div>
      </Popover>
      {modal?.mode === "create" && (
        <SessionModal
          mode="create"
          suggestedProject={suggestedProject}
          availableProjects={allProjectOptions}
          onChangeRoot={onChangeRoot}
          onCreate={onCreateBoard}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.mode === "edit" && (
        <SessionModal
          mode="edit"
          board={modal.board}
          availableProjects={allProjectOptions}
          onChangeRoot={onChangeRoot}
          canDelete={boards.length > 1}
          onSave={onUpdateBoard}
          onDelete={onDeleteBoard}
          onClose={() => setModal(null)}
        />
      )}
      <div className="zoom-pill">
        <button onClick={onZoomOut} title="Diminuir zoom">
          <Icon name="zoomOut" size={16} />
        </button>
        <button
          ref={zoomBtnRef}
          className="zoom-readout"
          title="Digitar zoom ou arrastar"
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
        <button onClick={onZoomIn} title="Aumentar zoom">
          <Icon name="zoomIn" size={16} />
        </button>
        <button onClick={onFit} title="Ajustar à tela (zoom, não é a tela cheia da janela — veja o botão na barra de título)">
          <Icon name="fit" size={16} />
        </button>
        <button onClick={onCycleBgStyle} title={`Fundo do canvas: ${bgStyleLabel} (clique para trocar)`}>
          <Icon name="bgStyle" size={16} />
        </button>
        <button onClick={onOpenRemote} title="Controle remoto (celular, mesma rede local)">
          <Icon name="remoteControl" size={16} />
        </button>
      </div>
      </div>
    </>
  );
}
