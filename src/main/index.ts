import { app, BrowserWindow, ipcMain } from "electron";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyRegistry } from "./pty-registry";
import { openStore, type CardRow, type ConnectorRow, type BoardRow } from "./store";
import type { SpawnOpts } from "./providers";
import { listDir, readFile, readImageDataUrl, writeFile } from "./fs-tools";
import { gitStatus } from "./git-tools";
import { createBrowserRegistry, type BrowserRect } from "./browser-registry";
import { createMessageBus } from "./message-bus";
import { runOneShotSummary } from "./ai-action";

const isDev = !app.isPackaged;

// This machine's GPU stack (Mesa GBM loader + ANGLE's GLESv2, on an NVIDIA
// system) segfaults the GPU process outright — confirmed via the kernel log
// (`segfault ... in libGLESv2.so`, always the same instruction pointer,
// repeating every GPU-process respawn attempt), not just a benign log
// warning. Forcing ozone to x11 only silenced one cosmetic Vulkan/Wayland
// warning and did nothing about the actual crash. The correct fix is to
// never launch a GPU process at all — Electron's own documented API for
// exactly this class of unstable-driver problem, not a workaround. The
// renderer still works fully: Chromium falls back to software compositing
// for its own UI, and `useTerminal.ts` has its own fallback to xterm's
// canvas2d renderer when the WebGL addon isn't available.
app.disableHardwareAcceleration();

// Separate from the crash above: even with hardware acceleration off,
// Chromium's GPU process still runs a capability-collection pass on startup
// that probes accelerated video decode/encode via VA-API
// (media/gpu/vaapi/vaapi_wrapper.cc). This machine has no VA-API driver (an
// NVIDIA+Mesa system exposes VDPAU/NVDEC, not VA-API) — the probe always
// fails with "vaInitialize failed: unknown libva error" and Chromium
// silently falls back to software video decode, so the log line is harmless
// but was never actually needed here. Disabling the two features outright
// stops Chromium from attempting the probe at all, instead of leaving a
// permanent failure in the log for a capability this app never uses (no
// video playback anywhere in agent-canvas).
app.commandLine.appendSwitch("disable-accelerated-video-decode");
app.commandLine.appendSwitch("disable-accelerated-video-encode");

// Electron only reads package.json's "name" (for app.getPath("userData")
// etc.) when launched as `electron .`/a directory — launched by pointing
// straight at the compiled entry file (out/main/index.js, what electron-vite
// dev and a plain `electron out/main/index.js` both do), it can't find that
// package.json and app.name silently defaults to "Electron", scattering
// state into ~/.config/Electron instead of ~/.config/agent-canvas. Pin it
// explicitly so userData is deterministic regardless of launch method.
app.setName("agent-canvas");

/**
 * A PTY/browser-view event can fire after the window has already been torn
 * down — killing a process (or destroying a view) on `win.on("closed")` is
 * not synchronous with the OS actually reaping it, so its exit/data event
 * can still arrive afterward. `win.webContents.send` on an already-destroyed
 * window throws "Object has been destroyed" (uncaught, since these fire from
 * event-emitter callbacks, not from an ipcMain handler) and crashes the
 * whole main process — confirmed live. Every send in this file goes through
 * this guard instead of calling `win.webContents.send` directly.
 */
function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]) {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

/**
 * `acbridge snapshot` — an agent asking to *see* a specific part of the
 * canvas (a card, an explicit world rect, or the whole window), not just
 * read text (see AGENTS.md/DESIGN-BACKLOG.md item 4). Two facts drive the
 * design:
 *
 * 1. `Page.captureScreenshot` via CDP on one target never shows what a
 *    DIFFERENT target renders — already confirmed the hard way earlier in
 *    this project verifying browser/terminal cards live. `capturePage()`
 *    is different: it's a `BrowserWindow.webContents` method, called from
 *    main, that composites the window exactly as the user sees it —
 *    including every `WebContentsView` on top, which is otherwise
 *    invisible to any DOM-only capture. That's the actual reason this
 *    works at all for a board with browser cards on it.
 * 2. `capturePage(rect)`'s rect is in window content-area pixels — the
 *    same screen space `board-model.ts`'s `worldRectToScreen` already
 *    computes for browser card bounds. Only the renderer has the live
 *    world transform (pan/zoom) needed for that conversion, so this asks
 *    it over IPC instead of duplicating that math here.
 */
function handleSnapshotRequest(
  win: BrowserWindow,
  messageBus: ReturnType<typeof createMessageBus>,
  requestId: string,
  target: { cardId: string } | { rect: { x: number; y: number; w: number; h: number } } | null,
) {
  if (win.isDestroyed()) {
    messageBus.resolveSnapshot(requestId, { ok: false, error: "window not available" });
    return;
  }

  function capture(rect?: Electron.Rectangle) {
    win.webContents
      .capturePage(rect)
      .then((image) => {
        const filePath = join(app.getPath("temp"), `agent-canvas-snapshot-${requestId}.png`);
        writeFileSync(filePath, image.toPNG());
        messageBus.resolveSnapshot(requestId, { ok: true, path: filePath });
      })
      .catch((err) => {
        messageBus.resolveSnapshot(requestId, { ok: false, error: String(err) });
      });
  }

  if (!target) {
    // Whole window — no renderer round-trip needed.
    capture();
    return;
  }
  // Narrowed to non-null here, but a nested function declaration doesn't
  // inherit that narrowing from TS's control-flow analysis — rebind so
  // onReply below sees the narrowed type too.
  const resolvedTarget = target;

  // Ask the renderer to resolve cardId/rect into screen pixels (it owns
  // the live world transform). One-shot listener, cleaned up on whichever
  // path fires first — the message-bus's own SNAPSHOT_TIMEOUT_MS is the
  // backstop if the renderer never replies at all (window unresponsive).
  let settled = false;
  function onReply(_e: Electron.IpcMainEvent, replyId: string, screenRect: Electron.Rectangle | null) {
    if (replyId !== requestId || settled) return;
    settled = true;
    ipcMain.removeListener("snapshot:rect-reply", onReply);
    if (!screenRect) {
      const desc = "cardId" in resolvedTarget ? `card "${resolvedTarget.cardId}"` : "that rect";
      messageBus.resolveSnapshot(requestId, { ok: false, error: `nothing visible for ${desc}` });
      return;
    }
    capture(screenRect);
  }
  ipcMain.on("snapshot:rect-reply", onReply);
  safeSend(win, "snapshot:rect-request", requestId, resolvedTarget);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    backgroundColor: "#0e1014",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts (electron-vite's default preload output) only
      // load when sandbox is disabled — the sandboxed preload loader only
      // understands CommonJS ("Cannot use import statement outside a module").
      sandbox: false,
    },
  });

  // Packaged: electron-builder's extraResources copies resources/bin next to
  // the app (outside app.asar, where a script can still be spawned as a real
  // OS process) at process.resourcesPath/bin. Dev: __dirname-relative, not
  // app.getAppPath() — the latter resolves to out/main (the entry script's
  // own dir) rather than the project root when launched by pointing straight
  // at that file, same root cause as the app.setName() call above.
  // __dirname is always where this compiled file actually sits on disk, so
  // it's stable across every dev launch method.
  const binDir = app.isPackaged
    ? join(process.resourcesPath, "bin")
    : join(__dirname, "..", "..", "resources", "bin");
  // git doesn't reliably preserve the executable bit across checkouts —
  // guarantee it here instead of trusting the working tree.
  try {
    chmodSync(join(binDir, "acbridge"), 0o755);
  } catch {
    // Missing in this checkout — acbridge calls will just fail with ENOENT.
  }
  const sockPath = join(app.getPath("userData"), "agent-canvas.sock");

  const store = openStore(app.getPath("userData"));

  const registry = createPtyRegistry({
    onData: (id, data) => safeSend(win, "pty:data", id, data),
    onExit: (id, exitCode) => safeSend(win, "pty:exit", id, exitCode),
    onSessionFound: (id, sessionId) => safeSend(win, "pty:session-found", id, sessionId),
    onUrlSeen: (id, url) => safeSend(win, "pty:url-seen", id, url),
    sockPath,
    binDir,
  });

  const browserRegistry = createBrowserRegistry(win, {
    onNavigate: (id, url) => safeSend(win, "browser:did-navigate", id, url),
    onTitle: (id, title) => safeSend(win, "browser:title", id, title),
    onLoading: (id, loading) => safeSend(win, "browser:loading", id, loading),
  });

  const messageBus = createMessageBus(sockPath, {
    listCards: () =>
      store
        .listAllCards()
        .filter((c) => c.kind === "terminal")
        .map((c) => ({ id: c.id, provider: c.provider, cwd: c.cwd })),
    writeToCard: (id, text) => registry.write(id, text),
    onOpenRequest: (requestId, requesterId, url) => safeSend(win, "browser:ask-open", requestId, requesterId, url),
    onSnapshotRequest: (requestId, target) => handleSnapshotRequest(win, messageBus, requestId, target),
  });

  ipcMain.handle(
    "pty:spawn",
    (_e, id: string, providerId: string, cwd: string, cols: number, rows: number, opts?: SpawnOpts) =>
      registry.spawn(id, providerId, cwd, cols, rows, opts),
  );
  ipcMain.handle("pty:write", (_e, id: string, data: string) => registry.write(id, data));
  ipcMain.handle("pty:resize", (_e, id: string, cols: number, rows: number) => registry.resize(id, cols, rows));
  ipcMain.handle("pty:interrupt", (_e, id: string) => registry.interrupt(id));
  ipcMain.handle("pty:kill", (_e, id: string) => registry.kill(id));

  ipcMain.handle("store:list", (_e, boardId: string) => store.listCards(boardId));
  ipcMain.handle("store:upsert", (_e, card: CardRow) => store.upsertCard(card));
  ipcMain.handle("store:delete", (_e, id: string) => store.deleteCard(id));

  ipcMain.handle("store:connectors:list", (_e, boardId: string) => store.listConnectors(boardId));
  ipcMain.handle("store:connectors:upsert", (_e, row: ConnectorRow) => store.upsertConnector(row));
  ipcMain.handle("store:connectors:delete", (_e, id: string) => store.deleteConnector(id));
  ipcMain.handle("store:connectors:delete-for-card", (_e, cardId: string) => store.deleteConnectorsForCard(cardId));

  ipcMain.handle("store:boards:list", () => store.listBoards());
  ipcMain.handle("store:boards:upsert", (_e, board: BoardRow) => store.upsertBoard(board));
  ipcMain.handle("store:boards:delete", (_e, id: string) => store.deleteBoard(id));
  ipcMain.handle("store:card-counts", () => store.cardCounts());
  ipcMain.handle("store:next-id-seed", () => store.nextIdSeed());

  ipcMain.handle("fs:list", (_e, root: string, path: string) => listDir(root, path));
  ipcMain.handle("fs:read", (_e, root: string, path: string) => readFile(root, path));
  ipcMain.handle("fs:write", (_e, root: string, path: string, content: string) => writeFile(root, path, content));
  ipcMain.handle("fs:read-image", (_e, root: string, path: string) => readImageDataUrl(root, path));
  ipcMain.handle("git:status", (_e, cwd: string) => gitStatus(cwd));

  ipcMain.handle("browser:create", (_e, id: string, url: string) => browserRegistry.create(id, url));
  ipcMain.handle("browser:navigate", (_e, id: string, url: string) => browserRegistry.navigate(id, url));
  ipcMain.handle("browser:back", (_e, id: string) => browserRegistry.back(id));
  ipcMain.handle("browser:forward", (_e, id: string) => browserRegistry.forward(id));
  ipcMain.handle("browser:reload", (_e, id: string) => browserRegistry.reload(id));
  ipcMain.handle("browser:set-bounds", (_e, id: string, rect: BrowserRect) => browserRegistry.setBounds(id, rect));
  ipcMain.handle("browser:set-visible", (_e, id: string, visible: boolean) => browserRegistry.setVisible(id, visible));
  ipcMain.handle("browser:raise", (_e, id: string) => browserRegistry.raise(id));
  ipcMain.handle("browser:destroy", (_e, id: string) => browserRegistry.destroy(id));
  ipcMain.handle("browser:ask-resolve", (_e, requestId: string, allowed: boolean) =>
    messageBus.resolveOpen(requestId, allowed),
  );

  ipcMain.handle("ai:summarize", (_e, providerId: string, cwd: string, prompt: string) =>
    runOneShotSummary(providerId, cwd, prompt),
  );

  ipcMain.handle("win:minimize", () => win.minimize());
  ipcMain.handle("win:toggle-maximize", () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.handle("win:close", () => win.close());
  ipcMain.handle("win:is-maximized", () => win.isMaximized());
  win.on("maximize", () => safeSend(win, "win:maximized-change", true));
  win.on("unmaximize", () => safeSend(win, "win:maximized-change", false));

  // Real OS fullscreen — distinct from the topbar's "ajustar à tela" zoom
  // button, which only reframes the canvas (pan/zoom), never touches the
  // window itself. See AGENTS.md for the confusion that motivated this.
  ipcMain.handle("win:toggle-fullscreen", () => win.setFullScreen(!win.isFullScreen()));
  ipcMain.handle("win:is-fullscreen", () => win.isFullScreen());
  win.on("enter-full-screen", () => safeSend(win, "win:fullscreen-change", true));
  win.on("leave-full-screen", () => safeSend(win, "win:fullscreen-change", false));

  win.on("closed", () => {
    browserRegistry.destroyAll();
    messageBus.close();
    registry.killAll();
    store.close();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
