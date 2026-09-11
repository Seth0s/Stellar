import { memo, useEffect, useState } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import type { Rect } from "./board-model";
import type { GitStatus } from "../../preload/index";
import styles from "./ChangesCard.module.css";

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function ChangesCardInner({
  rect,
  zoom,
  zIndex,
  root,
  interactionMode,
  selected,
  reflowing,
  closing,
  displayName,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onConnectorStart,
  onSelectStart,
  screenProjected,
  panX,
  panY,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  root: string;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  displayName: string;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through, same pattern StickyCard/BrowserCard already use. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);

  function refresh() {
    window.git.status(root).then(setStatus);
  }

  useEffect(() => {
    setStatus(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  return (
    <CardFrame
      className=""
      kind="changes"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      displayName={displayName}
      onRename={onRename}
      interactionMode={interactionMode}
      selected={selected}
      accent="var(--accent-changes)"
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="changes" size={14} />
          </span>
          <span className="card-head-actions">
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
      footerContent={root}
    >
      <div className={`${styles.changesCardBody} thin-scroll`}>
        {!status && <div className={styles.changesMsg}>carregando…</div>}
        {status && !status.repo && <div className={styles.changesMsg}>não é um repositório git</div>}
        {status && status.repo && (
          <>
            <div className={styles.changesHeader}>
              <span>{status.branch}</span>
              <span className="changes-totals">
                <span className={styles.changesIns}>+{status.insertions}</span>{" "}
                <span className={styles.changesDel}>−{status.deletions}</span>
              </span>
              <button onClick={refresh}>atualizar</button>
            </div>
            <div className={styles.changesList}>
              {status.entries.length === 0 && <div className={styles.changesMsg}>sem alterações</div>}
              {status.entries.map((entry) => (
                <div key={entry.path} className={styles.changesEntry}>
                  <span className={styles.changesEntryStatus}>{entry.status}</span>
                  <span className={styles.changesEntryPath}>{entry.path}</span>
                  <span className={styles.changesIns}>+{entry.insertions}</span>
                  <span className={styles.changesDel}>−{entry.deletions}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </CardFrame>
  );
}

export const ChangesCard = memo(ChangesCardInner);
