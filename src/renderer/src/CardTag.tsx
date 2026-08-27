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
  // Reported live (2026-08-27) — "facilitar área de drag, é difícil fazer
  // o drag atual no header, parece uma área efetiva muito pequena": this
  // pill is often the most visually "grabbable" part of the header, but
  // `data-no-drag` here (CardFrame.tsx's onHeaderPointerDown excludes it)
  // blocked a drag from ever starting on it at all, only left it started
  // from the empty strip AROUND the label/buttons. Dropped `data-no-drag`
  // — starting a drag here now works like the rest of the header; the
  // double-click still enters rename below (its own single clicks each
  // just commit a ~0px no-op drag first, imperceptible). Kept only on the
  // active `<input>` above, which genuinely must not start a drag.
  return (
    <span className="card-tag" title="clique duas vezes para renomear" onDoubleClick={startEditing}>
      {label}
    </span>
  );
}
