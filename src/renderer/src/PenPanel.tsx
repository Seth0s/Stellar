import { Popover } from "./Popover";

const WIDTH_PRESETS: { value: number; label: string }[] = [
  { value: 1.5, label: "fino" },
  { value: 3, label: "médio" },
  { value: 6, label: "grosso" },
];

/**
 * Anchored panel for the pen tool (item 3) — opens to the right of the pen
 * button (Popover's default anchor math), replacing the old single row of
 * color swatches that used to render inline inside the rail column itself
 * (cramped, and missing size/type entirely).
 */
export function PenPanel({
  anchorRef,
  open,
  onClose,
  colors,
  color,
  setColor,
  width,
  setWidth,
  style,
  setStyle,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  colors: readonly string[];
  color: string;
  setColor: (c: string) => void;
  width: number;
  setWidth: (w: number) => void;
  style: "solid" | "marker";
  setStyle: (s: "solid" | "marker") => void;
}) {
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose}>
      <div className="popover-field">
        <label>tamanho</label>
        <div className="pen-size-row">
          {WIDTH_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`pen-size-btn${width === p.value ? " active" : ""}`}
              title={p.label}
              onClick={() => setWidth(p.value)}
            >
              <span className="pen-size-dot" style={{ width: 3 + p.value * 1.6, height: 3 + p.value * 1.6 }} />
            </button>
          ))}
        </div>
      </div>
      <div className="popover-field">
        <label>tipo</label>
        <div className="pen-type-row">
          <button className={`pen-type-btn${style === "solid" ? " active" : ""}`} onClick={() => setStyle("solid")}>
            traço
          </button>
          <button className={`pen-type-btn${style === "marker" ? " active" : ""}`} onClick={() => setStyle("marker")}>
            marcador
          </button>
        </div>
      </div>
      <div className="popover-field">
        <label>cor</label>
        <span className="swatches">
          {colors.map((c) => (
            <button
              key={c}
              className={`swatch${c === color ? " active" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </span>
      </div>
      <div className="pen-shortcuts">
        <span>
          <kbd>V</kbd> ponteiro
        </span>
        <span>
          <kbd>P</kbd> caneta
        </span>
        <span>
          <kbd>C</kbd> conector
        </span>
        <span>
          <kbd>S</kbd> seleção
        </span>
        <span>
          <kbd>Esc</kbd> sair
        </span>
      </div>
    </Popover>
  );
}
