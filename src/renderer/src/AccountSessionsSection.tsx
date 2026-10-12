import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../shared/i18n";
import type {
  AccountSessionFailure,
  AccountSessionFolderChoice,
  AccountSessionProjectRef,
  AccountSessionView,
  CloudPlanInfo,
} from "../../preload/index";
import {
  BOARDS_CHANGED_EVENT,
  ageBucket,
  failureMessageKey,
  failureScreen,
  projectRefParts,
  sessionMetaParts,
  sortAccountSessions,
} from "./account-session-decision";
import { AccountSessionOffline, AccountSessionPlan } from "./AccountSessionParts";
import { countText, weave } from "./account-session-text";
import { AccountSessionFolder } from "./AccountSessionFolder";
import { decidePlanAccess } from "./PlanAccess";
import styles from "./AccountSession.module.css";

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; sessions: AccountSessionView[] }
  | { kind: "failed"; failure: AccountSessionFailure };

type FolderAsk = {
  session: AccountSessionView;
  projectRef: AccountSessionProjectRef | null;
  candidates: { path: string; match: "remote" | "name" }[];
  missing: boolean;
};

type Opened = { boardId: string; name: string; revision: number; cleanTerminals: number };

function CloudGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M4.6 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 12 6.6a2.95 2.95 0 0 1-.2 5.9z" />
      <path d="M8 6.5v4.5M6.2 8.3L8 6.5l1.8 1.8" />
    </svg>
  );
}

function ageLabel(ageMs: number | null): string {
  const b = ageBucket(ageMs);
  return b ? t(`accountSession.age.${b.unit}` as const, { n: b.n }) : "";
}

/**
 * The sessions kept on the account, inside the Sessions screen of an account
 * profile: open one on this machine, archive one, or — without the right plan —
 * see what the plan would add. Saving starts from a session's own card.
 */
export function AccountSessionsSection({
  profile,
  plan,
  onOpenBoard,
  onLocalOnly,
  refreshKey = 0,
}: {
  profile: { id: string; name: string };
  plan: CloudPlanInfo | null;
  onOpenBoard: (id: string) => void;
  /** "Keep going on this machine only" on the plan card. */
  onLocalOnly?: () => void;
  /** Changes when the list should be read again (a save elsewhere on the screen). */
  refreshKey?: number;
}) {
  const access = useMemo(() => decidePlanAccess(plan, "sync"), [plan]);
  const locked =
    access.kind === "upgrade" || (access.kind === "expired" && access.state === "archived");
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderAsk | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [message, setMessage] = useState<AccountSessionFailure | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (locked) return;
    let alive = true;
    setList({ kind: "loading" });
    void window.accountSessions.list(profile.id).then((res) => {
      if (!alive) return;
      setList(
        res.ok
          ? { kind: "ok", sessions: sortAccountSessions(res.sessions) }
          : { kind: "failed", failure: res.failure },
      );
    });
    return () => {
      alive = false;
    };
  }, [profile.id, locked, tick, refreshKey]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  async function open(session: AccountSessionView, choice?: AccountSessionFolderChoice) {
    setBusy(session.id);
    setMessage(null);
    const res = await window.accountSessions.open(profile.id, session.id, choice);
    setBusy(null);
    if (res.ok) {
      window.dispatchEvent(new Event(BOARDS_CHANGED_EVENT));
      setFolder(null);
      setOpened({
        boardId: res.boardId,
        name: session.name,
        revision: res.revision,
        cleanTerminals: res.cleanTerminals,
      });
      reload();
      return;
    }
    if ("needsFolder" in res) {
      setFolder({
        session,
        projectRef: res.needsFolder.projectRef,
        candidates: res.needsFolder.candidates,
        missing: choice?.kind === "path",
      });
      return;
    }
    setFolder(null);
    setMessage(res.failure);
  }

  async function archive(session: AccountSessionView) {
    setBusy(session.id);
    const res = await window.accountSessions.archive(profile.id, session.id);
    setBusy(null);
    if (res.ok) reload();
    else setMessage(res.failure);
  }

  if (locked) {
    return (
      <section
        className={styles.section}
        aria-label={t("accountSession.section")}
        data-role="account-sessions"
      >
        <AccountSessionPlan expired={access.kind === "expired"} onLocal={onLocalOnly} />
      </section>
    );
  }

  const failure = list.kind === "failed" ? list.failure : message;
  const screen = failure ? failureScreen(failure) : null;
  const sessions = list.kind === "ok" ? list.sessions : [];
  const now = Date.now();

  return (
    <section
      className={styles.section}
      aria-label={t("accountSession.section")}
      data-role="account-sessions"
    >
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{t("accountSession.section")}</span>
        <span className={styles.sectionSpacer} />
        <button
          type="button"
          className={styles.linkBtn}
          data-role="account-sessions-refresh"
          onClick={reload}
        >
          {t("accountSession.refresh")}
        </button>
      </div>

      {access.kind === "expired" ? (
        <div className={styles.notice} data-tone="warn" role="status">
          {t("accountSession.plan.expired")}
        </div>
      ) : null}

      {opened ? (
        <div
          className={styles.notice}
          data-tone="ok"
          role="status"
          data-role="account-session-opened"
        >
          <span className={styles.noticeTitle}>
            {t("accountSession.opened.title", { name: opened.name, n: opened.revision })}
          </span>
          {opened.cleanTerminals > 0 ? (
            <span>
              {t(
                opened.cleanTerminals === 1
                  ? "accountSession.opened.clean.one"
                  : "accountSession.opened.clean.many",
                { n: opened.cleanTerminals },
              )}
            </span>
          ) : null}
          <div className={styles.noticeActions}>
            <button
              type="button"
              className="primary"
              data-role="account-session-opened-go"
              onClick={() => onOpenBoard(opened.boardId)}
            >
              {t("accountSession.opened.go")}
            </button>
            <button type="button" className={styles.ghost} onClick={() => setOpened(null)}>
              {t("accountSession.opened.dismiss")}
            </button>
          </div>
        </div>
      ) : null}

      {screen === "offline" ? (
        <AccountSessionOffline detail={t("accountSession.offline.list")} onRetry={reload} />
      ) : screen === "plan" && failure?.state === "plan" ? (
        <AccountSessionPlan expired={failure.expired} onLocal={onLocalOnly} />
      ) : failure ? (
        <div
          className={styles.notice}
          data-tone="warn"
          role="alert"
          data-role="account-sessions-failure"
        >
          {t(failureMessageKey(failure))}
        </div>
      ) : list.kind === "loading" ? (
        <div className={styles.empty}>{t("accountSession.loading")}</div>
      ) : sessions.length === 0 ? (
        <div className={styles.hint} data-role="account-sessions-empty">
          <span className={styles.hintIcon}>
            <CloudGlyph />
          </span>
          <span>{t("accountSession.empty")}</span>
        </div>
      ) : (
        <>
          <div className={styles.rows}>
            {sessions.map((s) => {
              const meta = sessionMetaParts(s, now);
              const ref = projectRefParts(s.projectRef);
              const age = ageLabel(meta.ageMs);
              return (
                <div
                  key={s.id}
                  className={styles.row}
                  data-here={s.openHereBoardId ? "true" : "false"}
                  data-role="account-session-row"
                  data-session-id={s.id}
                >
                  <div className={styles.rowText}>
                    <span className={styles.rowName}>
                      {s.name}
                      <span className={styles.rev}>
                        {t("accountSession.revision", { n: s.revision })}
                      </span>
                    </span>
                    <span className={styles.rowRef}>
                      {ref.kind === "git"
                        ? ref.text
                        : ref.kind === "folder"
                          ? t("accountSession.folderRef", { name: ref.text })
                          : ""}
                    </span>
                    <span className={styles.rowMeta}>
                      {[
                        countText("cards", meta.cards),
                        countText("tasks", meta.tasks),
                        meta.device
                          ? t("accountSession.savedBy", { device: meta.device })
                          : t("accountSession.saved"),
                        age,
                      ]
                        .filter((part) => part !== "")
                        .join(" · ")}
                    </span>
                    {s.openHereBoardId ? (
                      <span className={styles.rowNote} data-tone="here">
                        {t("accountSession.openHere")}
                      </span>
                    ) : ref.kind === "folder" ? (
                      <span className={styles.rowNote}>{t("accountSession.noRemote")}</span>
                    ) : null}
                  </div>
                  <div className={styles.rowActions}>
                    {s.openHereBoardId ? (
                      <button
                        type="button"
                        className={styles.ghost}
                        onClick={() => onOpenBoard(s.openHereBoardId!)}
                      >
                        {t("accountSession.goHere")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="primary"
                      disabled={busy !== null}
                      data-role="account-session-open"
                      onClick={() => void open(s)}
                    >
                      {busy === s.id ? t("accountSession.opening") : t("accountSession.open")}
                    </button>
                    <button
                      type="button"
                      className={styles.ghost}
                      disabled={busy !== null}
                      data-role="account-session-archive"
                      onClick={() => void archive(s)}
                    >
                      {t("accountSession.archive")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className={styles.hint} data-role="account-sessions-hint">
            <span className={styles.hintIcon}>
              <CloudGlyph />
            </span>
            <span>
              {weave(t("accountSession.hint", { save: "[[save]]" }), {
                "[[save]]": <strong>{t("accountSession.save")}</strong>,
              })}
            </span>
          </div>
        </>
      )}

      {folder ? (
        <AccountSessionFolder
          name={folder.session.name}
          projectRef={folder.projectRef}
          candidates={folder.candidates}
          missing={folder.missing}
          onChoose={(choice) => void open(folder.session, choice)}
          onClose={() => setFolder(null)}
        />
      ) : null}
    </section>
  );
}
