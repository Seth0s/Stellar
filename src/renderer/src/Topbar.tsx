import { useRef, useState } from "react";
import { Icon } from "./icons";
import { Popover } from "./Popover";

type Board = { id: string; name: string; project: string };
type Counts = { agents: number; active: number };

const UNGROUPED_LABEL = "sem projeto";

/** Groups boards by `project`, preserving each group's first-seen order —
 * boards are already fetched ordered by created_at, so this reads as
 * "oldest project first", matching the artifact's CENTRAL/IDYPLATFORM
 * layout without a separate sort pass. */
function groupByProject(boards: Board[]): [string, Board[]][] {
  const order: string[] = [];
  const groups = new Map<string, Board[]>();
  for (const b of boards) {
    const key = b.project || UNGROUPED_LABEL;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(b);
  }
  return order.map((k) => [k, groups.get(k)!]);
}

function StatusDot({ counts }: { counts?: Counts }) {
  const cls = !counts || counts.agents === 0 ? "" : counts.active > 0 ? "ok" : "";
  return <span className={`card-status-dot${cls ? ` ${cls}` : ""}`} />;
}

export function Topbar({
  boards,
  activeBoardId,
  boardCounts,
  suggestedProject,
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onSwitchBoard,
  onCreateBoard,
  onRenameBoard,
  onChangeProject,
  onDeleteBoard,
}: {
  boards: Board[];
  activeBoardId: string;
  boardCounts: Record<string, Counts>;
  suggestedProject: string;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onSwitchBoard: (id: string) => void;
  onCreateBoard: (name: string, project: string) => void;
  onRenameBoard: (id: string, name: string) => void;
  onChangeProject: (id: string, project: string) => void;
  onDeleteBoard: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardProject, setNewBoardProject] = useState(suggestedProject);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const activeBoard = boards.find((b) => b.id === activeBoardId);
  const activeCounts = boardCounts[activeBoardId];

  function startRename(b: Board) {
    setRenamingId(b.id);
    setRenameValue(b.name);
  }

  function commitRename() {
    if (renamingId && renameValue.trim()) onRenameBoard(renamingId, renameValue.trim());
    setRenamingId(null);
  }

  function createBoard() {
    const name = newBoardName.trim();
    if (!name) return;
    onCreateBoard(name, newBoardProject.trim());
    setNewBoardName("");
  }

  return (
    <div className="topbar">
      <button ref={titleBtnRef} className="topbar-title" onClick={() => setOpen((o) => !o)}>
        📁 Projects
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
                    {renamingId === b.id ? (
                      <div className="board-row-edit">
                        <input
                          className="resume-input"
                          value={renameValue}
                          autoFocus
                          placeholder="nome"
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={commitRename}
                        />
                        <input
                          className="resume-input"
                          defaultValue={b.project}
                          placeholder="projeto"
                          onBlur={(e) => onChangeProject(b.id, e.target.value.trim())}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      </div>
                    ) : (
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
                    )}
                    <button title="Renomear/mudar projeto" onClick={() => startRename(b)}>
                      <Icon name="pen" size={13} />
                    </button>
                    <button
                      title="Excluir sessão"
                      disabled={boards.length <= 1}
                      onClick={() => onDeleteBoard(b.id)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="popover-field">
          <label>projeto</label>
          <input
            className="resume-input"
            placeholder="ex. agent-canvas"
            value={newBoardProject}
            onChange={(e) => setNewBoardProject(e.target.value)}
          />
        </div>
        <div className="popover-actions board-create">
          <input
            className="resume-input"
            placeholder="nova sessão…"
            value={newBoardName}
            onChange={(e) => setNewBoardName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createBoard();
            }}
          />
          <button className="primary" onClick={createBoard}>
            criar
          </button>
        </div>
      </Popover>
      <div className="zoom-pill">
        <button onClick={onZoomOut} title="Diminuir zoom">
          <Icon name="zoomOut" size={16} />
        </button>
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
        <button onClick={onZoomIn} title="Aumentar zoom">
          <Icon name="zoomIn" size={16} />
        </button>
        <button onClick={onFit} title="Ajustar à tela (zoom, não é a tela cheia da janela — veja o botão na barra de título)">
          <Icon name="fit" size={16} />
        </button>
      </div>
    </div>
  );
}
