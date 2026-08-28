import { BrowserWindow } from "electron";

export type BrowserMouseEvent = {
  type: "mouseDown" | "mouseUp" | "mouseMove";
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

type Entry = { win: BrowserWindow; visible: boolean };

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
}) {
  const entries = new Map<string, Entry>();

  function create(id: string, url: string) {
    const win = new BrowserWindow({
      show: false,
      width: 720,
      height: 560,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const wc = win.webContents;
    // Caps the max paint rate across every open browser card — Chromium
    // only actually emits `paint` on real change (scroll, animation, load),
    // so a mostly-static page costs nothing between those; this just bounds
    // the worst case (video, fast scrolling) instead of firing at whatever
    // the compositor would otherwise allow.
    wc.setFrameRate(30);

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

    entries.set(id, { win, visible: true });
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

  /** Resizes the offscreen viewport itself — the renderer calls this when
   * the card's own (world-space, pre-zoom) rect w/h changes, matching how
   * every other card kind sizes its content. */
  function resize(id: string, w: number, h: number) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.win.setContentSize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
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
    resize,
    setVisible,
    sendMouseEvent,
    sendWheelEvent,
    sendKeyEvent,
    insertText,
    pasteText,
    copyText,
    cutText,
    testMakeEditable,
    getPageText,
    destroy,
    destroyAll,
  };
}
