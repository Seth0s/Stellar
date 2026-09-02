import { memo, useEffect, useState } from "react";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import type { Rect } from "./board-model";
import type { GitStatus } from "../../preload/index";

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
  label,
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
  label: string | null;
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
      className="changes-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
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
            <CardTag label={label ?? "changes"} onRename={onRename} />
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
      <div className="changes-card-body thin-scroll">
        {!status && <div className="changes-msg">carregando…</div>}
        {status && !status.repo && <div className="changes-msg">não é um repositório git</div>}
        {status && status.repo && (
          <>
            <div className="changes-header">
              <span>{status.branch}</span>
              <span className="changes-totals">
                <span className="changes-ins">+{status.insertions}</span>{" "}
                <span className="changes-del">−{status.deletions}</span>
              </span>
              <button onClick={refresh}>atualizar</button>
            </div>
            <div className="changes-list">
              {status.entries.length === 0 && <div className="changes-msg">sem alterações</div>}
              {status.entries.map((entry) => (
                <div key={entry.path} className="changes-entry">
                  <span className="changes-entry-status">{entry.status}</span>
                  <span className="changes-entry-path">{entry.path}</span>
                  <span className="changes-ins">+{entry.insertions}</span>
                  <span className="changes-del">−{entry.deletions}</span>
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
