import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import type { AccountSessionConflictInfo, AccountSessionFailure, AccountSessionPreview } from "../../preload/index";
import { BOARDS_CHANGED_EVENT, failureMessageKey, failureScreen, projectRefParts } from "./account-session-decision";
import { AccountSessionOffline, AccountSessionPlan } from "./AccountSessionParts";
import { countText, weave } from "./account-session-text";
import { AccountSessionConflict } from "./AccountSessionConflict";
import { useModal } from "./useModal";
import { toast } from "./useToast";
import styles from "./AccountSession.module.css";

type Preview = Extract<AccountSessionPreview, { ok: true }>;

type View =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "conflict"; info: AccountSessionConflictInfo }
  | { kind: "failed"; failure: AccountSessionFailure };

/**
 * "Salvar na conta": says what goes and what stays on this machine before
 * anything is sent, then saves. A revision conflict asks which side stays; a
 * lost connection says nothing was sent; a plan refusal shows the plan card.
 */
export function AccountSessionSave({
  board,
  profileId,
  profileName,
  onClose,
  onSaved,
  onOutcome,
  onOpenBoard,
}: {
  board: { id: string; name: string };
  profileId: string;
  profileName: string;
  onClose: () => void;
  /** After a save went through (the link changed). */
  onSaved: () => void;
  /** The outcome of the last attempt, for the state pill. */
  onOutcome?: (kind: "saved" | "conflict" | "offline" | "failed") => void;
  /** Keeping the account's version opens it as a new session. */
  onOpenBoard: (id: string) => void;
}) {
  const { modalProps } = useModal({ onClose });
  const [view, setView] = useState<View>({ kind: "loading" });
  /** What a save would send; kept across a failed attempt so "try again" has it. */
  const [preview, setPreview] = useState<Preview | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void window.accountSessions.preview(board.id).then((preview) => {
      if (!alive.current) return;
      if (preview.ok) {
        setPreview(preview);
        setView({ kind: "ready" });
      } else setView({ kind: "failed", failure: { state: "error", code: "no_board", message: "" } });
    });
  }, [board.id]);

  async function save() {
    if (!preview || view.kind === "saving") return;
    setView({ kind: "saving" });
    const res = await window.accountSessions.save(board.id, profileId);
    if (!alive.current) return;
    if (res.ok) {
      onOutcome?.("saved");
      onSaved();
      toast(t("accountSession.save.done", { n: res.revision }));
      onClose();
      return;
    }
    if ("conflict" in res) {
      onOutcome?.("conflict");
      setView({ kind: "conflict", info: res.conflict });
      return;
    }
    onOutcome?.(res.failure.state === "offline" ? "offline" : "failed");
    setView({ kind: "failed", failure: res.failure });
  }

  async function resolve(choice: "mine" | "account") {
    if (view.kind !== "conflict") return;
    const info = view.info;
    const res = await window.accountSessions.resolve(board.id, profileId, choice);
    if (!alive.current) return;
    if (!res.ok) {
      if ("conflict" in res) {
        setView({ kind: "conflict", info: res.conflict });
        return;
      }
      setView({ kind: "failed", failure: res.failure });
      return;
    }
    onSaved();
    if (res.choice === "mine") {
      onOutcome?.("saved");
      toast(t("accountSession.save.done", { n: res.revision }));
      onClose();
      return;
    }
    window.dispatchEvent(new Event(BOARDS_CHANGED_EVENT));
    toast(t("accountSession.opened.title", { name: board.name, n: info.currentRevision }));
    onClose();
    onOpenBoard(res.boardId);
  }

  const failure = view.kind === "failed" ? view.failure : null;
  const screen = failure ? failureScreen(failure) : null;
  const first = preview ? preview.link === null : true;
  const ref = preview ? projectRefParts(preview.projectRef) : { kind: "none" as const, text: "" };
  const busy = view.kind === "saving";

  return (
    <div className="modal-root" onWheel={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className={`modal ${view.kind === "conflict" ? styles.modalWide : styles.modalNarrow}`}
        {...modalProps}
        aria-labelledby="account-session-title"
        data-role="account-session-save"
      >
        {view.kind === "conflict" ? (
          <AccountSessionConflict
            name={board.name}
            info={view.info}
            busy={false}
            onKeepMine={() => void resolve("mine")}
            onKeepAccount={() => void resolve("account")}
            onLater={onClose}
          />
        ) : screen === "plan" ? (
          <div className={styles.dialog}>
            <AccountSessionPlan expired={failure?.state === "plan" && failure.expired} onLocal={onClose} />
          </div>
        ) : (
          <div className={styles.dialog}>
            <h3 id="account-session-title" className={styles.title}>
              {t("accountSession.save")}
            </h3>
            {preview ? (
              <>
                <p className={styles.lede}>
                  {first
                    ? t("accountSession.save.create", { profile: profileName })
                    : t("accountSession.save.update", { profile: profileName, from: preview.link?.revision ?? 0 })}
                </p>
                <div>
                  <div className={styles.bulletsHead}>{t("accountSession.save.goes")}</div>
                  <ul className={styles.bullets} data-tone="goes">
                    <li>
                      {t("accountSession.save.goesCount", {
                        cards: countText("cards", preview.summary.cardCount),
                        connections: countText("connections", preview.connectors),
                        tasks: countText("tasks", preview.summary.taskCount),
                      })}
                    </li>
                    {ref.kind !== "none" ? (
                      <li>
                        {weave(t("accountSession.save.project", { ref: "[[ref]]" }), {
                          "[[ref]]": <code className={styles.mono}>{ref.kind === "git" ? ref.text : t("accountSession.folderRef", { name: ref.text })}</code>,
                        })}
                      </li>
                    ) : null}
                  </ul>
                  <div className={styles.bulletsHead}>{t("accountSession.save.stays")}</div>
                  <ul className={styles.bullets}>
                    <li>{t("accountSession.save.staysText")}</li>
                    <li>{t("accountSession.save.staysSecrets")}</li>
                    {preview.omitted > 0 ? (
                      <li data-role="account-session-omitted">
                        {t(preview.omitted === 1 ? "accountSession.save.staysMedia.one" : "accountSession.save.staysMedia.many", { n: preview.omitted })}
                      </li>
                    ) : null}
                    {preview.overLimit > 0 ? <li>{t("accountSession.save.staysOver", { n: preview.overLimit })}</li> : null}
                  </ul>
                </div>
              </>
            ) : null}
            {screen === "offline" ? (
              <AccountSessionOffline detail={t("accountSession.offline.save")} />
            ) : failure ? (
              <div className={styles.error} role="alert" data-role="account-session-failure">
                {t(failureMessageKey(failure))}
              </div>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={onClose}>
                {t("accountSession.cancel")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!preview || busy || screen === "login"}
                data-role={screen === "offline" ? "account-session-save-retry" : "account-session-save-confirm"}
                onClick={() => void save()}
              >
                {busy
                  ? t("accountSession.save.saving")
                  : screen === "offline"
                    ? t("accountSession.offline.retry")
                    : t("accountSession.save.confirm")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
