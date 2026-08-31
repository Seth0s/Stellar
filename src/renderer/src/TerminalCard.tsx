import { memo, useEffect, useRef, useState } from "react";
import { useTerminal } from "./useTerminal";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import type { Rect } from "./board-model";

export type { Rect };

const PROVIDER_ACCENT: Record<string, string> = {
  bash: "var(--accent-bash)",
  claude: "var(--accent-claude)",
  codex: "var(--accent-codex)",
  cursor: "var(--accent-cursor)",
};

/** Pre-release audit P1 — wrapped in `React.memo` below (see
 * useStableCardHandler.ts's doc comment): App.tsx's card-rendering switch
 * now passes stable handler references per card, so this only re-renders
 * when something about THIS card actually changed, not on every
 * pointermove of some OTHER card's drag/pan/zoom. */
function TerminalCardInner({
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
  initialInput,
  visible,
  seenUrls,
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
  onResumeIdDiscovered,
  onOpenUrl,
  onConnectorStart,
  onSelectStart,
  onStatusChange,
  onSuggestInstall,
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
  /** One-shot text typed into a fresh PTY right after spawn (see
   * useTerminal.ts) — never persisted, only ever set by
   * `openInstallTerminal` (App.tsx, item 57 ponto 13). */
  initialInput: string | null;
  visible: boolean;
  /** URLs this card's own output has printed — never opened on its own, only offered (see AGENTS.md). */
  seenUrls: string[];
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  /** User-set header name, null = fall back to `providerId`. */
  label: string | null;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onResumeIdDiscovered: (resumeId: string) => void;
  onOpenUrl: (url: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** Bubbles live status up for the session breadcrumb/list (item 1) — the
   * only place this app has real (not structural-proxy) agent status. */
  onStatusChange?: (status: "ok" | "error" | "exited") => void;
  /** Item 57 ponto 13 — "binary not found" offers a pre-filled (never
   * auto-run) install terminal instead of just a dead-end error string. */
  onSuggestInstall?: (providerId: string, cwd: string, command: string) => void;
}) {
  // Pre-release audit P1 — a render-count counter, not gated behind any
  // dev-only flag (this renderer has none to gate on), but as cheap as a
  // `console.count` call and exposed only as a plain `window` property no
  // production code ever reads. Lets the verify harness (real CDP, no
  // mock) prove `React.memo` above actually skips re-rendering a card
  // nothing changed about, not just that behavior still looks right.
  const renderCounts = (window as unknown as { __cardRenderCounts?: Record<string, number> }).__cardRenderCounts ??= {};
  renderCounts[id] = (renderCounts[id] ?? 0) + 1;

  const containerRef = useRef<HTMLDivElement>(null);
  const urlBadgeRef = useRef<HTMLButtonElement>(null);
  const [urlPopoverOpen, setUrlPopoverOpen] = useState(false);
  // Clicking a URL's own text copies it (the primary action pedida ao
  // vivo) — só reporta "copiado" se `writeText` de fato resolveu, nunca
  // um feedback otimista. `{url, ok}` em vez de um Set de urls copiadas:
  // só uma cópia por vez é relevante, e guardar o resultado real (não só
  // "copiei") deixa o caminho de erro honesto também.
  const [copyFeedback, setCopyFeedback] = useState<{ url: string; ok: boolean } | null>(null);
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copyUrl(url: string) {
    let ok = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      ok = false;
    }
    setCopyFeedback({ url, ok });
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = setTimeout(() => setCopyFeedback((f) => (f?.url === url ? null : f)), 1400);
  }
  const { exitCode, spawnError, installHint, discoveredResumeId, fitNow, interrupt } = useTerminal(
    containerRef,
    id,
    providerId,
    cwd,
    resumeId,
    continueLast,
    model,
    systemPrompt,
    initialInput,
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

  useEffect(() => {
    return () => {
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    };
  }, []);

  const statusClass = spawnError !== null ? "danger" : exitCode !== null ? "" : "ok";
  useEffect(() => {
    onStatusChange?.(spawnError !== null ? "error" : exitCode !== null ? "exited" : "ok");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnError, exitCode]);
  const footerParts = [
    cwd,
    resumeId || discoveredResumeId ? `resume:${resumeId ?? discoveredResumeId}` : null,
    !resumeId && continueLast ? "--continue" : null,
    model ? `model:${model}` : null,
  ].filter(Boolean);
  // Achado ao vivo (2026-08-27): a tira antiga era `position: absolute`
  // por CIMA das linhas do terminal, sem limite/expiração — qualquer
  // sessão que imprimisse alguns links (docs, npm, git remote…) acabava
  // com uma faixa permanente cobrindo conteúdo real. Vira um badge no
  // próprio footer (nunca sobrepõe o terminal) que abre a lista completa
  // num popover sob demanda — mesmo componente `Popover` que o resto do
  // app já usa. `side` calculado a partir da posição real do badge na
  // tela: um card pode estar em qualquer lugar do canvas, não só perto da
  // régua (onde os outros usos de `Popover` sempre ficam), então abrir
  // sempre "right" clipparia off-screen pra um card na metade direita.
  const urlPopoverSide: "left" | "right" =
    (urlBadgeRef.current?.getBoundingClientRect().left ?? 0) > window.innerWidth / 2 ? "left" : "right";

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
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
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
            <CardTag label={label ?? providerId} onRename={onRename} />
          </span>
          <span className="card-head-actions">
            <button
              className="terminal-card-interrupt"
              title="Interromper o processo (Ctrl+C)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={interrupt}
            >
              <Icon name="interrupt" size={12} />
              <span className="terminal-card-interrupt-label">Ctrl+C</span>
            </button>
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
      footerContent={
        <span className="terminal-card-foot-row">
          <span className="terminal-card-foot-text">{footerParts.join(" · ")}</span>
          {seenUrls.length > 0 && (
            <button
              ref={urlBadgeRef}
              className="terminal-card-url-badge"
              title={`${seenUrls.length} link${seenUrls.length > 1 ? "s" : ""} vistos no output`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setUrlPopoverOpen((v) => !v)}
            >
              <Icon name="link" size={11} />
              {seenUrls.length}
            </button>
          )}
        </span>
      }
    >
      <div className="terminal-card-body" ref={containerRef} />
      {spawnError !== null && (
        <div className="terminal-card-exited">
          {spawnError}
          {installHint && onSuggestInstall && (
            <button
              className="terminal-card-install-btn"
              title={`Abre um terminal bash com o comando pré-preenchido — nada é executado sozinho, você confirma com Enter: ${installHint.command}`}
              onClick={() => onSuggestInstall(installHint.providerId, cwd, installHint.command)}
            >
              <Icon name="terminal" size={12} />
              instalar {installHint.providerId}
            </button>
          )}
        </div>
      )}
      {exitCode !== null && <div className="terminal-card-exited">processo encerrado ({exitCode})</div>}
      <Popover anchorRef={urlBadgeRef} open={urlPopoverOpen} onClose={() => setUrlPopoverOpen(false)} side={urlPopoverSide} className="terminal-card-url-popover thin-scroll">
        {[...seenUrls].reverse().map((url) => {
          const feedback = copyFeedback?.url === url ? copyFeedback : null;
          return (
            <div key={url} className="terminal-card-url-row">
              <button
                className={`terminal-card-url-chip${feedback ? (feedback.ok ? " copied" : " copy-error") : ""}`}
                title={url}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => copyUrl(url)}
              >
                {feedback ? (
                  <>
                    <Icon name={feedback.ok ? "check" : "close"} size={11} />
                    {feedback.ok ? "copiado pro clipboard" : "falha ao copiar"}
                  </>
                ) : (
                  <>
                    <Icon name="copy" size={11} />
                    {url.replace(/^https?:\/\//, "").slice(0, 44)}
                  </>
                )}
              </button>
              <button
                className="terminal-card-url-open"
                title="Abrir no navegador interno (pede confirmação)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onOpenUrl(url)}
              >
                <Icon name="browser" size={11} />
              </button>
            </div>
          );
        })}
      </Popover>
    </CardFrame>
  );
}

export const TerminalCard = memo(TerminalCardInner);
