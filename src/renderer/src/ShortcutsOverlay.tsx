import { useOccludesChrome } from "./occlusion";

/**
 * `?` opens this from anywhere (App.tsx's global keydown, same guard as the
 * tool shortcuts — never fires while typing into a real input). The tool
 * shortcuts themselves are also listed inline in PenPanel, but that's only
 * visible once the pen tool is already open; this is the actual
 * discoverable, ask-anytime version (see DESIGN-BACKLOG.md item 1).
 */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  useOccludesChrome();
  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal shortcuts-modal" role="dialog" aria-labelledby="shortcuts-title">
        <h3 id="shortcuts-title">Atalhos</h3>
        <div className="shortcuts-grid">
          <div className="shortcuts-group">
            <div className="shortcuts-group-label">Ferramentas</div>
            <div className="shortcuts-row">
              <kbd>V</kbd> ponteiro
            </div>
            <div className="shortcuts-row">
              <kbd>P</kbd> caneta
            </div>
            <div className="shortcuts-row">
              <kbd>C</kbd> conector
            </div>
            <div className="shortcuts-row">
              <kbd>S</kbd> seleção
            </div>
            <div className="shortcuts-row">
              <kbd>Esc</kbd> voltar ao ponteiro
            </div>
          </div>
          <div className="shortcuts-group">
            <div className="shortcuts-group-label">Janela</div>
            <div className="shortcuts-row">
              <kbd>F11</kbd> tela cheia
            </div>
            <div className="shortcuts-row">
              <kbd>?</kbd> esta tela
            </div>
          </div>
          <div className="shortcuts-group">
            <div className="shortcuts-group-label">Card</div>
            <div className="shortcuts-row">
              <kbd>2×clique</kbd> renomear (na tag do header)
            </div>
            <div className="shortcuts-row">
              <kbd>Ctrl+C</kbd> interromper terminal (botão ^C do header)
            </div>
            <div className="shortcuts-row">
              <kbd>Ctrl+D</kbd> duplicar o card no topo (mesmo provider/cwd/etc)
            </div>
          </div>
          <div className="shortcuts-group">
            <div className="shortcuts-group-label">Mouse</div>
            <div className="shortcuts-row">
              <kbd>scroll</kbd> zoom
            </div>
            <div className="shortcuts-row">
              <kbd>arrastar fundo</kbd> mover a tela (ponteiro)
            </div>
            <div className="shortcuts-row">
              <kbd>arrastar header</kbd> mover um card
            </div>
            <div className="shortcuts-row">
              <kbd>arrastar canto</kbd> redimensionar um card
            </div>
          </div>
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
