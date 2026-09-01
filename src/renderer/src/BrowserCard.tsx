import { memo, useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import type { Rect } from "./board-model";

// DESIGN-BACKLOG.md §2.1 Item E — Mobile/Tablet mirroring the real
// devices CentralByte's own presets target. "Fluido" (free resize) has
// no distinct action here — every card in this app already resizes
// freely by default, unlike CentralByte's panes which can be locked to
// a fixed size; there's nothing for a "go back to fluid" preset to undo.
const VIEWPORT_PRESETS: { label: string; icon: "viewportMobile" | "viewportTablet"; w: number; h: number }[] = [
  { label: "Mobile (390×844)", icon: "viewportMobile", w: 390, h: 844 },
  { label: "Tablet (768×1024)", icon: "viewportTablet", w: 768, h: 1024 },
];

// Must stay in sync with browser-registry.ts's own BROWSER_ZOOM_MIN/MAX —
// `toCanvasPoint` needs to know the exact content size `resize()` really
// applied (post-clamp) to map a click to the right coordinate space, and
// there's no cheap way to ask the main process for it on every click.
const BROWSER_ZOOM_MIN = 0.5;
const BROWSER_ZOOM_MAX = 3;

function keyModifiers(e: React.KeyboardEvent): Array<"shift" | "control" | "alt" | "meta"> {
  const mods: Array<"shift" | "control" | "alt" | "meta"> = [];
  if (e.shiftKey) mods.push("shift");
  if (e.ctrlKey) mods.push("control");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  return mods;
}

// Electron's sendInputEvent keyCode is a string in the same vocabulary as
// Accelerator strings, not a DOM KeyboardEvent.code/keyCode — printable
// characters pass through as-is (`"a"`, `"A"`, `"1"`, `"!"`), everything
// else needs an explicit name.
const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Return",
  Escape: "Escape",
  Backspace: "Backspace",
  Tab: "Tab",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  ContextMenu: "Menu",
  " ": "Space",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};
function toElectronKeyCode(key: string): string | null {
  if (key.length === 1) return key;
  return SPECIAL_KEYS[key] ?? null;
}

function mouseButtonName(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function BrowserCardInner({
  id,
  rect,
  zoom,
  zIndex,
  visible,
  isFocused,
  url,
  ownerCardId,
  interactionMode,
  selected,
  reflowing,
  closing,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onFocusOwner,
  onClose,
  onCloseAnimationEnd,
  onConnectorStart,
  onSelectStart,
  screenProjected,
  panX,
  panY,
}: {
  id: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  visible: boolean;
  isFocused: boolean;
  url: string;
  ownerCardId: string | null;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  /** DESIGN-BACKLOG.md §2.1 Item E — pans/raises to the card THAT OWNS
   * this one (the badge's `#{ownerCardId}`), not this card itself
   * (that's `onFocus`, "ajustar à tela"). Omitted (no click handler) when
   * `ownerCardId` is null — nothing to jump to. */
  onFocusOwner?: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through to `CardFrame`; `toCanvasPoint` below needs no
   * change since it already reads the canvas's real on-screen box via
   * `getBoundingClientRect()`, which reflects the true position
   * regardless of how the ancestor got there. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  // Pre-release audit P1 — same render-count counter as TerminalCard.tsx
  // (see its doc comment) — lets the verify harness prove `React.memo`
  // below actually skips this card when nothing about it changed.
  const renderCounts = (window as unknown as { __cardRenderCounts?: Record<string, number> }).__cardRenderCounts ??=
    {};
  renderCounts[id] = (renderCounts[id] ?? 0) + 1;

  const [bar, setBar] = useState(url);
  const createdRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastSizeRef = useRef({ w: 0, h: 0 });
  const lastZoomStepRef = useRef<number | null>(null);
  const zoomResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Achado ao vivo (2026-09-01) — bug real de clique impreciso em
  // qualquer zoom != 1, presente desde a Trilha A do navegador (resize()
  // já escala `w/h` pelo zoom, `browser-registry.ts`), nunca pego pelos
  // testes porque todos rodam em zoom=1 (onde o bug cancela e vira
  // invisível). `toCanvasPoint` media a fração do clique dentro do
  // retângulo REAL na tela (`box`, já pós-transform de zoom do `.world`)
  // e multiplicava por `rect.w`/`h` — o tamanho de mundo SEM zoom — mas o
  // espaço de coordenadas que `sendInputEvent` espera é o content size
  // REAL da BrowserWindow offscreen, que já está multiplicado pelo mesmo
  // zoom (clampado). Em zoom=2 isso mandava o clique pra metade da
  // posição real dentro da página embutida. Mantém o tamanho real
  // aplicado (mesmo clamp de `BROWSER_ZOOM_MIN/MAX` que
  // `browser-registry.ts`'s `resize()` usa) num ref, atualizado toda vez
  // que um resize real é disparado — não recalcula o clamp aqui a partir
  // de `zoom` puro porque o zoom "vivo" (antes do debounce assentar) e o
  // zoom realmente aplicado no offscreen podem divergir por até 150ms.
  const contentSizeRef = useRef({ w: rect.w, h: rect.h });
  // Item 6 (Trilha B) — resolved once from `browser:create`'s response
  // (`browser-registry.ts`'s `resize()` doc comment has the full story on
  // why this can't be true HiDPI supersampling and what it trades off).
  // Starts at 1 (no-op) until the async `create()` call below resolves —
  // an early resize before then just uses standard density; the next
  // real resize corrects it, same bootstrapping gap `contentSizeRef`
  // itself already has.
  const scaleFactorRef = useRef(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // DESIGN-BACKLOG.md §2.1 Item E — count-only, not the full log text
  // (no reading UI for that yet, just the "something needs attention"
  // signal CentralByte's own console badge gives).
  const [consoleCounts, setConsoleCounts] = useState({ error: 0, warning: 0 });
  // Próxima rodada §3 — favoritos GLOBAIS (decisão explícita do usuário,
  // não por board). `pageTitle` finalmente consome `window.browser.onTitle`
  // (exposto no preload desde sempre, nunca lido por nada até agora) —
  // precisa de um título de verdade pra salvar, não só a URL crua.
  const [pageTitle, setPageTitle] = useState(url);
  const [favorites, setFavorites] = useState<{ url: string; title: string; created_at: number }[]>([]);
  const [favMenuOpen, setFavMenuOpen] = useState(false);
  const favBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const off = window.browser.onConsoleMessage((msgId, level) => {
      if (msgId !== id) return;
      if (level === "error") setConsoleCounts((c) => ({ ...c, error: c.error + 1 }));
      else if (level === "warning") setConsoleCounts((c) => ({ ...c, warning: c.warning + 1 }));
    });
    return () => {
      off();
    };
  }, [id]);

  useEffect(() => {
    const off = window.browser.onTitle((msgId, title) => {
      if (msgId === id) setPageTitle(title);
    });
    return () => {
      off();
    };
  }, [id]);

  async function refreshFavorites() {
    setFavorites(await window.store.favorites.list());
  }
  useEffect(() => {
    if (favMenuOpen) void refreshFavorites();
  }, [favMenuOpen]);
  const isFavorited = favorites.some((f) => f.url === bar);
  async function toggleFavorite() {
    if (isFavorited) await window.store.favorites.remove(bar);
    else await window.store.favorites.add(bar, pageTitle || bar);
    await refreshFavorites();
  }
  async function removeFavoriteRow(favUrl: string, e: React.MouseEvent) {
    e.stopPropagation();
    await window.store.favorites.remove(favUrl);
    await refreshFavorites();
  }
  function goToFavorite(favUrl: string) {
    void window.browser.navigate(id, favUrl);
    setFavMenuOpen(false);
  }

  useEffect(() => {
    if (!createdRef.current) {
      createdRef.current = true;
      void window.browser.create(id, url).then(({ scaleFactor }) => {
        scaleFactorRef.current = scaleFactor;
      });
    }
    return () => {
      void window.browser.destroy(id);
    };
    // Create/destroy are keyed to the card's identity only — navigating
    // later (address bar, ask-modal Allow) must never re-create the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const offNav = window.browser.onNavigate((navId, navUrl) => {
      if (navId !== id) return;
      setBar(navUrl);
      // Same "console clears on navigate" convention real DevTools uses —
      // counts from the previous page aren't meaningful for this one.
      setConsoleCounts({ error: 0, warning: 0 });
    });
    return () => {
      offNav();
    };
  }, [id]);

  // Draws each JPEG frame from the card's offscreen BrowserWindow straight
  // onto its own canvas (see browser-registry.ts) — plain DOM content, so
  // it rides the same CSS transform every other card kind already gets for
  // free and respects real z-order/occlusion without any manual bounds
  // math or viewport clamping.
  useEffect(() => {
    let cancelled = false;
    const offFrame = window.browser.onFrame(async (frameId, buffer, width, height) => {
      if (frameId !== id || cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        // IPC always hands us a real ArrayBuffer-backed Uint8Array (cloned
        // from the main-process Buffer) — the cast just satisfies BlobPart's
        // stricter-than-necessary type, which also allows SharedArrayBuffer.
        const bitmap = await createImageBitmap(new Blob([buffer as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
        if (cancelled) {
          bitmap.close();
          return;
        }
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // A frame arriving for a card mid-teardown (destroy raced the next
        // paint) — drop it, nothing to recover.
      }
    });
    return () => {
      cancelled = true;
      offFrame();
    };
  }, [id]);

  useEffect(() => {
    void window.browser.setVisible(id, visible);
  }, [id, visible]);

  // Pre-release audit P2 — lowers paint rate for a visible-but-not-
  // topmost card instead of always painting at full 30fps.
  useEffect(() => {
    void window.browser.setFocused(id, isFocused);
  }, [id, isFocused]);

  // Trilha A do navegador (browser-registry.ts's `resize` doc comment) —
  // a resolução real do conteúdo offscreen agora acompanha o zoom do
  // board, não só o tamanho de mundo do card. Um resize genuíno de rect
  // (arraste da alça, já throttled por rAF no CardFrame) dispara na
  // hora, sempre com o zoom atual; um zoom PURO (rect igual, só o board
  // deu zoom) é mais caro que mudar um fontSize — re-renderiza a página
  // real e recodifica um JPEG maior — então arredonda pro passo de 0.25
  // mais próximo e espera ~150ms de zoom "assentado" antes de disparar,
  // mesma disciplina do aviso em SCREEN_SPACE_PROJECTION_PLAN.md §0.3.
  function applyResize(w: number, h: number, z: number) {
    const effectiveZoom = Math.min(BROWSER_ZOOM_MAX, Math.max(BROWSER_ZOOM_MIN, z));
    const factor = effectiveZoom * scaleFactorRef.current;
    contentSizeRef.current = {
      w: Math.max(1, Math.round(w * factor)),
      h: Math.max(1, Math.round(h * factor)),
    };
    void window.browser.resize(id, w, h, z);
  }

  useEffect(() => {
    const w = Math.round(rect.w);
    const h = Math.round(rect.h);
    const zoomStep = Math.round(zoom * 4) / 4;
    const sizeChanged = lastSizeRef.current.w !== w || lastSizeRef.current.h !== h;
    const zoomChanged = lastZoomStepRef.current !== zoomStep;
    if (!sizeChanged && !zoomChanged) return;

    if (zoomResizeTimerRef.current) {
      clearTimeout(zoomResizeTimerRef.current);
      zoomResizeTimerRef.current = null;
    }

    if (sizeChanged) {
      lastSizeRef.current = { w, h };
      lastZoomStepRef.current = zoomStep;
      applyResize(w, h, zoom);
      return;
    }

    zoomResizeTimerRef.current = setTimeout(() => {
      zoomResizeTimerRef.current = null;
      lastZoomStepRef.current = zoomStep;
      applyResize(w, h, zoom);
    }, 150);
  }, [id, rect.w, rect.h, zoom]);

  useEffect(() => {
    return () => {
      if (zoomResizeTimerRef.current) clearTimeout(zoomResizeTimerRef.current);
    };
  }, []);

  function toCanvasPoint(e: React.PointerEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    // The embedded page's own coordinate space is `contentSizeRef.current`
    // (logical CSS px — what `resize()` REALLY set the offscreen window's
    // content size to, post-zoom-clamp), NOT `rect.w`/`rect.h` (the
    // card's world-space, pre-zoom size) and not `canvas.width`/`height`
    // (the raw JPEG's device-pixel size) either. Bug found live
    // (2026-09-01): using `rect.w`/`rect.h` here was only correct at
    // zoom=1 by coincidence — Trilha A's `resize()` scales the real
    // offscreen content by zoom, so at zoom=2 a click was landing at
    // literally half its intended position inside the embedded page.
    const { w: contentW, h: contentH } = contentSizeRef.current;
    return {
      x: ((e.clientX - box.left) / box.width) * contentW,
      y: ((e.clientY - box.top) / box.height) * contentH,
    };
  }

  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (interactionMode !== "normal") return;
    const p = toCanvasPoint(e);
    if (!p) return;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    window.browser.sendMouse(id, { type: "mouseDown", ...p, button: mouseButtonName(e.button), clickCount: 1 });
  }
  function onCanvasPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (interactionMode !== "normal") return;
    const p = toCanvasPoint(e);
    if (!p) return;
    window.browser.sendMouse(id, { type: "mouseMove", ...p });
  }
  function onCanvasPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (interactionMode !== "normal") return;
    const p = toCanvasPoint(e);
    if (!p) return;
    window.browser.sendMouse(id, { type: "mouseUp", ...p, button: mouseButtonName(e.button), clickCount: 1 });
  }
  // Achado ao vivo (2026-08-31) — sem isso, qualquer `:hover`/tooltip/
  // dropdown que a página embutida abriu ao passar o mouse nunca fecha
  // quando o cursor sai do canvas (nada aqui nunca disparava um sinal
  // de "saiu"). x/y não importam pro tipo `mouseLeave` em si.
  function onCanvasPointerLeave() {
    if (interactionMode !== "normal") return;
    window.browser.sendMouse(id, { type: "mouseLeave", x: 0, y: 0 });
  }
  // Every wheel gesture anywhere on the board zooms it (useWorldTransform's
  // onWheel) — without gating this, scrolling a loaded page also zoomed the
  // whole board underneath it (and dragged the card, header included, out
  // from under the app's own floating chrome). Only forward to the page
  // (and eat the event) once the card has real DOM focus, i.e. after a
  // click — matches every other "scroll this, not the page" widget
  // convention. Unfocused, this returns without stopping propagation —
  // used to let it bubble all the way to the board's own zoom (the
  // ORIGINAL behavior here); as of the universal card-level wheel fix
  // (CardFrame.tsx, 2026-08-27) it now just stops at the card boundary
  // instead — unfocused scroll over a browser card does nothing (not
  // zoom-through) until a click focuses it, same as every other card.
  function onCanvasWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (interactionMode !== "normal" || document.activeElement !== e.currentTarget) return;
    const p = toCanvasPoint(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    // Electron's sendInputEvent mouseWheel takes ticks in the opposite sign
    // convention from the DOM WheelEvent it's built from — sending
    // e.deltaX/deltaY straight through scrolled the embedded page backwards
    // (confirmed live). Negate both.
    window.browser.sendWheel(id, { ...p, deltaX: -e.deltaX, deltaY: -e.deltaY });
  }
  function onCanvasKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    // While an IME composition is in progress, every intermediate keydown
    // (including the one that ends up producing the candidate list) must
    // NOT be forwarded as a normal key/char — the composed text only
    // exists once, on `compositionend`, and is sent there via `insertText`
    // instead. Forwarding here too would double-insert or send garbage
    // half-composed keycodes to the embedded page.
    if (e.nativeEvent.isComposing) return;
    // Real OS clipboard round-trip — a synthetic keyDown alone never
    // inserts/copies real clipboard content (see browser-registry.ts's
    // insertText/paste/copy/cut doc comment). Still forward the raw keyDown
    // below too (harmless, matches what a page's own shortcut-handling
    // keydown listener would see in a real browser), but do the actual
    // data movement through the dedicated Electron API.
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "v" || e.key === "V")) void window.browser.paste(id);
    else if (mod && (e.key === "c" || e.key === "C")) void window.browser.copy(id);
    else if (mod && (e.key === "x" || e.key === "X")) void window.browser.cut(id);

    const keyCode = toElectronKeyCode(e.key);
    if (!keyCode) return;
    e.preventDefault();
    const mods = keyModifiers(e);
    window.browser.sendKey(id, { type: "keyDown", keyCode, modifiers: mods });
    // keyDown/keyUp alone only update key-state (what a page's own keydown
    // listener sees) — they never insert text. Electron's sendInputEvent
    // has a separate "char" type that's what actually drives typing into a
    // real <input>/<textarea> (confirmed live: without this, click-to-focus
    // worked but every keystroke produced an empty field). Skipped for
    // ctrl/alt/meta combos — those are shortcuts, not text, same as a real
    // browser never inserting "c" for Ctrl+C.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      window.browser.sendKey(id, { type: "char", keyCode: e.key });
    }
  }
  function onCanvasKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (e.nativeEvent.isComposing) return;
    const keyCode = toElectronKeyCode(e.key);
    if (!keyCode) return;
    e.preventDefault();
    window.browser.sendKey(id, { type: "keyUp", keyCode, modifiers: keyModifiers(e) });
  }
  // IME composition (CJK input methods, etc.) doesn't correspond to
  // individual physical keys — the intermediate candidate text lives only
  // in the OS/browser's own composition UI until confirmed. Only the final
  // string, delivered on `compositionend`, gets forwarded — via
  // `insertText`, the same real-text-insertion API used for paste.
  function onCanvasCompositionEnd(e: React.CompositionEvent<HTMLCanvasElement>) {
    if (e.data) void window.browser.insertText(id, e.data);
  }

  // Presets de viewport (DESIGN-BACKLOG.md §2.1 Item E) — mesmo par
  // onChange+onCommit que um drag de resize concluído produz, só que
  // numa chamada só em vez de vários ticks; onChange (App.tsx's
  // tryChangeRect) já cobre a checagem de colisão que um card de
  // navegador precisa (nunca sobrepor outro card).
  function applyPresetSize(w: number, h: number) {
    const next = { ...rect, w, h };
    onChange(next);
    onCommit(next);
  }

  const consoleBadgeCount = consoleCounts.error + consoleCounts.warning;

  return (
    <CardFrame
      className="browser-card"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      interactionMode={interactionMode}
      selected={selected}
      accent="var(--accent-browser)"
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
        <div className="browser-card-address">
          <button onClick={() => window.browser.back(id)}>
            <Icon name="back" size={12} />
          </button>
          <button onClick={() => window.browser.forward(id)}>
            <Icon name="forward" size={12} />
          </button>
          <button onClick={() => window.browser.reload(id)}>
            <Icon name="reload" size={12} />
          </button>
          <input
            value={bar}
            onChange={(e) => setBar(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void window.browser.navigate(id, bar);
            }}
          />
          {ownerCardId && (
            // DESIGN-BACKLOG.md §2.1 Item E — clicável agora: pan/raise
            // até o card que abriu este navegador (`jumpToCard` via
            // `onFocusOwner`), não só uma etiqueta informativa.
            <button
              className="browser-card-owner"
              title={`aberto por card #${ownerCardId} — clique pra ir até lá`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onFocusOwner}
            >
              #{ownerCardId}
            </button>
          )}
          {consoleBadgeCount > 0 && (
            <span
              className="browser-card-console-badge"
              data-severity={consoleCounts.error > 0 ? "error" : "warning"}
              title={`${consoleCounts.error} erro(s), ${consoleCounts.warning} aviso(s) no console`}
            >
              {consoleBadgeCount}
            </span>
          )}
          <button
            ref={favBtnRef}
            className="browser-card-favorite-btn"
            data-active={isFavorited}
            title={isFavorited ? "Remover dos favoritos" : "Favoritar esta página"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setFavMenuOpen((v) => !v)}
          >
            <Icon name="favorite" size={12} />
          </button>
          <button
            ref={menuBtnRef}
            title="Mais opções"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="moreVertical" size={12} />
          </button>
          <button onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>
      }
    >
      <canvas
        ref={canvasRef}
        className="browser-card-body"
        tabIndex={0}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerLeave={onCanvasPointerLeave}
        onWheel={onCanvasWheel}
        onKeyDown={onCanvasKeyDown}
        onKeyUp={onCanvasKeyUp}
        onCompositionEnd={onCanvasCompositionEnd}
      />
      <Popover anchorRef={menuBtnRef} open={menuOpen} onClose={() => setMenuOpen(false)} className="browser-card-menu">
        {/* Header responsivo (§2.1) — sempre presentes aqui, não só
         * quando a linha principal esconde os badges (< 380px de
         * largura via @container em cards.css): nenhuma informação fica
         * inacessível, só sai da barra principal em telas estreitas. */}
        {ownerCardId && (
          <button
            onClick={() => {
              onFocusOwner?.();
              setMenuOpen(false);
            }}
          >
            <Icon name="link" size={14} />
            Aberto por card #{ownerCardId}
          </button>
        )}
        {consoleBadgeCount > 0 && (
          <div className="browser-card-menu-info" data-severity={consoleCounts.error > 0 ? "error" : "warning"}>
            {consoleCounts.error} erro(s), {consoleCounts.warning} aviso(s) no console
          </div>
        )}
        {(ownerCardId || consoleBadgeCount > 0) && <div className="browser-card-fav-divider" />}
        <button
          onClick={() => {
            void window.browser.openDevTools(id);
            setMenuOpen(false);
          }}
        >
          <Icon name="devTools" size={14} />
          Abrir DevTools
        </button>
        {VIEWPORT_PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              applyPresetSize(preset.w, preset.h);
              setMenuOpen(false);
            }}
          >
            <Icon name={preset.icon} size={14} />
            {preset.label}
          </button>
        ))}
      </Popover>
      <Popover anchorRef={favBtnRef} open={favMenuOpen} onClose={() => setFavMenuOpen(false)} className="browser-card-menu browser-card-favorites-menu">
        <button onClick={toggleFavorite}>
          <Icon name="favorite" size={14} />
          {isFavorited ? "Remover dos favoritos" : "Favoritar esta página"}
        </button>
        {favorites.length > 0 && (
          <>
            <div className="browser-card-fav-divider" />
            <div className="browser-card-fav-list">
              {favorites.map((fav) => (
                <div key={fav.url} className="browser-card-fav-row" onClick={() => goToFavorite(fav.url)}>
                  <span className="browser-card-fav-title" title={fav.url}>
                    {fav.title || fav.url}
                  </span>
                  <button className="browser-card-fav-remove" title="Remover" onClick={(e) => void removeFavoriteRow(fav.url, e)}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </Popover>
    </CardFrame>
  );
}

export const BrowserCard = memo(BrowserCardInner);
