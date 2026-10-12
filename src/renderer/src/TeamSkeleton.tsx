import type { CSSProperties } from "react";
import { t } from "../../shared/i18n";
import page from "./TeamPage.module.css";
import styles from "./TeamSkeleton.module.css";

/**
 * Loading placeholders of the Team page.
 *
 * Nothing here is a new drawing: every placeholder sits INSIDE the real element
 * it stands for (same class, same typography), so the line box, padding and
 * borders are the final layout's — the page does not move when the answer
 * arrives. Only the text inside is a bar, in the existing field token, with the
 * shimmer the board's card skeleton already uses.
 *
 * Each group is marked `data-part="team-skeleton"` + `data-section` so the
 * smoke can tell which section is still waiting.
 */

/** A text-sized bar: `w` is in characters of the surrounding font, the height is one line of it. */
export function Bar({ w, block }: { w: number; block?: boolean }) {
  const style: CSSProperties = { width: `${w}ch` };
  return (
    <span className={`${styles.bar} ${block ? styles.block : styles.text}`} style={style} aria-hidden="true">
      <span className="card-skeleton-shimmer" />
    </span>
  );
}

/** The circle of an avatar, at the avatar's own size. */
export function AvatarBar({ small }: { small?: boolean }) {
  return (
    <span className={`${page.avatar}${small ? ` ${page.avatarSm}` : ""} ${styles.avatarBar}`} aria-hidden="true">
      <span className="card-skeleton-shimmer" />
    </span>
  );
}

/** What stands in for a `Stat` value + hint while its section loads. */
export function StatBars({ section }: { section: string }) {
  return (
    <>
      <span className={page.statBig} data-part="team-skeleton" data-section={section} aria-busy="true">
        <Bar w={4} />
      </span>
      <span className={page.statHint}>
        <Bar w={16} />
      </span>
    </>
  );
}

/** Rows of the members table, same cells as a member row. */
export function MemberRowsSkeleton({ rows, section }: { rows: number; section: string }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} data-part="team-skeleton" data-section={section} aria-busy="true">
          <td>
            <span className={page.person}>
              <AvatarBar />
              <span className={page.personText}>
                <span>
                  <Bar w={14} />
                </span>
                <span className={page.personMeta}>
                  <Bar w={20} />
                </span>
              </span>
            </span>
          </td>
          <td>
            <span className={page.roleSelect}>
              <Bar w={12} />
            </span>
          </td>
          <td>
            <Bar w={2} />
          </td>
          <td>
            <span className={page.rowActions}>
              <span className={`${page.headBtn} ${page.rowBtn}`}>
                <Bar w={6} />
              </span>
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}

/** The recent-activity lines of the audit page. */
export function ActivitySkeleton({ lines }: { lines: number }) {
  return (
    <>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} data-part="team-skeleton" data-section="tasks" aria-busy="true">
          <Bar w={26} />
        </span>
      ))}
    </>
  );
}

/** Task cards of one board column: title (two lines), chips, and the footer line. */
export function ColumnCardsSkeleton({ cards }: { cards: number }) {
  return (
    <>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={page.taskCard} data-part="team-skeleton" data-section="tasks" aria-busy="true">
          <span className={page.taskTitle}>
            <Bar w={24} />
            <br />
            <Bar w={14} />
          </span>
          <span className={page.chips}>
            <span className={page.chip}>
              <Bar w={6} />
            </span>
            <span className={page.chip}>
              <Bar w={8} />
            </span>
          </span>
          <span className={page.taskFoot}>
            <AvatarBar small />
            <Bar w={12} />
          </span>
        </div>
      ))}
    </>
  );
}

/** The board's side panel while the role (and so which panel it is) is not known yet. */
export function AsideSkeleton() {
  return (
    <div className={page.distribute} data-part="team-skeleton" data-section="detail" aria-busy="true" aria-label={t("teamTask.loading")}>
      <div className={page.panelHead}>
        <span className={page.fieldLabel}>
          <Bar w={14} />
        </span>
      </div>
      <Bar w={30} block />
      <Bar w={30} block />
      <Bar w={30} block />
    </div>
  );
}

/** The seats pill in the page head, while the detail (which carries the seats) loads. */
export function PillBar() {
  return (
    <span className={page.pill} data-part="team-skeleton" data-section="detail" aria-busy="true">
      <Bar w={9} />
    </span>
  );
}
