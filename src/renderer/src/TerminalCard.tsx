import { memo, useEffect, useRef, useState, type MutableRefObject } from "react";
import { t } from "../../shared/i18n";
import { useTerminal } from "./useTerminal";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import type { Rect } from "./board-model";
import { PROVIDER_GLYPH } from "./provider-glyph";
import styles from "./TerminalCard.module.css";
import type { ShortcutOverrides } from "./shortcut-registry";
import type { IdentifySessionResult } from "../../preload/index";

export type { Rect };

/** Pedido ao vivo (2026-09-06) — "pros providers sem hook oficial, por
 * enquanto desativa as notificações". `bash` deliberadamente NÃO está
 * aqui — não é um agente com "turnos", nunca fez parte deste problema. */
const NOTIFICATION_DISABLED_PROVIDERS = new Set(["codex", "cursor", "antigravity", "opencode"]);

/** Same set `session-identify.ts` actually inspects. Bash has no session
 * id, so an empty-resume button there would always fail. */
const SESSION_PROVIDERS = new Set(["claude", "codex", "cursor", "antigravity", "opencode"]);

const PROVIDER_ACCENT: Record<string, string> = {
  bash: "var(--accent-bash)",
  claude: "var(--accent-claude)",
  codex: "var(--accent-codex)",
  cursor: "var(--accent-cursor)",
  // Gap real fechado (2026-09-02) — antigravity é provider de verdade
  // (main/providers.ts) mas nunca teve entrada aqui, caindo no cinza do
  // bash sem ninguém ter decidido isso.
  antigravity: "var(--accent-antigravity)",
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
  effort,
  systemPrompt,
  initialInput,
  brief,
  taskId,
  visible,
  seenUrls,
  interactionMode,
  selected,
  reflowing,
  closing,
  isFocused,
  displayName,
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
  screenProjected,
  panX,
  panY,
  shortcutOverridesRef,
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
  /** Sticky item "spawn_agent effort" — companion to `model`, persisted
   * exactly like it since 2026-09-09 (see card-types.ts's
   * `TerminalCardData.effort` doc comment) — widened from "low" | "high"
   * to plain string there too, same day, so this stays in sync. */
  effort: string | null;
  systemPrompt: string | null;
  /** One-shot text typed into a fresh PTY right after spawn (see
   * useTerminal.ts) — never persisted, only ever set by
   * `openInstallTerminal` (App.tsx, item 57 ponto 13). */
  initialInput: string | null;
  brief: string | null;
  /** Spawn-time task this card serves, when the spawn was tied to one. */
  taskId: string | null;
  visible: boolean;
  /** URLs this card's own output has printed — never opened on its own, only offered (see AGENTS.md). */
  seenUrls: string[];
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  /** True when this card is on top of the z-order (zIndex === order.length - 1). Used to suppress notifications when the user is actively looking at this card. */
  isFocused?: boolean;
  displayName: string;
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
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through, same pattern the other migrated kinds use.
   * Deliberately does NOT touch `useTerminal.ts`'s `correctZoomCoords` —
   * the plan's own Fase 1 ponto 3 assumed disabling it once a card is
   * "projetado em 1:1", but `CardFrame`'s actual `screenProjected`
   * mechanism still applies a CSS `transform: scale(zoom)` (via
   * `.card-scale`, just moved from `.world` to here) rather than
   * eliminating the scale-vs-`getBoundingClientRect()` mismatch that
   * correction exists for — confirmed live before assuming otherwise,
   * see the smoke test covering click precision at zoom != 1. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
  /** Follow-up fase C — repassado pra useTerminal (copy/paste rebindáveis). */
  shortcutOverridesRef: MutableRefObject<ShortcutOverrides>;
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
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const identifyBtnRef = useRef<HTMLButtonElement>(null);
  const [urlPopoverOpen, setUrlPopoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const identifyInFlightRef = useRef(false);
  const [identifyBusy, setIdentifyBusy] = useState(false);
  const [identifyFeedback, setIdentifyFeedback] = useState<IdentifySessionResult | null>(null);
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

  async function identifyThisSession() {
    if (identifyInFlightRef.current) return;
    identifyInFlightRef.current = true;
    // Disarm in the same tick as the click — React state alone would
    // leave a second click able to start another IPC before the re-render.
    if (identifyBtnRef.current) {
      identifyBtnRef.current.disabled = true;
      identifyBtnRef.current.setAttribute("data-busy", "true");
    }
    setIdentifyBusy(true);
    setIdentifyFeedback(null);
    setMenuOpen(false);
    try {
      const result = await window.pty.identifySession(id);
      if (result.status === "found") {
        onResumeIdDiscovered(result.id);
        setIdentifyFeedback(null);
      } else {
        setIdentifyFeedback(result);
      }
    } catch (error) {
      setIdentifyFeedback({
        status: "error",
        source: providerId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      identifyInFlightRef.current = false;
      setIdentifyBusy(false);
    }
  }

  function identifyFeedbackText(result: IdentifySessionResult): string {
    switch (result.status) {
      case "none":
        return t("terminal.identifyNone");
      case "ambiguous":
        return t("terminal.identifyAmbiguous", { ids: result.ids.join(", ") });
      case "claimed":
        return t("terminal.identifyClaimed", { id: result.id });
      case "error":
        return t("terminal.identifyError", { message: result.message });
      case "already-set":
      case "unavailable":
        return t("terminal.identifyUnavailable");
      case "found":
        return "";
    }
  }
  const { exitCode, spawnError, discoveredResumeId, resumeInvalidNotice, hasReceivedOutput, isActive, fitNow, interrupt } = useTerminal(
    containerRef,
    id,
    providerId,
    cwd,
    resumeId,
    continueLast,
    model,
    effort,
    systemPrompt,
    initialInput,
    brief,
    taskId,
    visible,
    zoom,
    shortcutOverridesRef,
  );

  // Achado ao vivo (resize "quebra e volta") — `fitNow()` (real
  // cols/rows + resize de PTY) só roda uma vez, em `onResizeSettled`
  // (soltar o mouse); durante o arraste inteiro o xterm ficava no raster
  // ANTIGO enquanto a caixa ao redor (CardFrame, já sem flicker desde o
  // item 2.1) crescia/encolhia ao vivo — nada acompanhava visualmente até
  // o reflow abrupto no soltar. Mesma doutrina "óptico ao vivo, relayout
  // real no settle" da Trilha A (browser-registry.ts), aplicada por-card:
  // um transform CSS barato estica o raster antigo pro tamanho atual a
  // cada tick de `rect`, sem nenhum custo de fit()/PTY. `onResizeSettled`
  // abaixo zera o transform depois do fit real.
  //
  // Achado ao vivo (2026-09-04) — "durante o arrasto... parece mal
  // acabado (o resize)": esse esticamento óptico não tinha piso nenhum —
  // num arrasto longo o raster antigo ficava cada vez mais deformado (e
  // borrado, canvas WebGL) conforme a diferença pro último fit() real
  // crescia, e só resetava no soltar. Fix: um refit real (fit() + resize
  // de PTY) a cada ~200ms de arrasto contínuo — não por frame — reancora
  // periodicamente o raster num tamanho fresco, então o esticamento
  // nunca acumula por mais que essa janela, sem pagar o custo de um
  // fit()/PTY-resize por tick de `rect` (que é o que esse mecanismo
  // sempre existiu pra evitar).
  const lastFittedRectRef = useRef({ w: rect.w, h: rect.h });
  const lastRealFitAtRef = useRef(0);
  // Distingue "acabou de começar a arrastar" de "continuando o mesmo
  // arrasto" — sem isso, um card parado por minutos e então arrastado
  // faria seu PRIMEIRO tick já contar como "mais de 200ms desde o
  // último fit real" e disparar um fit de verdade na hora, pulando o
  // transform ótico por completo no início de todo arrasto. Um gap
  // grande desde o tick anterior (ticks de arrasto real, throttled por
  // rAF, chegam bem abaixo de 500ms entre si) é o sinal de "arrasto
  // novo" — só aí a janela de 200ms é reancorada no agora.
  const lastTickAtRef = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { w: fw, h: fh } = lastFittedRectRef.current;
    if (rect.w === fw && rect.h === fh) return;
    const now = Date.now();
    const isDragStart = now - lastTickAtRef.current > 500;
    lastTickAtRef.current = now;
    if (isDragStart) {
      lastRealFitAtRef.current = now;
    } else if (now - lastRealFitAtRef.current >= 200) {
      lastRealFitAtRef.current = now;
      fitNow();
      lastFittedRectRef.current = { w: rect.w, h: rect.h };
      el.style.transform = "";
      return;
    }
    el.style.transform = `scale(${rect.w / fw}, ${rect.h / fh})`;
    el.style.transformOrigin = "top left";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect.w, rect.h]);

  // Achado ao vivo (2026-09-02) -- ver `terminal-card-loading` no CSS: um
  // spawn normal (bash, sessão pequena) mostra prompt em bem menos de
  // 1.2s, então o atraso evita o badge piscar à toa; um `--resume` real e
  // pesado passa disso de sobra e ganha o aviso.
  const [showLoadingHint, setShowLoadingHint] = useState(false);
  useEffect(() => {
    if (hasReceivedOutput || exitCode !== null || spawnError !== null) {
      setShowLoadingHint(false);
      return;
    }
    const t = setTimeout(() => setShowLoadingHint(true), 1200);
    return () => clearTimeout(t);
  }, [hasReceivedOutput, exitCode, spawnError]);

  // Achado ao vivo (2026-09-07) — isto costumava travar no PRIMEIRO id
  // descoberto pra sempre (`useRef(false)` virava `true` e nunca voltava),
  // então um `/resume` dado dentro de um card já aberto (o main process
  // agora rearma `watchForSession` pra isso — ver pty-registry.ts) nunca
  // chegava a atualizar o rodapé: o card trocava de sessão de verdade, mas
  // ninguém além do processo principal ficava sabendo. Guarda o ÚLTIMO id
  // já reportado em vez de só "já reportei alguma vez" — qualquer id NOVO
  // (inclusive um resume dentro da sessão) passa; o mesmo id de novo não
  // reporta duas vezes à toa.
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (discoveredResumeId && discoveredResumeId !== lastReportedRef.current) {
      lastReportedRef.current = discoveredResumeId;
      onResumeIdDiscovered(discoveredResumeId);
    }
  }, [discoveredResumeId, onResumeIdDiscovered]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    };
  }, []);

  // Sino de notificação (2026-09-02, "Terminal, Revisitado") — opt-in por
  // card, ligado por padrão. Local ao componente, não persistido no card
  // (sem coluna própria em card-types.ts ainda) — reseta pra "ligado" a
  // cada boot/remount; limitação conhecida, aceita por ora.
  const [bellEnabled, setBellEnabled] = useState(true);
  // `wasActiveRef` começa false e só vira true quando `isActive` real de
  // fato acontece — evita notificar no MOUNT (onde `isActive` também
  // começa false, e o efeito abaixo roda uma vez de qualquer jeito).
  const wasActiveRef = useRef(false);
  // `isFocusedRef` tracks the current `isFocused` prop via ref so the
  // isActive-only effect can read it without re-running on focus changes.
  // Suppresses the notification when the card is top-of-z-order AND the
  // Electron window has OS focus — meaning the user is actively looking
  // at this card and a notification would be a false positive.
   const isFocusedRef = useRef(false);
  if (Boolean(isFocused) !== isFocusedRef.current) isFocusedRef.current = Boolean(isFocused);
  useEffect(() => {
    if (isActive) {
      wasActiveRef.current = true;
      return;
    }
    if (!wasActiveRef.current) return;
    wasActiveRef.current = false;
    if (!bellEnabled) return;
    // Pedido ao vivo (2026-09-06) — "pros providers sem hook oficial, por
    // enquanto desativa as notificações": as CLIs de agente sem um sinal
    // real de fim de turno — `codex`/`cursor`/`antigravity`/`opencode`,
    // nenhuma tem hook oficial (confirmado investigando os binários) —
    // ficam sem notificação por ora. `codex` ganhou um pattern-match de
    // output (useTerminal.ts's TURN_END_PATTERNS) bom o bastante pra não
    // apagar a barra de atividade à toa, mas ainda uma heurística sobre
    // texto renderizado (uma CLI atualizada pode mudar a frase e nunca
    // mais bater, sem aviso nenhum disso aqui) — não confiável o bastante
    // pra uma notificação de SO ainda. `claude` (hook real) segue normal;
    // `bash` também segue normal — não é um agente com "turnos", nunca
    // fez parte deste problema, sempre notificou pela aproximação de
    // silêncio antiga (ver smoke-terminal-focus-notification.mjs).
    // Reavaliar codex depois de validar o pattern-match ao vivo por um
    // tempo.
    if (NOTIFICATION_DISABLED_PROVIDERS.has(providerId)) return;
    // Suppress notification when this card is the focused one and the
    // window itself has OS focus — user is actively looking at it.
    if (isFocusedRef.current && document.hasFocus()) return;
    try {
      // Requer "notifications" em MAIN_WINDOW_ONLY_PERMISSIONS
      // (main/index.ts) — sem isso o construtor abaixo nunca mostra nada,
      // silenciosamente (confirmado antes de mexer, ver o comentário lá).
      new Notification(t("terminal.turnCompleteNotify", { name: displayName }), { body: cwd, silent: false });
    } catch {
      // Notification API indisponível/negada nesse ambiente — nunca deve
      // quebrar o terminal, só não notifica.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, displayName]);

  const statusClass = spawnError !== null ? "danger" : exitCode !== null ? "" : "ok";
  const statusLabel =
    spawnError !== null
      ? t("terminal.errorLabel", { error: spawnError })
      : exitCode !== null
      ? t("terminal.processExited", { code: exitCode })
      : t("terminal.processRunning");
  useEffect(() => {
    onStatusChange?.(spawnError !== null ? "error" : exitCode !== null ? "exited" : "ok");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnError, exitCode]);
  const effectiveResumeId = resumeId || discoveredResumeId;
  const canIdentify = !effectiveResumeId && SESSION_PROVIDERS.has(providerId);
  const footerParts = [
    cwd,
    effectiveResumeId ? `resume:${effectiveResumeId}` : null,
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
      className={styles.terminalCard}
      kind="terminal"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      displayName={displayName}
      onRename={onRename}
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
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      // The last onChange's state update lands in the DOM asynchronously
      // (React commit + layout) — measuring in fitNow() synchronously here
      // can read the pre-resize container size. Defer one frame.
      onResizeSettled={() =>
        requestAnimationFrame(() => {
          fitNow();
          lastFittedRectRef.current = { w: rect.w, h: rect.h };
          if (containerRef.current) containerRef.current.style.transform = "";
        })
      }
      headerContent={
        <>
          <span className="card-head-label">
            <span
              className={`card-status-dot ${statusClass}`}
              role="status"
              title={statusLabel}
              aria-label={statusLabel}
            />
            {(() => {
              const metal = PROVIDER_GLYPH[providerId] ?? PROVIDER_GLYPH.bash;
              return (
                <span
                  className={`${styles.terminalCardProviderGlyph}${metal.dark ? "" : ` ${styles.flat}`}`}
                  style={
                    {
                      "--m-mid": metal.mid,
                      ...(metal.dark ? { "--m-dark": metal.dark } : {}),
                    } as React.CSSProperties
                  }
                  aria-hidden="true"
                >
                  {metal.glyph}
                </span>
              );
            })()}
          </span>
          <span className="card-head-actions">
            <button
              className={`${styles.terminalCardBell}${bellEnabled ? ` ${styles.on}` : ""}`}
              data-no-drag
              title={bellEnabled ? t("terminal.bellOn") : t("terminal.bellOff")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setBellEnabled((v) => !v)}
            >
              <Icon name="bell" size={12} />
            </button>
            {canIdentify && (
              <button
                ref={menuBtnRef}
                data-no-drag
                data-role="terminal-card-menu"
                title={t("terminal.cardMenu")}
                disabled={identifyBusy}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <Icon name="moreVertical" size={12} />
              </button>
            )}
            <button
              title={t("terminal.sigint")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={interrupt}
            >
              <Icon name="interrupt" size={10} fill="currentColor" />
            </button>
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
      footerContent={
        <span className={styles.terminalCardFootRow}>
          {/* DESIGN-BACKLOG.md, achado 2 (2026-09-11) — DOM de verdade, não
           * bytes no pty (review adversarial provou que uma TUI em tela
           * cheia apaga/corrompe qualquer coisa escrita ali antes do boot
           * dela terminar). Fica pra vida do card — é contexto sobre por
           * que ele começou vazio, não um toast que precisa desaparecer. */}
          {resumeInvalidNotice && (
            <span
              className={styles.terminalCardResumeWarning}
              title={
                resumeInvalidNotice.reason === "missing"
                  ? t("terminal.resumeTitleMissing", { id: resumeInvalidNotice.staleResumeId })
                  : t("terminal.resumeTitleEmpty", { id: resumeInvalidNotice.staleResumeId })
              }
            >
              ⚠ {resumeInvalidNotice.reason === "missing" ? t("terminal.resumeMissing") : t("terminal.resumeEmpty")}
            </span>
          )}
          <span className={styles.terminalCardFootText}>{footerParts.join(" · ")}</span>
          {canIdentify && (
            <span className={styles.terminalCardIdentifySlot}>
              <span className={styles.terminalCardResumeEmpty} data-role="terminal-resume-empty">
                resume:
              </span>
              <button
                ref={identifyBtnRef}
                className={styles.terminalCardIdentify}
                data-role="terminal-identify-session"
                data-busy={identifyBusy ? "true" : undefined}
                title={t("terminal.identifySessionTitle")}
                disabled={identifyBusy}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => void identifyThisSession()}
              >
                {identifyBusy ? t("terminal.identifyingSession") : t("terminal.identifySession")}
              </button>
            </span>
          )}
          {identifyFeedback && (
            <span
              className={styles.terminalCardIdentifyFeedback}
              data-role="terminal-identify-feedback"
              title={identifyFeedbackText(identifyFeedback)}
            >
              {identifyFeedbackText(identifyFeedback)}
            </span>
          )}
          {seenUrls.length > 0 && (
            <button
              ref={urlBadgeRef}
              className={styles.terminalCardUrlBadge}
              data-role="terminal-url-badge"
              title={t("terminal.linksSeen", { count: seenUrls.length })}
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
      {/* Barra de atividade (2026-09-02, "Terminal, Revisitado") — sinal
       * real é `isActive` (useTerminal.ts, ver o comentário lá sobre o
       * que ele de fato mede). Cor vem de `--accent`, já herdada de
       * `.card-frame` (nenhum inline style próprio precisa repetir isso).
       * `aria-hidden`: puramente decorativa, o status já acessível vive em
       * `.card-status-dot` acima. */}
      <div
        className={`${styles.terminalCardActivity}${isActive ? ` ${styles.on}` : ""}`}
        data-role="terminal-activity"
        data-card-id={id}
        data-active={isActive ? "true" : undefined}
        aria-hidden="true"
      >
        <div className={styles.terminalCardActivitySweep} />
      </div>
      <div className={styles.terminalCardBody} data-role="terminal-body" ref={containerRef} />
      {showLoadingHint && (
        <div className={styles.terminalCardLoading} data-role="terminal-loading" role="status">
          <span className={styles.terminalCardLoadingSpinner} aria-hidden="true" />
          {t("terminal.loadingSession")}
        </div>
      )}
      {/* Achado ao vivo, 2026-09-03 — o botão "instalar {provider}" que
          vivia aqui (só aparecia DEPOIS de tentar e falhar o spawn)
          quebrava o fluxo do usuário. Removido: a checagem agora é
          proativa, no Topbar (useAgentAvailability.ts), antes de
          qualquer spawn — este erro fica só como o texto honesto do
          que aconteceu com ESTE card específico. */}
      {spawnError !== null && (
        <div className={styles.terminalCardExited} data-role="terminal-exited">
          {spawnError}
        </div>
      )}
      {exitCode !== null && (
        <div className={styles.terminalCardExited} data-role="terminal-exited">
          {t("terminal.processExitedShort", { code: exitCode })}
        </div>
      )}
      <Popover
        anchorRef={menuBtnRef}
        open={menuOpen && canIdentify}
        onClose={() => setMenuOpen(false)}
        className={styles.terminalCardMenu}
        dataRole="terminal-card-menu-popover"
      >
        <button
          data-role="terminal-identify-menu-item"
          disabled={identifyBusy}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void identifyThisSession()}
        >
          <Icon name="findCard" size={14} />
          {identifyBusy ? t("terminal.identifyingSession") : t("terminal.identifyMenu")}
        </button>
      </Popover>
      <Popover anchorRef={urlBadgeRef} open={urlPopoverOpen} onClose={() => setUrlPopoverOpen(false)} side={urlPopoverSide} className={styles.terminalCardUrlPopover}>
        {[...seenUrls].reverse().map((url) => {
          const feedback = copyFeedback?.url === url ? copyFeedback : null;
          return (
            <div key={url} className={styles.terminalCardUrlRow}>
              <button
                className={`${styles.terminalCardUrlChip}${feedback ? (feedback.ok ? ` ${styles.copied}` : ` ${styles.copyError}`) : ""}`}
                data-role="terminal-url-chip"
                data-copied={feedback?.ok ? "true" : undefined}
                title={url}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => copyUrl(url)}
              >
                {feedback ? (
                  <>
                    <Icon name={feedback.ok ? "check" : "close"} size={11} />
                    {feedback.ok ? t("terminal.copiedClipboard") : t("terminal.copyFail")}
                  </>
                ) : (
                  <>
                    <Icon name="copy" size={11} />
                    {url.replace(/^https?:\/\//, "").slice(0, 44)}
                  </>
                )}
              </button>
              <button
                className={styles.terminalCardUrlOpen}
                data-role="terminal-url-open"
                title={t("terminal.openUrl")}
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
