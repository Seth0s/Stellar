import { useState } from "react";
import { t } from "../../shared/i18n";
import type { AccountSessionFolderChoice, AccountSessionProjectRef } from "../../preload/index";
import { candidateLabelKey, projectRefParts } from "./account-session-decision";
import { weave } from "./account-session-text";
import { useModal } from "./useModal";
import styles from "./AccountSession.module.css";

/**
 * No clone of the project was found on this computer: pick the folder (one the
 * app found, one typed, or the system dialog), or open without one. The choice
 * stays on this machine; the path never goes to the account.
 */
export function AccountSessionFolder({
  name,
  projectRef,
  candidates,
  missing,
  onChoose,
  onClose,
}: {
  name: string;
  projectRef: AccountSessionProjectRef | null;
  candidates: readonly { path: string; match: "remote" | "name" }[];
  /** The last chosen folder did not exist here. */
  missing?: boolean;
  onChoose: (choice: AccountSessionFolderChoice) => void;
  onClose: () => void;
}) {
  const { modalProps } = useModal({ onClose });
  const [path, setPath] = useState(candidates[0]?.path ?? "");
  const ref = projectRefParts(projectRef);

  async function pick() {
    const picked = await window.fs.pickDirectory(path || window.system.homeDir).catch(() => null);
    if (picked) setPath(picked);
  }

  return (
    <div className="modal-root" onWheel={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="modal-backdrop" onClick={onClose} />
      <div className={`modal ${styles.modalMid}`} {...modalProps} aria-labelledby="account-session-folder-title" data-role="account-session-folder">
        <div className={styles.dialog}>
          <h3 id="account-session-folder-title" className={styles.title}>
            {t("accountSession.folder.title")}
          </h3>
          <p className={styles.lede}>
            {weave(
              ref.kind === "git"
                ? t("accountSession.folder.textGit", { name: "[[name]]", ref: "[[ref]]" })
                : t("accountSession.folder.textFolder", { name: "[[name]]", ref: "[[ref]]" }),
              { "[[name]]": <strong>{name}</strong>, "[[ref]]": <code>{ref.text || name}</code> },
            )}
          </p>
          {candidates.length > 0 ? (
            <div>
              <div className={styles.colHead}>{t("accountSession.folder.found")}</div>
              <div className={styles.candidates}>
                {candidates.map((c) => (
                  <button key={c.path} type="button" className={styles.candidate} aria-pressed={path === c.path} onClick={() => setPath(c.path)}>
                    <span className={styles.candidatePath}>{c.path}</span>
                    <span className={styles.candidateMeta}>{t(candidateLabelKey(c.match))}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <div className={styles.fieldLabel}>{t("accountSession.folder.typePath")}</div>
            <div className={styles.pathRow}>
              <input
                className={styles.pathInput}
                value={path}
                spellCheck={false}
                data-role="account-session-folder-path"
                onChange={(e) => setPath(e.target.value)}
              />
              <button type="button" className={styles.ghost} onClick={() => void pick()}>
                {t("accountSession.folder.pick")}
              </button>
            </div>
          </div>
          {missing ? <div className={styles.error}>{t("accountSession.folder.missing")}</div> : null}
          <p className={styles.choiceHint}>{t("accountSession.folder.note")}</p>
          <div className="modal-actions">
            <button type="button" className="ghost" data-role="account-session-folder-none" onClick={() => onChoose({ kind: "none" })}>
              {t("accountSession.folder.without")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={path.trim() === ""}
              data-role="account-session-folder-use"
              onClick={() => onChoose({ kind: "path", path: path.trim() })}
            >
              {t("accountSession.folder.use")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
