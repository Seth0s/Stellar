import { useState } from "react";
import { PathPicker } from "./PathPicker";
import { useOccludesChrome } from "./occlusion";
import type { SessionTemplate } from "./useBoardStore";

type Board = { id: string; name: string; cwd: string };

const TEMPLATES: { value: SessionTemplate; label: string; desc: string }[] = [
  { value: "empty", label: "Vazio", desc: "nenhum card" },
  { value: "claude-bash-files", label: "Claude + bash + arquivos", desc: "3 cards já arrumados" },
];

/**
 * DESIGN-BACKLOG.md item 11 — the session popover used to mix three
 * different flows (switch/edit/create) in one cramped space. This is the
 * dedicated modal that create and edit now share (same fields, same
 * layout) — Topbar.tsx's popover is left as a pure switcher: pick a
 * session, or hit the pencil/"+ nova sessão" to land here.
 *
 * Item 1 revisited (2026-08-27) — "projeto" was a free-text label with no
 * real connection to where the session's terminals actually spawned
 * (always DEFAULT_CWD, see App.tsx). The field is now "caminho do
 * projeto": a real absolute path, picked via PathPicker's tree, and it
 * IS the session's cwd — no separate label to keep in sync.
 */
type SessionModalProps =
  | {
      mode: "create";
      defaultCwd: string;
      workspaceRoot: string;
      onChangeRoot: () => void;
      onNavigateRoot: (path: string) => void;
      onCreate: (name: string, cwd: string, template: SessionTemplate) => void;
      onClose: () => void;
    }
  | {
      mode: "edit";
      board: Board;
      workspaceRoot: string;
      onChangeRoot: () => void;
      onNavigateRoot: (path: string) => void;
      /** Same guard as the old inline delete button — never let the last session go. */
      canDelete: boolean;
      onSave: (id: string, name: string, cwd: string) => void;
      onDelete: (id: string) => void;
      onClose: () => void;
    };

export function SessionModal(props: SessionModalProps) {
  useOccludesChrome();
  const [name, setName] = useState(props.mode === "create" ? "" : props.board.name);
  const [cwd, setCwd] = useState(
    props.mode === "create" ? props.defaultCwd : props.board.cwd || props.workspaceRoot,
  );
  const [template, setTemplate] = useState<SessionTemplate>("empty");

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (props.mode === "create") props.onCreate(trimmed, cwd, template);
    else props.onSave(props.board.id, trimmed, cwd);
    props.onClose();
  }

  const titleId = "session-modal-title";
  return (
    <div className="modal-root">
      <div className="modal-backdrop" onClick={props.onClose} />
      <div className="modal" role="dialog" aria-labelledby={titleId}>
        <h3 id={titleId}>{props.mode === "create" ? "Nova sessão" : "Editar sessão"}</h3>
        <div className="popover-field">
          <label>nome</label>
          <input
            className="resume-input"
            autoFocus
            value={name}
            placeholder="nome da sessão"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") props.onClose();
            }}
          />
        </div>
        <div className="popover-field">
          <label>caminho do projeto</label>
          <PathPicker
            root={props.workspaceRoot}
            value={cwd}
            onChange={setCwd}
            onChangeRoot={props.onChangeRoot}
            onNavigateRoot={props.onNavigateRoot}
            className="popover--modal"
          />
        </div>
        {props.mode === "create" && (
          <div className="popover-field">
            <label>template</label>
            <div className="template-picker">
              {TEMPLATES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`template-option${template === t.value ? " active" : ""}`}
                  onClick={() => setTemplate(t.value)}
                >
                  <span className="template-option-label">{t.label}</span>
                  <span className="template-option-desc">{t.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className={props.mode === "edit" ? "modal-actions modal-actions-split" : "modal-actions"}>
          {props.mode === "edit" && (
            <button
              type="button"
              className="danger"
              disabled={!props.canDelete}
              title={props.canDelete ? "Excluir sessão" : "não é possível excluir a última sessão"}
              onClick={() => {
                props.onDelete(props.board.id);
                props.onClose();
              }}
            >
              Excluir
            </button>
          )}
          <div className="modal-actions-right">
            <button type="button" className="ghost" onClick={props.onClose}>
              Cancelar
            </button>
            <button type="button" className="primary" onClick={submit}>
              {props.mode === "create" ? "Criar" : "Salvar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
