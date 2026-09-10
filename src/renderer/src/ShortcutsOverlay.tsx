import { Fragment } from "react";
import { useModal } from "./useModal";
import { groupShortcutsForOverlay } from "./shortcut-registry";

/**
 * `?` opens this from anywhere (App.tsx's global keydown, same guard as the
 * tool shortcuts — never fires while typing into a real input).
 *
 * Fase B (atalhos) — o conteúdo abaixo é GERADO a partir de `shortcut-
 * registry.ts` (`groupShortcutsForOverlay`), não mais uma lista escrita à
 * mão mantida em paralelo ao código. Esse era exatamente o problema que
 * motivou a fase B inteira: a overlay antiga chegou a documentar um
 * Ctrl+C que não existe (Ctrl+C sozinho é SIGINT cru pro PTY — quem
 * tentava copiar assim matava o próprio processo) e a omitir o
 * Ctrl+Shift+C real. Como o registro agora é a ÚNICA fonte tanto do que
 * dispara quanto do que aparece aqui, não tem como o texto desta tela
 * divergir de novo sem o registro mudar junto — ver
 * `tests/unit/shortcut-registry.test.ts`.
 */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const { modalProps } = useModal({ onClose });
  const groups = groupShortcutsForOverlay();
  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal shortcuts-modal" {...modalProps} aria-labelledby="shortcuts-title">
        <h3 id="shortcuts-title">Atalhos</h3>
        <div className="shortcuts-grid">
          {groups.map(({ group, rows }) => (
            <div className="shortcuts-group" key={group}>
              <div className="shortcuts-group-label">{group}</div>
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <div className="shortcuts-row">
                    <kbd>{row.display}</kbd> {row.description}
                  </div>
                  {/* Round 3 (achado 1 do review) — aliases (hoje só o par
                      de zoom) NUNCA entram no `<kbd>` acima: a string
                      combinada estourava a coluna de ~248px da modal
                      (max-width 560px, grid de 2 colunas — styles/
                      layout.css), deixando a descrição ilegível. Linha
                      própria, sempre visível — nunca um tooltip (`title`
                      nativo não é confiavelmente acessível por teclado). */}
                  {row.aliasNote && <div className="shortcuts-row-alias">{row.aliasNote}</div>}
                </Fragment>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
