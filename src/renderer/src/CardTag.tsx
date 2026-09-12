import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import { Icon } from "./icons";

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
    <span className="card-tag-group">
      <span className="card-tag" title={t("card.renameHint")} onDoubleClick={startEditing}>
        {label}
      </span>
      {/* Pedido ao vivo (2026-09-02, "Terminal, Revisitado") — o
       * `title="clique duas vezes..."` acima já existia, mas é invisível
       * até passar o mouse por cima do texto certo; sem NENHUM indício
       * visual, renomear ficava um recurso escondido. Este ✎ é o
       * indício. Também é o único lugar que explica O PORQUÊ renomear
       * importa: o label vira o `target` que as ferramentas MCP
       * (list_cards, send_to_card, read_card...) aceitam pra mirar este
       * card — ver mcp-server.ts ("you can pass either the id or the
       * card's label"). `data-no-drag`: mesmo motivo do `<input>` acima,
       * um clique aqui não pode também iniciar um arraste de header.
       */}
      <button
        type="button"
        className="card-tag-rename-hint"
        data-no-drag
        title={t("card.renameableTitle")}
        onClick={startEditing}
        tabIndex={-1}
      >
        <Icon name="rename" size={10} />
      </button>
    </span>
  );
}
