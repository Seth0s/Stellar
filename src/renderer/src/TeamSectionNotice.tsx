import { getLocale, t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import { groupSectionNotices, type SectionRecord, type TeamSection } from "./team-load-decision";
import styles from "./TeamPage.module.css";

const SECTION_LABEL: Record<TeamSection, MessageKey> = {
  overview: "teamLoad.section.overview",
  detail: "teamLoad.section.detail",
  sprints: "teamLoad.section.sprints",
  invites: "teamLoad.section.invites",
  tasks: "teamLoad.section.tasks",
};

/**
 * What the sections say about their freshness: stale data carries the time of
 * the last refresh (the account's wording offline), a section that failed with
 * nothing to show says why and offers a retry. Only what has something to say is
 * listed, so a healthy page shows nothing; sections with the same message share
 * one line.
 */
export function TeamSectionNotices({
  sections,
  onRetry,
}: {
  sections: Record<TeamSection, SectionRecord>;
  onRetry: (section: TeamSection) => void;
}) {
  const groups = groupSectionNotices(sections, getLocale());
  if (groups.length === 0) return null;
  return (
    <div className={styles.sectionNotices} data-part="team-section-notices">
      {groups.map(({ sections: covered, notice }) => {
        const label = covered.map((section) => t(SECTION_LABEL[section])).join(", ");
        const text =
          notice.kind === "stale"
            ? t("teamLoad.stale", { section: label, when: notice.when })
            : notice.kind === "stale-unknown"
              ? t("teamLoad.staleUnknown", { section: label })
              : t("teamLoad.error", { section: label, reason: notice.message });
        return (
          <div
            key={covered.join(",")}
            className={`${notice.kind === "error" ? styles.errorBox : styles.warnBox} ${styles.sectionNotice}`}
            role="status"
            data-part="team-section-notice"
            data-section={covered[0]}
            data-sections={covered.join(",")}
            data-state={notice.kind === "error" ? "error" : "stale"}
          >
            <span>{text}</span>
            <button
              type="button"
              className={styles.btn}
              data-part="team-section-retry"
              data-section={covered[0]}
              onClick={() => covered.forEach((section) => onRetry(section))}
            >
              {t("teamLoad.retry")}
            </button>
          </div>
        );
      })}
    </div>
  );
}
