import { BrowserWindow } from "electron";

export type BrowserMouseEvent = {
  /** `mouseLeave` — achado ao vivo (2026-08-31): sem sinal explícito de
   * "o cursor saiu do card", qualquer `:hover`/tooltip/dropdown que a
   * página embutida abriu ao passar o mouse nunca fecha quando o cursor
   * sai do canvas (nada nele nunca dispara um `mouseleave`/`mouseout`
   * real). Electron's `sendInputEvent` aceita esse tipo nativamente pra
   * eventos de mouse — não é um hack de coordenada fora-de-bounds. */
  type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseLeave";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
};
export type BrowserWheelEvent = { x: number; y: number; deltaX: number; deltaY: number };
export type BrowserKeyEvent = {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers?: Array<"shift" | "control" | "alt" | "meta">;
};

type Entry = { win: BrowserWindow; visible: boolean; scaleFactor: number };

// Pre-release audit P2 — every visible browser card painted at the same
// rate regardless of whether it's the one the user is actually
// interacting with. Two visible-but-unfocused cards (the common
// multi-browser-card layout) competed for main-process CPU/IPC at full
// rate for content nobody's actively watching move.
//
// Pedido ao vivo (2026-08-31, uso da v0.2.0) — 30fps focado sentia
// travado; subiu pra 60. `UNFOCUSED_FRAME_RATE` ficou parado em 8 por
// decisão explícita: sem custo extra pra cards fora de foco, só o card
// que a pessoa está de fato olhando fica mais caro em encode/transfer
// JPEG por frame.
const FOCUSED_FRAME_RATE = 60;
const UNFOCUSED_FRAME_RATE = 8;

/**
 * Ported from CentralByte's browser.rs::normalize_url — rejects schemes that
 * would let a "navigate to a URL" request turn into local code execution or
 * file access (javascript:/file:/data:/blob:/vbscript:); bare localhost/IP
 * gets http, everything else gets https if no scheme was given.
 */
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "about:blank") return "about:blank";
  const schemeMatch = t.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return t;
  if (scheme === "javascript" || scheme === "file" || scheme === "data" || scheme === "blob" || scheme === "vbscript") {
    throw new Error("unsupported url scheme");
  }
  if (scheme === "about") throw new Error("unsupported url scheme");
  if (scheme && t.includes("://")) throw new Error("unsupported url scheme");
  if (t.startsWith("localhost") || t.startsWith("127.")) return `http://${t}`;
  return `https://${t}`;
}

/**
 * 2026-08-26 — rewritten from a native `WebContentsView` child
 * (`win.contentView.addChildView`) to offscreen rendering. The child-view
 * approach never composited into the main window on this machine — the
 * view demonstrably loaded and painted real content internally (confirmed
 * via CDP on its own target) but only its background color ever reached
 * the screen. That's not a bug in this app: electron/electron#45367
 * confirms `addChildView(WebContentsView)` visually failing to render
 * despite showing up in the DevTools tree, closed "not planned" upstream —
 * accepted as a real, permanent limitation of that API for exactly this
 * multi-live-child-view-on-a-dynamic-layout use case. See
 * DESIGN-BACKLOG.md item 9 for the full investigation (GPU ruled out,
 * `--ozone-platform=x11` tried and reverted — it stopped the window from
 * appearing at all).
 *
 * Each browser card now gets its own hidden (`show: false`) BrowserWindow
 * with `webPreferences.offscreen: true`. Its `webContents` never attaches
 * to any real window — Chromium paints it to an in-memory buffer instead,
 * delivered via the `paint` event. The renderer draws that buffer onto a
 * plain `<canvas>` inside the card's own DOM (BrowserCard.tsx), so it rides
 * the same CSS transform as every other card kind and respects real DOM
 * z-order/occlusion for free — no more CHROME_INSETS/manual bounds math,
 * no more `raise()`.
 */
export function createBrowserRegistry(callbacks: {
  onNavigate: (id: string, url: string) => void;
  onTitle: (id: string, title: string) => void;
  onLoading: (id: string, loading: boolean) => void;
  onFrame: (id: string, jpeg: Buffer, width: number, height: number) => void;
  /** DESIGN-BACKLOG.md §2.1 Item E — `level` is Electron's own current
   * (non-deprecated) string scale, forwarded raw rather than pre-
   * filtered here so the renderer decides what counts toward its error/
   * warning badge (see BrowserCard.tsx). Zero new architecture —
   * `console-message` is a plain built-in `webContents` event, same
   * primitive class as `did-navigate`/`page-title-updated` right below. */
  onConsoleMessage: (id: string, level: "info" | "warning" | "error" | "debug", message: string) => void;
  /** Achado ao vivo ("navegador parece 360p") — `webPreferences.offscreen`
   * defaults to `deviceScaleFactor: 1` regardless of the real monitor,
   * confirmed direto no `electron.d.ts` da versão instalada. Toda página
   * embutida rasterizava em densidade 1x mesmo numa tela HiDPI (2x
   * comum) — texto/imagem saíam nativamente moles antes de qualquer
   * JPEG/zoom. `screen.getDisplayMatching(win.getBounds())` (main/
   * index.ts) usa o display onde a janela do app REALMENTE está, correto
   * em multi-monitor com DPIs diferentes, não só "primary display". */
  getScaleFactor: () => number;
}) {
  const entries = new Map<string, Entry>();

  function create(id: string, url: string) {
    const scaleFactor = callbacks.getScaleFactor();
    const win = new BrowserWindow({
      show: false,
      width: 720,
      height: 560,
      webPreferences: {
        offscreen: { deviceScaleFactor: scaleFactor },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const wc = win.webContents;
    // Caps the max paint rate across every open browser card — Chromium
    // only actually emits `paint` on real change (scroll, animation, load),
    // so a mostly-static page costs nothing between those; this just bounds
    // the worst case (video, fast scrolling) instead of firing at whatever
    // the compositor would otherwise allow. A newly created card is the one
    // the user just asked for — starts at the focused rate; `setFocused`
    // below lowers it once something else gets raised on top.
    wc.setFrameRate(FOCUSED_FRAME_RATE);

    wc.on("paint", (_event, _dirty, image) => {
      const entry = entries.get(id);
      if (!entry?.visible) return;
      const { width, height } = image.getSize();
      if (width === 0 || height === 0) return;
      // JPEG, not the raw BGRA bitmap — a 720×560 raw frame is ~1.6MB;
      // over IPC at any real paint rate across several open cards that's
      // not viable. JPEG trades a bit of text crispness for something that
      // actually fits an IPC channel repeatedly.
      callbacks.onFrame(id, image.toJPEG(70), width, height);
    });

    // Same reasoning as before this rewrite: modern Chromium renders
    // about:blank's own background dark under a dark OS/user color-scheme
    // preference, regardless of setBackgroundColor. Force light so a
    // blank/never-navigated card reads as "empty", not "broken".
    wc.on("dom-ready", () => {
      void wc.insertCSS("html{color-scheme:light;background:#fff;}");
    });

    // DESIGN-BACKLOG.md item 37 — a real crash reported live (fullscreen
    // video, "opens another window that errors, crashes the app on
    // close"); not reproduced after real effort (3 separate live CDP
    // repros, see main/index.ts's crash-safety-net comment for detail),
    // but this was a genuine, independently-real gap found reading the
    // code either way: no `setWindowOpenHandler` meant ANY `window.open()`
    // from inside an embedded page (ads, a video player's own popup,
    // YouTube's "watch on..." links, anything) spawned a completely
    // unmanaged, un-offscreen, un-hidden, ACTUALLY VISIBLE native
    // `BrowserWindow` — outside this registry's `entries` map, outside
    // every card lifecycle (resize/destroy/paint), a real "outra janela"
    // by definition. Denied outright: this app has no UI for a second
    // window per card, and a real one showing up broken/unstyled (no
    // `webPreferences` matching this card's own, no positioning) is worse
    // than just not opening it — `navigate()` already exists for a card
    // that wants to follow a link in place.
    wc.setWindowOpenHandler(() => ({ action: "deny" }));

    // Same item — HTML5 fullscreen (a video's own fullscreen button) has
    // no business trying to make the underlying host `BrowserWindow`
    // (offscreen, `show: false`, never mapped by the OS) go native
    // fullscreen; Electron's default un-intercepted behavior tries to
    // sync the two. Explicitly undoing it here every time keeps this
    // window inert regardless of platform-specific fullscreen/windowing
    // behavior (Wayland vs. X11) — the page's OWN fullscreen CSS/JS still
    // resolves normally either way (confirmed live:
    // `document.fullscreenElement` genuinely became truthy and the video
    // filled its own frame), so the card's canvas in BrowserCard.tsx
    // still shows the video "fullscreen" within the card, which is the
    // only fullscreen that makes sense for an embedded card in the first
    // place — the host window was never meant to be seen at all.
    wc.on("enter-html-full-screen", () => {
      if (win.isFullScreen()) win.setFullScreen(false);
    });

    wc.on("did-navigate", (_e, navUrl) => callbacks.onNavigate(id, navUrl));
    wc.on("did-navigate-in-page", (_e, navUrl) => callbacks.onNavigate(id, navUrl));
    wc.on("page-title-updated", (_e, title) => callbacks.onTitle(id, title));
    wc.on("did-start-loading", () => callbacks.onLoading(id, true));
    wc.on("did-stop-loading", () => callbacks.onLoading(id, false));
    wc.on("console-message", (details) => callbacks.onConsoleMessage(id, details.level, details.message));

    entries.set(id, { win, visible: true, scaleFactor });
    void wc.loadURL(normalizeUrl(url));
  }

  function navigate(id: string, url: string) {
    void entries.get(id)?.win.webContents.loadURL(normalizeUrl(url));
  }

  function back(id: string) {
    const wc = entries.get(id)?.win.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  function forward(id: string) {
    const wc = entries.get(id)?.win.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  function reload(id: string) {
    entries.get(id)?.win.webContents.reload();
  }

  /** DESIGN-BACKLOG.md §2.1 Item E — `openDevTools` works on an offscreen
   * `webContents` same as a real one; `mode: "detach"` opens it as its
   * OWN normal (on-screen) window rather than trying to render DevTools
   * itself offscreen, which Electron doesn't support. */
  function openDevTools(id: string) {
    entries.get(id)?.win.webContents.openDevTools({ mode: "detach" });
  }

  // Trilha A do navegador (SCREEN_SPACE_PROJECTION_PLAN.md §0.3's "Trilha
  // A do navegador" note, executada 2026-08-31) — mesmo mecanismo de bug
  // que o terminal tinha antes da própria Trilha A: a `BrowserWindow`
  // offscreen rasterizava sempre no tamanho de MUNDO (pré-zoom), e o
  // `scale(zoom)` do `.world` só esticava o JPEG capturado, borrando.
  // Clampado (não `zoom` cru) pela mesma razão do `FONT_SIZE_MIN/MAX` do
  // terminal: sem teto, zoom extremo faria a página re-renderizar e
  // codificar JPEG num tamanho de pixel correndo solto (mais caro que o
  // fontSize do terminal — ver o aviso do próprio plano); sem piso, zoom
  // extremo pra fora encolheria o conteúdo real a quase nada.
  const BROWSER_ZOOM_MIN = 0.5;
  const BROWSER_ZOOM_MAX = 3;

  /** Resizes the offscreen viewport itself — the renderer calls this when
   * the card's own (world-space, pre-zoom) rect w/h changes OR the board
   * zoom settles on a new step, matching how the terminal's real
   * `fontSize` tracks zoom (Trilha A). `zoom` defaults to 1 for callers
   * that only care about a plain rect resize (kept content resolution
   * unscaled) — every real caller in this app always passes the current
   * board zoom. */
  function resize(id: string, w: number, h: number, zoom = 1) {
    const entry = entries.get(id);
    if (!entry) return;
    const effectiveZoom = Math.min(BROWSER_ZOOM_MAX, Math.max(BROWSER_ZOOM_MIN, zoom));
    entry.win.setContentSize(Math.max(1, Math.round(w * effectiveZoom)), Math.max(1, Math.round(h * effectiveZoom)));
  }

  /** Test-only (scripts/verify) — the real content-pixel size the
   * offscreen `BrowserWindow` is currently rasterizing at, straight from
   * Electron itself. Used to prove `resize`'s zoom scaling actually
   * happened, the same "read the real instance, don't infer it" spirit
   * as `terminal-registry.ts`'s `getTerminalFontSize`. */
  function getContentSize(id: string): { w: number; h: number; scaleFactor: number } | null {
    const entry = entries.get(id);
    if (!entry) return null;
    const [w, h] = entry.win.getContentSize();
    return { w, h, scaleFactor: entry.scaleFactor };
  }

  /** Pauses/resumes actual compositing (`stopPainting`/`startPainting`),
   * not just frame delivery — an off-viewport card costs nothing instead of
   * still paying for paints nobody draws. */
  function setVisible(id: string, visible: boolean) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.visible = visible;
    const wc = entry.win.webContents;
    if (visible && !wc.isPainting()) wc.startPainting();
    else if (!visible && wc.isPainting()) wc.stopPainting();
  }

  /** Pre-release audit P2 — a visible-but-not-topmost card still needs
   * to paint (it's genuinely on screen), just not at full rate: nobody's
   * watching it move right now the way they are the one they raised. */
  function setFocused(id: string, focused: boolean) {
    entries.get(id)?.win.webContents.setFrameRate(focused ? FOCUSED_FRAME_RATE : UNFOCUSED_FRAME_RATE);
  }

  function sendMouseEvent(id: string, evt: BrowserMouseEvent) {
    const entry = entries.get(id);
    if (!entry) return;
    // A `show: false` offscreen window never becomes OS-active, and
    // Chromium's own click-to-focus-a-form-field path checks the
    // WebContents' focus state, not just where the synthetic click lands —
    // without this, clicking into a real <input>/<textarea> on the page
    // looked like nothing happened (no caret, no typing) even though the
    // click itself was reaching the right coordinates. Real windows get
    // this for free from the OS when the user clicks into them; this is
    // the offscreen equivalent, done explicitly on every mousedown.
    if (evt.type === "mouseDown") entry.win.webContents.focus();
    entry.win.webContents.sendInputEvent({
      type: evt.type,
      x: Math.round(evt.x),
      y: Math.round(evt.y),
      button: evt.button ?? "left",
      clickCount: evt.clickCount ?? 1,
    });
  }

  function sendWheelEvent(id: string, evt: BrowserWheelEvent) {
    entries.get(id)?.win.webContents.sendInputEvent({
      type: "mouseWheel",
      x: Math.round(evt.x),
      y: Math.round(evt.y),
      deltaX: evt.deltaX,
      deltaY: evt.deltaY,
      canScroll: true,
    });
  }

  function sendKeyEvent(id: string, evt: BrowserKeyEvent) {
    entries.get(id)?.win.webContents.sendInputEvent({
      type: evt.type,
      keyCode: evt.keyCode,
      modifiers: evt.modifiers,
    });
  }

  // Item 26, teclado — 3 gaps reais que `sendInputEvent`'s keyDown/char
  // vocabulary não cobre (BrowserCard.tsx). Os três usam métodos reais
  // do WebContents em vez de tentar sintetizar mais eventos de teclado:
  // - `insertText`: composição de IME (chinês/japonês/coreano) não
  //   corresponde a teclas físicas individuais — o texto final composto
  //   (evento `compositionend` do lado do renderer) precisa ser inserido
  //   de uma vez, não caractere por caractere via `char`.
  // - `paste`: um keyDown sintético de Ctrl+V nunca insere o conteúdo
  //   real do clipboard sozinho (`sendInputEvent` não dispara isso) —
  //   precisa do método dedicado do Electron.
  // - `copy`/`cut`: mesma classe de problema, mesma solução.
  function insertText(id: string, text: string) {
    void entries.get(id)?.win.webContents.insertText(text);
  }
  function pasteText(id: string) {
    entries.get(id)?.win.webContents.paste();
  }
  function copyText(id: string) {
    entries.get(id)?.win.webContents.copy();
  }
  function cutText(id: string) {
    entries.get(id)?.win.webContents.cut();
  }

  /** Test-only (see main/index.ts's `app.isPackaged` guard) — about:blank
   * has no editable field by default, needed to give the paste/copy/IME
   * smoke test a real target without depending on a real third-party
   * page's markup. */
  async function testMakeEditable(id: string) {
    const wc = entries.get(id)?.win.webContents;
    if (!wc) return;
    // Also mirrors every keydown into the page's own title (observable via
    // the existing onTitle IPC channel) — the only page-level side effect
    // a named key like "F5" has on a bare offscreen page with no browser
    // chrome/menu attached (no default reload-on-F5 outside a real
    // browser shell), so this is the smoke test's way to prove a named
    // key genuinely reaches the embedded page's own DOM listeners.
    await wc.executeJavaScript(
      "document.body.contentEditable = 'true'; document.body.focus();" +
        "window.addEventListener('keydown', (e) => { document.title = 'key:' + e.key + ':' + e.ctrlKey; });",
    );
  }

  // DESIGN-BACKLOG.md item 21, ponto 9, achado 5 — an agent could only
  // ever get PIXELS of a browser card (acbridge/MCP `snapshot`), never
  // its actual content; useless for a provider with no image input, and
  // wasteful for one that has it but just needs "what does this page
  // say". `executeJavaScript` is a plain Electron primitive already
  // available on every WebContents here — no new architecture. Truncated
  // rather than returned raw: a complex real page's `innerText` can run
  // to hundreds of KB of mostly-nav/footer noise, which is worse than
  // useless stuffed whole into an agent's context.
  const MAX_PAGE_TEXT_CHARS = 20_000;
  async function getPageText(id: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript("document.body ? document.body.innerText : ''");
      const text = typeof raw === "string" ? raw : "";
      const truncated = text.length > MAX_PAGE_TEXT_CHARS;
      return { ok: true, text: truncated ? text.slice(0, MAX_PAGE_TEXT_CHARS) : text, truncated };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // DESIGN-BACKLOG.md §2.1 "MCP do Navegador — Orquestração Completa" —
  // até aqui um agente só conseguia ABRIR (`open_url`) e LER
  // (`getPageText`) um card de navegador, nunca agir dentro dele. Os 6
  // métodos abaixo (mais `clickSelector`/`query`/`evalJs` usando
  // `executeJavaScript`, mesmo primitivo já usado por `getPageText`) dão
  // controle real, sem depender do humano estar olhando pra clicar.

  /** Um clique de verdade é down+up, não só um dos dois — e um `mouseMove`
   * antes garante que a página viu o cursor "chegar" no elemento (hover)
   * antes do clique, igual uma interação humana real. */
  function clickAtPoint(id: string, x: number, y: number): { ok: true } | { ok: false; error: string } {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    sendMouseEvent(id, { type: "mouseMove", x, y });
    sendMouseEvent(id, { type: "mouseDown", x, y, button: "left", clickCount: 1 });
    sendMouseEvent(id, { type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return { ok: true };
  }

  /** Resolve o centro real do elemento via `executeJavaScript`
   * (`querySelector` + `scrollIntoView` + `getBoundingClientRect`) antes
   * de clicar — muito mais preciso que pedir pro agente adivinhar x/y a
   * partir de um screenshot, e resiliente a scroll/zoom/resize desde a
   * última vez que a página foi vista. */
  async function clickSelector(
    id: string,
    selector: string,
  ): Promise<{ ok: true; x: number; y: number } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()
      `);
      if (!raw || typeof raw !== "object") return { ok: false, error: `no element matches selector "${selector}"` };
      const { x, y } = raw as { x: number; y: number };
      clickAtPoint(id, x, y);
      return { ok: true, x, y };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** `selector` given: focus that field first (via `clickSelector`) so
   * the typed text lands where the caller actually meant, instead of
   * whatever happened to be focused already. Uses `insertText` — same
   * IME-safe, "whole string at once" method item 26 already established
   * (see its own doc comment above), never synthesized char by char. */
  async function typeText(id: string, text: string, selector?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    if (selector) {
      const clicked = await clickSelector(id, selector);
      if (!clicked.ok) return clicked;
    }
    insertText(id, text);
    return { ok: true };
  }

  /** `selector` given: scrolls that element's own container (a nested
   * scrollable div, not necessarily the whole page) by resolving its
   * center point first, same mechanism as `clickSelector`. */
  async function scroll(
    id: string,
    dx: number,
    dy: number,
    selector?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    let x = 0;
    let y = 0;
    if (selector) {
      try {
        const raw: unknown = await entry.win.webContents.executeJavaScript(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })()
        `);
        if (!raw || typeof raw !== "object") return { ok: false, error: `no element matches selector "${selector}"` };
        ({ x, y } = raw as { x: number; y: number });
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    // Same sign inversion BrowserCard.tsx's onCanvasWheel already applies
    // before calling sendWheel — Electron's sendInputEvent mouseWheel
    // takes ticks in the opposite convention from a normal DOM
    // WheelEvent (confirmed live there: unnegated deltas scrolled
    // backwards). `dx`/`dy` here are the tool's own natural "positive
    // scrolls down/right" contract (what an MCP/acbridge caller expects
    // from a scroll tool); the Electron quirk stays encapsulated here
    // rather than leaking into the tool's contract.
    sendWheelEvent(id, { x, y, deltaX: -dx, deltaY: -dy });
    return { ok: true };
  }

  type QueryResult = {
    exists: boolean;
    text?: string;
    value?: string;
    href?: string;
    checked?: boolean;
    disabled?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  };

  /** Lets an agent inspect what's really on the page (existence, text,
   * form value, link target, checked/disabled state, real on-screen
   * rect) without depending on a screenshot — same `executeJavaScript`
   * primitive as `getPageText`, just scoped to one element. */
  async function query(id: string, selector: string): Promise<({ ok: true } & QueryResult) | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { exists: false };
          const r = el.getBoundingClientRect();
          return {
            exists: true,
            text: (el.innerText ?? el.textContent ?? "").slice(0, 2000),
            value: "value" in el ? String(el.value) : undefined,
            href: "href" in el ? String(el.href) : undefined,
            checked: "checked" in el ? Boolean(el.checked) : undefined,
            disabled: "disabled" in el ? Boolean(el.disabled) : undefined,
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        })()
      `);
      return { ok: true, ...(raw as QueryResult) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Achado ao vivo (2026-08-31) — `get_page_text`'s "no consent needed"
  // precedent (item 21 ponto 9 achado 5) covers READ-ONLY access; this
  // runs ARBITRARY agent-supplied JS in the page's real context, which
  // can read cookies/session/localStorage the same way a real DevTools
  // console could. Decisão explícita do usuário: expor mesmo assim, sem
  // gate humano — a `description` da tool MCP (mcp-server.ts) deixa esse
  // poder visível pro agente em vez de escondê-lo atrás de uma descrição
  // genérica.
  const MAX_EVAL_RESULT_CHARS = 20_000;
  async function evalJs(id: string, js: string): Promise<{ ok: true; result: string; truncated: boolean } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(js);
      let result: string;
      try {
        result = JSON.stringify(raw) ?? String(raw);
      } catch {
        result = String(raw);
      }
      const truncated = result.length > MAX_EVAL_RESULT_CHARS;
      return { ok: true, result: truncated ? result.slice(0, MAX_EVAL_RESULT_CHARS) : result, truncated };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  function destroy(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.win.destroy();
    entries.delete(id);
  }

  function destroyAll() {
    for (const id of [...entries.keys()]) destroy(id);
  }

  return {
    create,
    navigate,
    back,
    forward,
    reload,
    openDevTools,
    resize,
    getContentSize,
    setVisible,
    setFocused,
    sendMouseEvent,
    sendWheelEvent,
    sendKeyEvent,
    insertText,
    pasteText,
    copyText,
    cutText,
    testMakeEditable,
    getPageText,
    clickAtPoint,
    clickSelector,
    typeText,
    scroll,
    query,
    evalJs,
    destroy,
    destroyAll,
  };
}
