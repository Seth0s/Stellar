import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import type { BoardMountProgress as Progress } from "./useBoardMountQueue";

/**
 * Discrete topbar chip with real mount progress (N of M). Hidden when the
 * board is idle; fades out after the last card reports ready.
 */
export function BoardMountProgress({ progress }: { progress: Progress }) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const { ready, total, active } = progress;
  const ratio = total > 0 ? ready / total : 0;

  useEffect(() => {
    if (total === 0) {
      setVisible(false);
      setFading(false);
      return;
    }
    if (active) {
      setVisible(true);
      setFading(false);
      return;
    }
    if (!visible) return;
    setFading(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
      setFading(false);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [active, total, visible]);

  if (!visible || total === 0) return null;

  return (
    <div
      className={`board-mount-progress${fading ? " is-fading" : ""}`}
      data-role="board-mount-progress"
      role="status"
      aria-live="polite"
      aria-label={t("topbar.boardMountProgress", { ready, total })}
    >
      <span
        className="board-mount-progress-fill"
        style={{ transform: `scaleX(${Math.min(1, Math.max(0, ratio))})` }}
      />
      <span className="board-mount-progress-label">
        {t("topbar.boardMountProgress", { ready, total })}
      </span>
    </div>
  );
}
