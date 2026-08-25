import { useEffect, useRef } from "react";
import { useTerminal } from "./useTerminal";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

export type { Rect };

const PROVIDER_ACCENT: Record<string, string> = {
  bash: "var(--accent-bash)",
  claude: "var(--accent-claude)",
  codex: "var(--accent-codex)",
  cursor: "var(--accent-cursor)",
};

export function TerminalCard({
  id,
  rect,
  zoom,
  zIndex,
  providerId,
  cwd,
  resumeId,
  continueLast,
  model,
  systemPrompt,
  visible,
  seenUrls,
  interactionMode,
  selected,
  reflowing,
  onChange,
  onCommit,
  onRaise,
  onClose,
  onResumeIdDiscovered,
  onOpenUrl,
  onConnectorStart,
  onSelectStart,
}: {
  /** The card's own persisted id — also the PTY id and AGENT_CANVAS_CARD_ID, so acbridge/store/registry all speak the same id. */
  id: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  providerId: string;
  cwd: string;
  resumeId: string | null;
  /** One-shot launch preference, never persisted — see AGENTS.md. */
  continueLast: boolean;
  model: string | null;
  systemPrompt: string | null;
  visible: boolean;
  /** URLs this card's own output has printed — never opened on its own, only offered (see AGENTS.md). */
  seenUrls: string[];
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onClose: () => void;
  onResumeIdDiscovered: (resumeId: string) => void;
  onOpenUrl: (url: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { exitCode, spawnError, discoveredResumeId, fitNow, interrupt } = useTerminal(
    containerRef,
    id,
    providerId,
    cwd,
    resumeId,
    continueLast,
    model,
    systemPrompt,
    visible,
    zoom,
  );

  const reportedRef = useRef(false);
  useEffect(() => {
    if (discoveredResumeId && !reportedRef.current) {
      reportedRef.current = true;
      onResumeIdDiscovered(discoveredResumeId);
    }
  }, [discoveredResumeId, onResumeIdDiscovered]);

  const statusClass = spawnError !== null ? "danger" : exitCode !== null ? "" : "ok";
  const footerParts = [
    cwd,
    resumeId || discoveredResumeId ? `resume:${resumeId ?? discoveredResumeId}` : null,
    !resumeId && continueLast ? "--continue" : null,
    model ? `model:${model}` : null,
  ].filter(Boolean);

  return (
    <CardFrame
      className="terminal-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      selected={selected}
      accent={PROVIDER_ACCENT[providerId] ?? PROVIDER_ACCENT.bash}
      reflowing={reflowing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      // The last onChange's state update lands in the DOM asynchronously
      // (React commit + layout) — measuring in fitNow() synchronously here
      // can read the pre-resize container size. Defer one frame.
      onResizeSettled={() => requestAnimationFrame(() => fitNow())}
      headerContent={
        <>
          <span className="card-head-label">
            <span className={`card-status-dot ${statusClass}`} />
            <span className="card-tag">{providerId}</span>
          </span>
          <span className="card-head-actions">
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
    >
      <div className="terminal-card-body" ref={containerRef} />
      <div className="card-foot">{footerParts.join(" · ")}</div>
      {seenUrls.length > 0 && (
        <div className="terminal-card-urls">
          <span className="muted">🔗</span>
          {seenUrls.map((url) => (
            <button
              key={url}
              className="terminal-card-url-chip"
              title={url}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onOpenUrl(url)}
            >
              {url.replace(/^https?:\/\//, "").slice(0, 32)}
            </button>
          ))}
        </div>
      )}
      {spawnError !== null && <div className="terminal-card-exited">{spawnError}</div>}
      {exitCode !== null && <div className="terminal-card-exited">processo encerrado ({exitCode})</div>}
      <button
        className="terminal-card-interrupt"
        title="Ctrl+C"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={interrupt}
      >
        ^C
      </button>
    </CardFrame>
  );
}
