import { useRef, useState } from "react";
import { Icon } from "./icons";
import { Popover } from "./Popover";

type Board = { id: string; name: string };

export function Topbar({
  boards,
  activeBoardId,
  cardCount,
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onSwitchBoard,
  onCreateBoard,
  onRenameBoard,
  onDeleteBoard,
}: {
  boards: Board[];
  activeBoardId: string;
  cardCount: number;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onSwitchBoard: (id: string) => void;
  onCreateBoard: (name: string) => void;
  onRenameBoard: (id: string, name: string) => void;
  onDeleteBoard: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newBoardName, setNewBoardName] = useState("");
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const activeBoard = boards.find((b) => b.id === activeBoardId);

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
    onCreateBoard(name);
    setNewBoardName("");
  }

  return (
    <div className="topbar">
      <button ref={titleBtnRef} className="topbar-title" onClick={() => setOpen((o) => !o)}>
        📁 {activeBoard?.name ?? "board"} · {cardCount} card{cardCount === 1 ? "" : "s"}
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover anchorRef={titleBtnRef} open={open} onClose={() => setOpen(false)}>
        <div className="board-list">
          {boards.map((b) => (
            <div key={b.id} className={`board-row${b.id === activeBoardId ? " active" : ""}`}>
              {renamingId === b.id ? (
                <input
                  className="resume-input"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <button
                  className="board-row-name"
                  onClick={() => {
                    onSwitchBoard(b.id);
                    setOpen(false);
                  }}
                >
                  {b.name}
                </button>
              )}
              <button title="Renomear" onClick={() => startRename(b)}>
                <Icon name="pen" size={13} />
              </button>
              <button
                title="Excluir board"
                disabled={boards.length <= 1}
                onClick={() => onDeleteBoard(b.id)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="popover-actions board-create">
          <input
            className="resume-input"
            placeholder="novo board…"
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
        <button onClick={onFit} title="Ajustar à tela">
          <Icon name="fit" size={16} />
        </button>
      </div>
    </div>
  );
}
