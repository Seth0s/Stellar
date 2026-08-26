import { WebContentsView, type BrowserWindow } from "electron";

export type BrowserRect = { x: number; y: number; w: number; h: number };

type Entry = { view: WebContentsView };

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

export function createBrowserRegistry(
  win: BrowserWindow,
  callbacks: {
    onNavigate: (id: string, url: string) => void;
    onTitle: (id: string, title: string) => void;
    onLoading: (id: string, loading: boolean) => void;
  },
) {
  const entries = new Map<string, Entry>();

  function create(id: string, url: string) {
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // Electron defaults an unset background to opaque black — never an
    // issue while GPU compositing worked, but since
    // app.disableHardwareAcceleration() (see main/index.ts) this view's own
    // paint can lag/fail on first composite on this machine's
    // software-rendering path, and the black default shows through instead
    // of the page. A prior fix here set this to `--surface` (#1a1d24), but
    // that's a dark near-black itself — a slow/failed paint still reads as
    // "broken", not "loading" (confirmed live: user still saw a solid black
    // card on spawn). White matches the browser convention for a blank
    // tab/page-still-loading and is visually distinct from an actually
    // broken render. (Not a constructor option on WebContentsView — set via
    // the View method instead.)
    view.setBackgroundColor("#ffffff");
    entries.set(id, { view });
    win.contentView.addChildView(view);

    // setBackgroundColor above only covers the compositor's paint-hold
    // color, shown before the page's own first paint — once a page actually
    // finishes loading, ITS background wins. `about:blank` (the default url
    // for a freshly created browser card — see App.tsx's addBrowserCard) is
    // a real page like any other here, and modern Chromium renders its own
    // internal blank-page background dark when the OS/user prefers dark
    // color scheme, regardless of setBackgroundColor. Confirmed live via
    // CDP: screenshotting the view's own target directly (not the outer
    // window, which never shows WebContentsView content) showed near-black,
    // not white, on a brand new card that had never navigated anywhere
    // else — this is what read as "the fix regressed" after a completely
    // unrelated change; it never actually depended on that change, every
    // still-on-about:blank card was always going to hit this. Force light
    // color-scheme on this webContents specifically (not
    // `nativeTheme.themeSource`, which would also flip the app's own
    // intentionally-dark UI) so a blank/never-navigated card reads as
    // "empty", not "broken".
    view.webContents.on("dom-ready", () => {
      void view.webContents.insertCSS("html{color-scheme:light;background:#fff;}");
    });

    view.webContents.on("did-navigate", (_e, navUrl) => callbacks.onNavigate(id, navUrl));
    view.webContents.on("did-navigate-in-page", (_e, navUrl) => callbacks.onNavigate(id, navUrl));
    view.webContents.on("page-title-updated", (_e, title) => callbacks.onTitle(id, title));
    view.webContents.on("did-start-loading", () => callbacks.onLoading(id, true));
    view.webContents.on("did-stop-loading", () => callbacks.onLoading(id, false));

    void view.webContents.loadURL(normalizeUrl(url));
  }

  function navigate(id: string, url: string) {
    void entries.get(id)?.view.webContents.loadURL(normalizeUrl(url));
  }

  function back(id: string) {
    const wc = entries.get(id)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  function forward(id: string) {
    const wc = entries.get(id)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  function reload(id: string) {
    entries.get(id)?.view.webContents.reload();
  }

  // animate defaults to false (no options passed) — an animated setBounds
  // would visibly lag behind the cursor during drag/pan/zoom, which every
  // other card kind never has to contend with (they ride the CSS transform
  // for free instead).
  function setBounds(id: string, rect: BrowserRect) {
    entries.get(id)?.view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.w),
      height: Math.round(rect.h),
    });
  }

  function setVisible(id: string, visible: boolean) {
    entries.get(id)?.view.setVisible(visible);
  }

  // Re-inserting an already-added child view reorders it to the topmost
  // position among the window's child views — only matters relative to
  // OTHER browser cards; it never rises above the base DOM content view.
  function raise(id: string) {
    const entry = entries.get(id);
    if (entry) win.contentView.addChildView(entry.view);
  }

  function destroy(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    win.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
    entries.delete(id);
  }

  function destroyAll() {
    for (const id of [...entries.keys()]) destroy(id);
  }

  return { create, navigate, back, forward, reload, setBounds, setVisible, raise, destroy, destroyAll };
}
