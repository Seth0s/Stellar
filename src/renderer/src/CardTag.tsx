import { useEffect, useRef, useState } from "react";

/**
 * The small pill in a card's header (provider name, "arquivos", ...) —
 * double-click to rename in place. Shared by every card kind whose header
 * has one, so the rename gesture and its styling stay identical everywhere
 * instead of each card reinventing it.
 */
export function CardTag({ label, onRename }: { label: string; onRename: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function startEditing() {
    setDraft(label);
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== label) onRename(trimmed);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-no-drag
        className="card-tag-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={commit}
      />
    );
  }
  return (
    <span className="card-tag" data-no-drag title="clique duas vezes para renomear" onDoubleClick={startEditing}>
      {label}
    </span>
  );
}
