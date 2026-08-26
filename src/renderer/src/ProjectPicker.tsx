import { useState } from "react";

const CUSTOM_PROJECT = "__custom__";

const CHANGE_ROOT = "__change_root__";

/** A real picker (real sibling project directories under the workspace,
 * plus whatever's already in use) instead of a bare text box — the user
 * asked to *select* a workspace, not type one blind. Falls back to free
 * text only when "+ novo projeto" is chosen, so a name that isn't (yet) a
 * real directory still works. Shared by Topbar's session switcher and
 * SessionModal (create/edit) — extracted 2026-08-26 when the modal split
 * needed the same picker in a second place.
 *
 * `onChangeRoot` — the workspace root itself ("Projects") was hardcoded
 * with no way to point the app elsewhere; the user asked for that to be
 * navigable, applied to every modal with this field "de forma unificada"
 * (in a unified way). Fixing it here, the one place the project field
 * actually renders, does exactly that — SessionModal's create and edit
 * modes both get it automatically, whichever screen (Home or Topbar)
 * opened the modal, with no separate wiring per call site. */
export function ProjectPicker({
  options,
  value,
  onChange,
  onChangeRoot,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  onChangeRoot: () => void;
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
        <div className="project-picker-links">
          {options.length > 0 && (
            <button type="button" className="project-picker-back" onClick={() => setCustomMode(false)}>
              escolher da lista
            </button>
          )}
          <button type="button" className="project-picker-back" onClick={onChangeRoot}>
            📁 mudar pasta raiz…
          </button>
        </div>
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
        } else if (e.target.value === CHANGE_ROOT) {
          onChangeRoot();
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
      <option value={CHANGE_ROOT}>📁 mudar pasta raiz…</option>
    </select>
  );
}
