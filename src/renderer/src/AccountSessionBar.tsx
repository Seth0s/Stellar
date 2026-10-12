import { useState } from "react";
import { t } from "../../shared/i18n";
import type { AccountSessionLink } from "../../preload/index";
import { decideSaveState, type SaveOutcome } from "./account-session-decision";
import { AccountSessionPill } from "./AccountSessionParts";
import { AccountSessionSave } from "./AccountSessionSave";
import styles from "./AccountSession.module.css";

/**
 * The state of a session on the account and the button that saves it: what the
 * top of a session shows (SessoesConta.dc.html). The Sessions list uses the same
 * pair on each session's card.
 */
export function AccountSessionBar({
  board,
  profile,
  link,
  canSave = true,
  onChanged,
  onOpenBoard,
}: {
  board: { id: string; name: string };
  profile: { id: string; name: string };
  /** What this machine last saw of the session on the account. */
  link: AccountSessionLink | null;
  /** False while the plan is read-only or missing. */
  canSave?: boolean;
  onChanged: () => void;
  onOpenBoard: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<SaveOutcome | null>(null);
  const state = decideSaveState(link, last);
  return (
    <span className={styles.bar} data-role="account-session-bar">
      <AccountSessionPill state={state} />
      <button
        type="button"
        className={styles.saveBtn}
        data-open={open}
        data-role="account-session-save"
        disabled={!canSave}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {state.kind === "saved" ? t("accountSession.saveAgain") : t("accountSession.save")}
      </button>
      {open ? (
        <AccountSessionSave
          board={board}
          profileId={profile.id}
          profileName={profile.name}
          onClose={() => setOpen(false)}
          onSaved={onChanged}
          onOutcome={(kind) => setLast({ kind })}
          onOpenBoard={onOpenBoard}
        />
      ) : null}
    </span>
  );
}
