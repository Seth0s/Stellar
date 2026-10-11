/**
 * Right-click menu on empty canvas — exposes "Nova task aqui" as text
 * (BoardQuickTask.dc.html). Radial spawn ring stays on long-press.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../../shared/i18n";
import styles from "./BoardCanvasMenu.module.css";

export type BoardCanvasMenuProps = {
  x: number;
  y: number;
  onNewTaskHere: () => void;
  onClose: () => void;
};

export function BoardCanvasMenu({ x, y, onNewTaskHere, onClose }: BoardCanvasMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-part='board-canvas-menu']")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      className={styles.menu}
      role="menu"
      aria-label={t("boardCanvasMenu.aria")}
      data-part="board-canvas-menu"
      style={{ left: x, top: y }}
    >
      <button
        type="button"
        role="menuitem"
        className={`${styles.item} ${styles.itemActive}`}
        data-part="board-canvas-new-task"
        onClick={() => {
          onNewTaskHere();
          onClose();
        }}
      >
        {t("radial.quickTask")}
      </button>
    </div>,
    document.body,
  );
}
