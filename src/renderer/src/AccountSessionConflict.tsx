import { t } from "../../shared/i18n";
import type { AccountSessionConflictInfo } from "../../preload/index";
import { ageBucket } from "./account-session-decision";
import { countText, weave } from "./account-session-text";
import styles from "./AccountSession.module.css";

function ageText(ageMs: number | null): string {
  const b = ageBucket(ageMs);
  if (!b) return "";
  return t(`accountSession.age.${b.unit}` as const, { n: b.n });
}

/**
 * Two computers changed the same session: keep mine or keep the account's, no
 * merging. Keeping the account's opens it as a new session; the local one stays.
 */
export function AccountSessionConflict({
  name,
  info,
  busy,
  onKeepMine,
  onKeepAccount,
  onLater,
}: {
  name: string;
  info: AccountSessionConflictInfo;
  busy: boolean;
  onKeepMine: () => void;
  onKeepAccount: () => void;
  onLater: () => void;
}) {
  const device = info.currentDevice;
  const theirs = info.currentSummary;
  return (
    <div className={styles.dialog} data-role="account-session-conflict">
      <h3 id="account-session-title" className={styles.title}>
        {t("accountSession.conflict.title")}
      </h3>
      <p className={styles.lede}>
        {weave(
          device
            ? t("accountSession.conflict.text", { device, name: "[[name]]" })
            : t("accountSession.conflict.textNoDevice", { name: "[[name]]" }),
          { "[[name]]": <strong>{name}</strong> },
        )}
      </p>
      <div className={styles.choices}>
        <div className={styles.choice}>
          <span className={styles.choiceHead}>{t("accountSession.conflict.mine")}</span>
          <span className={styles.choiceSummary}>
            {t("accountSession.conflict.summary", { cards: countText("cards", info.mine.cardCount), tasks: countText("tasks", info.mine.taskCount) })}
          </span>
          <span className={styles.choiceMeta}>
            {t("accountSession.conflict.mineMeta", { n: info.baseRevision, age: ageText(Math.max(0, Date.now() - info.baseAt)) })}
          </span>
          <button type="button" className="primary" disabled={busy} data-role="account-session-keep-mine" onClick={onKeepMine}>
            {t("accountSession.conflict.keepMine")}
          </button>
          <span className={styles.choiceHint}>{t("accountSession.conflict.keepMineHint", { n: info.currentRevision + 1 })}</span>
        </div>
        <div className={styles.choice}>
          <span className={styles.choiceHead}>
            {device ? t("accountSession.conflict.theirs", { device: device.toUpperCase() }) : t("accountSession.conflict.theirsNoDevice")}
          </span>
          <span className={styles.choiceSummary}>
            {theirs
              ? t("accountSession.conflict.summary", { cards: countText("cards", theirs.cardCount), tasks: countText("tasks", theirs.taskCount) })
              : `r${info.currentRevision}`}
          </span>
          <span className={styles.choiceMeta}>{t("accountSession.conflict.theirsMeta", { n: info.currentRevision })}</span>
          <button type="button" className={styles.ghost} disabled={busy} data-role="account-session-keep-account" onClick={onKeepAccount}>
            {t("accountSession.conflict.keepTheirs")}
          </button>
          <span className={styles.choiceHint}>{t("accountSession.conflict.keepTheirsHint")}</span>
        </div>
      </div>
      <p className={styles.choiceHint}>{t("accountSession.conflict.note")}</p>
      <div className="modal-actions">
        <button type="button" className="ghost" disabled={busy} onClick={onLater}>
          {t("accountSession.conflict.later")}
        </button>
      </div>
    </div>
  );
}
