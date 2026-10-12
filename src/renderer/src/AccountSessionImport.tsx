import { useState } from "react";
import { t } from "../../shared/i18n";
import type { BoardRow } from "../../preload/index";
import { useModal } from "./useModal";
import styles from "./AccountSessionImport.module.css";

/**
 * Brings sessions kept on this machine into the account profile in view. They
 * move: after the import they belong to that profile and leave the local list.
 */
export function AccountSessionImport({
  boards,
  targetName,
  onImport,
  onClose,
}: {
  boards: BoardRow[];
  targetName: string;
  onImport: (ids: string[]) => void;
  onClose: () => void;
}) {
  const { modalProps } = useModal({ onClose });
  const [picked, setPicked] = useState<Set<string>>(() => new Set(boards.map((b) => b.id)));

  function toggle(id: string, on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal" {...modalProps} aria-labelledby="account-import-title" data-role="account-import">
        <h3 id="account-import-title">{t("accountImport.title")}</h3>
        <p>{t("accountImport.sub", { name: targetName })}</p>
        <div className={styles.list}>
          {boards.map((b) => (
            <label key={b.id} className={styles.row}>
              <input type="checkbox" checked={picked.has(b.id)} onChange={(e) => toggle(b.id, e.target.checked)} data-board-id={b.id} />
              <span className={styles.text}>
                <span className={styles.name}>{b.name}</span>
                <span className={styles.path}>{b.cwd}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            {t("confirm.cancel")}
          </button>
          <button type="button" className="primary" disabled={picked.size === 0} data-role="account-import-confirm" onClick={() => onImport([...picked])}>
            {t("accountImport.action", { n: picked.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
