import { t } from "../../shared/i18n";
import { Popover } from "./Popover";

const WIDTH_PRESETS: { value: number; labelKey: "pen.thin" | "pen.medium" | "pen.thick" }[] = [
  { value: 1.5, labelKey: "pen.thin" },
  { value: 3, labelKey: "pen.medium" },
  { value: 6, labelKey: "pen.thick" },
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
        <label>{t("pen.size")}</label>
        <div className="pen-size-row">
          {WIDTH_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`pen-size-btn${width === p.value ? " active" : ""}`}
              title={t(p.labelKey)}
              onClick={() => setWidth(p.value)}
            >
              <span className="pen-size-dot" style={{ width: 3 + p.value * 1.6, height: 3 + p.value * 1.6 }} />
            </button>
          ))}
        </div>
      </div>
      <div className="popover-field">
        <label>{t("pen.typeLabel")}</label>
        <div className="pen-type-row">
          <button className={`pen-type-btn${style === "solid" ? " active" : ""}`} onClick={() => setStyle("solid")}>
            {t("pen.stroke")}
          </button>
          <button className={`pen-type-btn${style === "marker" ? " active" : ""}`} onClick={() => setStyle("marker")}>
            {t("pen.marker")}
          </button>
        </div>
      </div>
      <div className="popover-field">
        <label>{t("pen.colorLabel")}</label>
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
          <kbd>V</kbd> {t("shortcuts.desc.pointer")}
        </span>
        <span>
          <kbd>P</kbd> {t("shortcuts.desc.pen")}
        </span>
        <span>
          <kbd>C</kbd> {t("shortcuts.desc.connector")}
        </span>
        <span>
          <kbd>S</kbd> {t("shortcuts.desc.select")}
        </span>
        <span>
          <kbd>Esc</kbd> {t("pen.exit")}
        </span>
      </div>
    </Popover>
  );
}
