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

const CUSTOM_PROJECT = "__custom__";

/** A real picker (real sibling project directories under the workspace,
 * plus whatever's already in use) instead of a bare text box — the user
 * asked to *select* a workspace, not type one blind. Falls back to free
 * text only when "+ novo projeto" is chosen, so a name that isn't (yet) a
 * real directory still works. */
function ProjectPicker({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [customMode, setCustomMode] = useState(!value || !options.includes(value));
  if (customMode) {
    return (
      <div className="project-picker">
        <input
          className="resume-input"
          placeholder="nome do projeto"
          value={value}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
        {options.length > 0 && (
          <button type="button" className="project-picker-back" onClick={() => setCustomMode(false)}>
            escolher da lista
          </button>
        )}
      </div>
    );
  }
  return (
    <select
      className="resume-input"
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM_PROJECT) {
          setCustomMode(true);
          onChange("");
        } else {
          onChange(e.target.value);
        }
      }}
    >
      {!value && <option value="">selecione…</option>}
      {options.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
      <option value={CUSTOM_PROJECT}>+ novo projeto…</option>
    </select>
  );
}

export function Topbar({
  boards,
  activeBoardId,
  boardCounts,
  suggestedProject,
  availableProjects,
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
  /** Real sibling directories under the workspace (see App.tsx's WORKSPACE_ROOT) — best-effort, can be empty. */
  availableProjects: string[];
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
  const allProjectOptions = Array.from(
    new Set([...availableProjects, ...boards.map((b) => b.project).filter(Boolean)]),
  ).sort((a, b) => a.localeCompare(b));

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
                        <ProjectPicker
                          options={allProjectOptions}
                          value={b.project}
                          onChange={(v) => onChangeProject(b.id, v)}
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
          <ProjectPicker options={allProjectOptions} value={newBoardProject} onChange={setNewBoardProject} />
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
