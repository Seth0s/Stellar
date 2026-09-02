import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, net, protocol, screen, session, shell } from "electron";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPtyRegistry } from "./pty-registry";
import { openStore, type CardRow, type ConnectorRow, type BoardRow } from "./store";
import type { SpawnOpts } from "./providers";
import {
  createEntry,
  deletePath,
  listDir,
  readFile,
  readImageDataUrl,
  renamePath,
  searchFileContents,
  searchFileNames,
  writeFile,
} from "./fs-tools";
import { gitStatus } from "./git-tools";
import { startWatching, stopWatching, stopAllWatchers } from "./file-watcher";
import { saveClipboardImage, saveImageBytes, readAttachmentImage, testWriteClipboardImage } from "./clipboard-image";
import { wrapJpegAsPdf } from "./pdf-export";
import { saveBoardAssetBytes, copyBoardAssetFromPath, resolveBoardAsset } from "./board-assets";
import {
  createBrowserRegistry,
  type BrowserMouseEvent,
  type BrowserWheelEvent,
  type BrowserKeyEvent,
} from "./browser-registry";
import { createMessageBus, type BusRequest, type StickyResult } from "./message-bus";
import { ensureMcpRegistered } from "./mcp-registration";
import { createMcpServer } from "./mcp-server";
import { runOneShotSummary } from "./ai-action";
import { createRemoteInputSession } from "./remote-input";
import { createRemoteServer } from "./remote-server";
import { registerUpdater } from "./updater";
import { createSecretsStore, type SecretProvider } from "./secrets";
import { createAnthropicClient } from "./anthropic-client";
import { createOpenAiClient } from "./openai-client";
import {
  executeTool,
  type ChatMessage,
  type WriteConsentRequest,
  type BashConsentRequest,
  type DelegateProvider,
} from "./chat-tools";

// DESIGN-BACKLOG.md item 37 — reported live: fullscreen video in an
// embedded browser card, then closing something, crashed the ENTIRE app.
// Investigated hard (3 separate live CDP repros: minimal fullscreen,
// real YouTube fullscreen entry with the video genuinely playing and
// `document.fullscreenElement` confirmed true, and closing the card
// mid-fullscreen) — none reproduced a crash in an isolated instance, so
// the exact trigger stays unconfirmed. But the underlying architectural
// gap this exposed is real regardless of the exact trigger: main.ts had
// ZERO `uncaughtException`/`unhandledRejection` handling anywhere before
// this — Electron's default for either is to crash the WHOLE app (not
// just the offending window/card), matching the reported "crash no app
// inteiro" symptom exactly for literally any bug anywhere in main, not
// just this one. Logged instead of crashing — a bug in one card's
// handling (browser, pty, chat, whatever) degrading that ONE card beats
// taking the entire board down, especially with real unsaved state
// (terminals, chat drafts) elsewhere on it.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] not crashing the app — see DESIGN-BACKLOG.md item 37:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] not crashing the app — see DESIGN-BACKLOG.md item 37:", reason);
});

// DESIGN-BACKLOG.md item 57.9 — protocolo customizado pra servir os
// assets persistentes de um card de mídia (`board-assets.ts`) direto pra
// `<img>`/pdf.js via fetch/streaming real, sem empurrar um base64 gigante
// pela IPC a cada render (importa pra PDFs grandes — o "visualizador
// robusto" pedido). `registerSchemesAsPrivileged` PRECISA rodar antes do
// evento 'ready' do app (exigência documentada do Electron) — por isso
// aqui, no nível de módulo, não dentro de `createWindow`. `standard:true`
// + `supportFetchAPI` deixam `fetch()`/`<img src>` tratarem
// `stellar-asset://` como uma origem normal (necessário pro
// `pdfjsLib.getDocument(url)` funcionar via streaming real de verdade).
protocol.registerSchemesAsPrivileged([
  { scheme: "stellar-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const isDev = !app.isPackaged;

// Pre-release audit B6 — `handleSnapshotRequest`/`onReadCardRequest`
// below each register a one-shot `ipcMain` reply listener while waiting
// for the renderer, removed once it actually replies. If the renderer
// never replies, message-bus.ts's own timeout still resolves the caller,
// but nothing removed the now-pointless listener — these two maps let
// that timeout (via `onSnapshotTimeout`/`onReadCardTimeout`) reach back
// and clean up the exact listener for that `requestId`.
const pendingSnapshotReplyCleanup = new Map<string, () => void>();
const pendingReadCardReplyCleanup = new Map<string, () => void>();
const pendingStickyReplyCleanup = new Map<string, () => void>();
/** O board aberto na tela agora — escrito só pelo renderer, via
 * `board:active` (ver o handler lá embaixo). `null` na Home, que é onde a
 * app sempre inicia. */
let activeBoardId: string | null = null;

// GPU acceleration re-enabled 2026-08-26 — see DESIGN-BACKLOG.md item 9 and
// AGENTS.md for the full investigation. It was disabled 2026-08-25 because
// this machine's GPU stack (Mesa GBM loader + ANGLE's GLESv2, on an NVIDIA
// system) segfaulted the GPU process outright (`segfault ... in
// libGLESv2.so`, confirmed via the kernel log, looping on every respawn).
// That was also the reason the browser card's WebContentsView never
// visually composited into the main window (item 9's real symptom) —
// software-only compositing of multiple views is comparatively fragile.
// Retested empirically before re-enabling, not assumed fixed: two isolated
// runs (boot, open a browser card, navigate to a real URL, 6s+ under load)
// on the CURRENT NVIDIA driver (610.57.04, newer than whatever was
// installed during the original crash) — zero segfaults, zero GPU-process
// crashes, `journalctl -k` clean both times. If a real GPU crash ever
// reproduces again on this or another machine, `disableHardwareAcceleration()`
// is the correct, documented Electron API for that class of problem — bring
// it back rather than reaching for something else, per the same reasoning
// that justified it the first time.
// app.disableHardwareAcceleration();

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

// 2026-08-26 — DESIGN-BACKLOG.md item 9: tried forcing the XWayland (X11)
// ozone backend here (`app.commandLine.appendSwitch("ozone-platform",
// "x11")`) as a workaround for the browser card's WebContentsView never
// compositing into the main window (the view demonstrably loads and paints
// real content internally — confirmed via CDP on its own target — only its
// background color ever reached the screen). REVERTED: tested live, the
// main window never appeared at all under x11 ozone on this machine — the
// process ran (renderer/gpu-process both up, confirmed via `ps`), XWayland
// itself was confirmed running, but no window ever mapped to the screen.
// Strictly worse than the original symptom. Do not retry this flag without
// first understanding why the window failed to map under x11 ozone
// specifically. Next candidate per item 9's option list: a separate
// top-level BrowserWindow per browser card instead of a child
// WebContentsView.

// Without this, Chromium's screen-capture stack on Linux falls back to its
// old X11-only enumeration path — confirmed the hard way earlier in this
// project (DESIGN-BACKLOG.md item 3): `desktopCapturer.getSources()`
// returned exactly one source with an empty name and a zero-width
// thumbnail on this Wayland/GNOME session, no per-window data at all. This
// flag routes capture through the xdg-desktop-portal ScreenCast interface
// instead, which is what actually knows how to enumerate/capture on
// Wayland (and is also what `getDisplayMedia()`'s system picker needs —
// see remote-input.ts and RemoteWindowCard.tsx). Unverified end-to-end:
// the picker dialog it triggers is native OS UI, so only a human clicking
// it can confirm this actually works.
app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");

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
 *    main, that composites the window exactly as the user sees it — every
 *    real DOM element in it, xterm's own text included.
 *    Historical note (2026-08-26→27, DESIGN-BACKLOG.md item 21 ponto 1):
 *    when the browser card was still a native `WebContentsView` child,
 *    `capturePage()` genuinely did NOT compose it — confirmed empirically,
 *    it came back as a flat `--surface` rectangle. Once `browser-
 *    registry.ts` was rewritten to offscreen rendering into a `<canvas>`
 *    (same-day, but after that finding), the browser card became plain
 *    DOM again like every other card kind, and this limitation quietly
 *    stopped applying — re-verified live 2026-08-27, no workaround was
 *    ever needed. `smoke-snapshot.mjs` guards against it regressing.
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
  function cleanup() {
    if (settled) return;
    settled = true;
    pendingSnapshotReplyCleanup.delete(requestId);
    ipcMain.removeListener("snapshot:rect-reply", onReply);
  }
  function onReply(_e: Electron.IpcMainEvent, replyId: string, screenRect: Electron.Rectangle | null) {
    if (replyId !== requestId || settled) return;
    cleanup();
    if (!screenRect) {
      const desc = "cardId" in resolvedTarget ? `card "${resolvedTarget.cardId}"` : "that rect";
      messageBus.resolveSnapshot(requestId, { ok: false, error: `nothing visible for ${desc}` });
      return;
    }
    capture(screenRect);
  }
  pendingSnapshotReplyCleanup.set(requestId, cleanup);
  ipcMain.on("snapshot:rect-reply", onReply);
  safeSend(win, "snapshot:rect-request", requestId, resolvedTarget);
}

/**
 * Pre-release audit S3 — the main window had no navigation guard at all.
 * `Markdown.tsx` renders agent/file-provided markdown with
 * `dangerouslySetInnerHTML`, so any `[x](https://…)` in a chat answer, a
 * sticky note or a previewed README was a one-click way to navigate the
 * ENTIRE app window off its own document: this window has `frame: false`
 * and no chrome, so there is no back button and no address bar — the app
 * is simply gone until it is killed and restarted.
 *
 * Both escape hatches are closed here: `will-navigate` (a plain link
 * click / `location.href =`) and `setWindowOpenHandler` (`window.open`,
 * `target="_blank"`, which would otherwise spawn an unmanaged native
 * BrowserWindow — the same hole `browser-registry.ts` already closes for
 * embedded browser cards, with the same reasoning). Neither fires for
 * `loadURL`/`loadFile` (Electron does not emit `will-navigate` for
 * programmatic navigation), but the dev renderer is allowed through by
 * origin anyway so a vite HMR full reload can never be mistaken for an
 * escape.
 */
function isAppUrl(target: string): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  // Dev: the vite dev server's own origin (ELECTRON_RENDERER_URL).
  const rendererUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (rendererUrl) {
    try {
      return u.origin === new URL(rendererUrl).origin;
    } catch {
      return false;
    }
  }
  // Packaged: `file:` has an opaque origin ("null"), so origin comparison
  // would wave through every local file. Compare the real path against the
  // one bundle entry this window is ever supposed to show instead.
  if (u.protocol !== "file:") return false;
  try {
    return resolve(fileURLToPath(u)) === resolve(join(__dirname, "../renderer/index.html"));
  } catch {
    return false;
  }
}

/** Only web/mail schemes get handed to the OS — `shell.openExternal` will
 * happily launch a registered handler for anything else, and the strings
 * reaching here come from rendered markdown, i.e. from agent output. */
function openExternally(target: string): void {
  if (/^(https?|mailto):/i.test(target)) void shell.openExternal(target);
}

function createWindow() {
  // Test-only (2026-09-02) — mesmo padrão de `!app.isPackaged` já usado
  // por `browser:test-make-editable`/`chat:test-simulate-tool`: sem isso,
  // não existia jeito de abrir a janela principal num monitor específico
  // pra verificar de verdade o fix de scaleFactor real do navegador
  // embutido (Item 6, DESIGN-BACKLOG.md) — a pendência ficou "sem
  // confirmação visual num monitor HiDPI real" porque não dava pra
  // posicionar a janela lá sem controle externo de janela (Wayland não
  // deixa ferramenta nenhuma mover janela de outro processo). Nunca
  // ativa fora de um `startApp` de diagnóstico que setar essa env var.
  const testBounds = !app.isPackaged && process.env.AGENT_CANVAS_TEST_WINDOW_BOUNDS
    ? (JSON.parse(process.env.AGENT_CANVAS_TEST_WINDOW_BOUNDS) as { x: number; y: number; width: number; height: number })
    : null;
  const win = new BrowserWindow({
    width: testBounds?.width ?? 1280,
    height: testBounds?.height ?? 800,
    ...(testBounds ? { x: testBounds.x, y: testBounds.y } : {}),
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

  // Audit S3 — see isAppUrl above.
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  // Pre-release audit B2 — a reload (F5/Ctrl+R, or `did-start-navigation`
  // more generally) discards every renderer-side listener that could
  // ever call `chat:write-resolve`/`chat:bash-resolve` for a request
  // already in flight — flush all of them (deny) rather than leave a
  // provider's tool loop wedged forever with nothing left that could
  // ever unblock it. `resolveConsentsForCard` is a hoisted function
  // declaration further down, so it's already callable here.
  win.webContents.on("did-start-navigation", (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) resolveConsentsForCard(null);
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
    chmodSync(join(binDir, "stellar-mcp"), 0o755);
  } catch {
    // Missing in this checkout — acbridge calls will just fail with ENOENT.
  }
  const sockPath = join(app.getPath("userData"), "agent-canvas.sock");
  // Same dev-vs-packaged resolution as binDir above, for the mobile
  // remote-control client's static files (DESIGN-BACKLOG.md item 2).
  const mobileClientDir = app.isPackaged
    ? join(process.resourcesPath, "mobile-client")
    : join(__dirname, "..", "..", "resources", "mobile-client");

  const store = openStore(app.getPath("userData"));
  const secretsStore = createSecretsStore(app.getPath("userData"));

  // DESIGN-BACKLOG.md item 12, Fase C — a write_file tool call blocks the
  // provider's own tool loop until the human decides, via the SAME
  // requestId-keyed pending-map shape message-bus.ts already established
  // for spawn_agent/spawn_card/open — just chat-specific (this loop lives
  // in anthropic-client.ts/openai-client.ts, not behind the acbridge
  // socket, so it doesn't go through message-bus.ts at all). No PER-
  // REQUEST timeout — a diff needing real review shouldn't auto-deny just
  // because the human stepped away; the tool loop simply stays paused
  // until they come back, same as any other open modal in this app.
  //
  // Pre-release audit B2 — that's still right for "the human is slow",
  // but the promise had NO exit at all for the two cases where nothing
  // could ever answer it again: the card asking got closed (its own
  // ChatCard/AgentAskModal-equivalent UI is gone, `chat:write-resolve`/
  // `chat:bash-resolve` will never fire for that requestId), or the whole
  // window reloaded (every renderer-side listener that could ever call
  // those IPC handlers is gone too). Both leak the pending Promise
  // forever, wedging that provider's tool loop permanently — `cardId` is
  // now stored alongside `resolve` so `resolveConsentsForCard`/the reload
  // handler below can find and deny the right ones without a timeout ever
  // punishing a human who's just taking their time.
  const pendingWriteConsents = new Map<string, { cardId: string; resolve: (allowed: boolean) => void }>();
  // DESIGN-BACKLOG.md item 12, Fase D — the `bash` tool's consent gate,
  // same requestId-keyed pending-map shape as `pendingWriteConsents`
  // above (deliberately a SEPARATE map, not a unified one — this
  // codebase's own established idiom for a new consent kind, see
  // message-bus.ts's pendingSnapshots/pendingPageTexts/pendingSpawnAgents/
  // pendingSpawnCards, four near-identical maps rather than one unified
  // one).
  const pendingBashConsents = new Map<string, { cardId: string; resolve: (allowed: boolean) => void }>();
  let nextChatRequestId = 1;
  function askWriteConsent(cardId: string, req: WriteConsentRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = String(nextChatRequestId++);
      pendingWriteConsents.set(requestId, { cardId, resolve });
      safeSend(win, "chat:ask-write", requestId, cardId, req);
    });
  }
  function askBashConsent(cardId: string, req: BashConsentRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = String(nextChatRequestId++);
      pendingBashConsents.set(requestId, { cardId, resolve });
      safeSend(win, "chat:ask-bash", requestId, cardId, req);
    });
  }
  // Pre-release audit B2 — called when a chat card actually closes
  // (`App.tsx`'s `finalizeCloseCard`, the one idempotent choke-point for
  // real removal) and on every main-frame navigation of `win` itself
  // (below) — the latter with no `cardId` filter, since a reload discards
  // every card's listeners at once.
  function resolveConsentsForCard(cardId: string | null) {
    for (const [requestId, entry] of pendingWriteConsents) {
      if (cardId !== null && entry.cardId !== cardId) continue;
      pendingWriteConsents.delete(requestId);
      entry.resolve(false);
    }
    for (const [requestId, entry] of pendingBashConsents) {
      if (cardId !== null && entry.cardId !== cardId) continue;
      pendingBashConsents.delete(requestId);
      entry.resolve(false);
    }
  }
  // Reuses the EXISTING spawn_agent consent+spawn flow end to end
  // (message-bus.ts's `handleRequest`, the same dispatcher acbridge and
  // the MCP server already call) rather than building a second one — the
  // human sees the exact same AgentAskModal a real `spawn_agent` MCP call
  // already produces. No `depth` to pass here (pre-release audit S4
  // removed the caller-supplied field) — `cardId` isn't itself a spawned
  // PTY process, so it has no server-tracked depth of its own, and
  // `handleRequest` treats that as a fresh top-level chain (depth 0),
  // same as any human-initiated spawn from the rail/radial menu.
  // `messageBus` is assigned further down (forward reference, same
  // pattern `mcpServer.handleRequest` below already relies on) — safe
  // because this closure only runs once a real tool call happens, long
  // after setup finishes.
  function delegateToAgent(cardId: string, cwd: string, provider: DelegateProvider, reason: string) {
    return messageBus!.handleRequest({
      cmd: "spawn_agent",
      provider,
      cwd,
      requesterId: cardId,
      reason,
    }) as Promise<{ ok: true; cardId: string } | { ok: false; error: string }>;
  }

  const chatToolCallbacks = {
    onToolStart: (cardId: string, name: string, input: unknown) => safeSend(win, "chat:tool-start", cardId, name, input),
    onToolResult: (cardId: string, name: string, ok: boolean, summary: string) =>
      safeSend(win, "chat:tool-result", cardId, name, ok, summary),
    askWriteConsent,
    askBashConsent,
    delegateToAgent,
  };
  // DESIGN-BACKLOG.md item 28 — Google's own OpenAI-compatible endpoint
  // (announced/stable since 2025), not a Stellar invention. Lets "gemini"
  // reuse openai-client.ts wholesale instead of a third bespoke SDK/loop.
  const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

  const anthropicClient = createAnthropicClient({
    onToken: (cardId, delta) => safeSend(win, "chat:token", cardId, delta),
    onDone: (cardId, fullText, usage) => safeSend(win, "chat:done", cardId, fullText, usage),
    onError: (cardId, message) => safeSend(win, "chat:error", cardId, message),
    ...chatToolCallbacks,
  });
  const openaiClient = createOpenAiClient({
    onToken: (cardId, delta) => safeSend(win, "chat:token", cardId, delta),
    onDone: (cardId, fullText, usage) => safeSend(win, "chat:done", cardId, fullText, usage),
    onError: (cardId, message) => safeSend(win, "chat:error", cardId, message),
    ...chatToolCallbacks,
  });

  // Assigned right after `registry` below — declared here (not `const`
  // there) only so `registry`'s onData/onExit closures can reference it.
  // Those closures run later, at PTY event time, never during this
  // synchronous setup, so the forward reference is safe despite the
  // circular-looking dependency (remoteServer.listTerminals also needs
  // `registry.isAlive`, the actual reason these two can't be one-line
  // `const`s in either order).
  let remoteServer: ReturnType<typeof createRemoteServer> | null = null;

  // Same forward-reference trick as `remoteServer` above, one level
  // deeper: `mcpServer`'s tool handlers need `messageBus.handleRequest`
  // (DESIGN-BACKLOG.md item 21, ponto 9 — one shared dispatcher, two
  // frontends), but `messageBus`'s own callbacks need `registry`/
  // `browserRegistry`, which in turn need `mcpServer.url` (to inject into
  // every spawned provider's env — see providers.ts). None of these
  // closures actually run until real events fire, well after this whole
  // function returns, so the forward reference is safe.
  let messageBus: ReturnType<typeof createMessageBus> | null = null;
  const mcpServer = createMcpServer({
    // Default 0 lets the OS assign a free ephemeral port — the URL is only
    // ever read in-process (registry's `mcpUrl` getter below), never
    // persisted or exposed externally, so there's nothing a fixed port
    // buys a real launch and it only invites EADDRINUSE when two instances
    // run at once. AGENT_CANVAS_MCP_PORT stays for the verify harness's
    // isolated test instances, which DO need a predictable port to dial
    // directly from outside the process (see smoke-mcp.mjs).
    port: Number(process.env.AGENT_CANVAS_MCP_PORT) || 0,
    handleRequest: (req: BusRequest) => messageBus!.handleRequest(req),
  });

  const registry = createPtyRegistry({
    onData: (id, data) => {
      safeSend(win, "pty:data", id, data);
      remoteServer?.broadcastPtyData(id, data);
    },
    onExit: (id, exitCode) => {
      safeSend(win, "pty:exit", id, exitCode);
      remoteServer?.broadcastPtyExit(id, exitCode);
      remoteServer?.broadcastCards();
      // DESIGN-BACKLOG.md item 58, M4 — resolves any spawn_agent(wait:true)
      // MCP call still holding open on this card. No-op when nothing's
      // waiting on it.
      messageBus?.resolveCardExit(id, exitCode);
    },
    onSessionFound: (id, sessionId) => safeSend(win, "pty:session-found", id, sessionId),
    onUrlSeen: (id, url) => safeSend(win, "pty:url-seen", id, url),
    sockPath,
    binDir,
    // Read live (not `mcpServer.url` copied once) — with `port: 0` above,
    // the real port is only known after the async `listening` event, which
    // fires well before any provider actually spawns and reads this.
    get mcpUrl() {
      return mcpServer.url;
    },
  });

  remoteServer = createRemoteServer({
    // Overridable only so the verify harness (scripts/verify/) can point
    // throwaway test instances at a different port — every real launch
    // (dev or packaged) still uses 4488. Fixed port + no override used to
    // mean any isolated test instance launched while a real instance (the
    // user's own `npm run dev`, or another leftover test run) was up
    // collided on EADDRINUSE, which threw uncaught in main and crashed
    // that instance — confirmed live, see AGENTS.md.
    port: Number(process.env.AGENT_CANVAS_REMOTE_PORT) || 4488,
    mobileClientDir,
    userDataDir: app.getPath("userData"),
    listTerminals: () =>
      store
        .listAllCards()
        .filter((c) => c.kind === "terminal" && registry.isAlive(c.id))
        .map((c) => ({ id: c.id, label: c.label, provider: c.provider, cwd: c.cwd })),
    onWrite: (id, data) => registry.write(id, data),
    onResize: (id, cols, rows) => registry.resize(id, cols, rows),
  });

  // Pre-release audit S2 — neither of Electron's two permission gates
  // (`setPermissionRequestHandler`, the async prompt path; `setPermission-
  // CheckHandler`, the synchronous one `navigator.permissions.query` and
  // similar immediate checks use) had ever been set for this session —
  // every page a BrowserCard navigates to fell through to Electron's
  // default, which is to auto-grant. `BENIGN_PERMISSIONS` auto-allows
  // pure UI capability with no privacy/data-access implications —
  // blanket-denying `fullscreen`/`pointerLock` would visibly break
  // ordinary video/game browsing over something that was never the
  // actual concern. Everything else not explicitly handled below is
  // denied outright ("negando por padrão", the audit's own words).
  //
  // Achado ao vivo, corrigindo a premissa original: `display-capture`
  // does NOT appear as its own permission name in this Electron version
  // (42) — confirmed by logging the real value live — `getDisplayMedia()`
  // arrives at `setPermissionRequestHandler` as a plain `"media"`
  // permission, IDENTICAL to a `getUserMedia()` (camera/mic) request;
  // `details.mediaTypes` is `['video']` for both too, so there's no field
  // that tells them apart at this layer either. A screen-share request
  // that's denied HERE never even reaches `setDisplayMediaRequestHandler`
  // below (confirmed live: a bare `callback(false)` for `"media"` — the
  // original design here — left the modal never shown at all and the
  // page's own promise rejecting immediately). So `"media"` gets its own
  // human confirmation right here, generic enough to cover either case
  // ("quer acessar câmera/microfone, ou compartilhar sua tela") — a real
  // getDisplayMedia call still gets asked a SECOND, more specific time by
  // `setDisplayMediaRequestHandler`'s own gate right after (which source,
  // not just "media, yes/no") — two-factor for the more sensitive of the
  // two capabilities, not a redundancy bug.
  const BENIGN_PERMISSIONS = new Set(["fullscreen", "pointerLock"]);
  const PROMPT_PERMISSIONS = new Set(["media"]);
  // Real regression found live running the full smoke suite after this
  // handler first shipped: `session.defaultSession` covers EVERY
  // webContents in the process, including this app's own main window
  // (`win` below) — not just a BrowserCard's navigated page. Denying
  // everything outside `BENIGN_PERMISSIONS`/`PROMPT_PERMISSIONS` by
  // default silently broke this app's OWN first-party clipboard
  // features (the terminal footer's "copiar link", paste). Confirmed
  // live (logging the real denied value) that `writeText`/`readText`
  // arrive here as `clipboard-sanitized-write`/`clipboard-read` — every
  // Electron permission name, same discovery method already used above
  // for `display-capture`/`"media"`. Scoped to `win.webContents` only
  // (checked below, not added to `BENIGN_PERMISSIONS` outright): a
  // BrowserCard's page is a DIFFERENT webContents (browser-registry.ts's
  // own offscreen `BrowserWindow`, same default session, no partition),
  // so an arbitrary site loaded there still can't silently read or
  // overwrite the user's OS clipboard — a real hijack vector this
  // handler's whole point was to close off, not reopen broadly.
  // "notifications" (2026-09-02, "Terminal, Revisitado" — bell button per
  // terminal card, fires when a turn goes idle) added the same way
  // clipboard was above: this is the app's OWN first-party window asking
  // for its own OS-notification capability, not an arbitrary page loaded
  // inside a BrowserCard. Confirmed live before this change: with
  // "notifications" absent from every set above, `setPermissionRequestHandler`
  // fell through to the final `callback(false)` — `new Notification(...)`
  // in the renderer would have silently never shown anything, not an
  // error, just a feature that looked wired up but never fired.
  const MAIN_WINDOW_ONLY_PERMISSIONS = new Set(["clipboard-sanitized-write", "clipboard-read", "notifications"]);

  // Shared "ask the renderer, wait for a human decision" primitive — used
  // both for the generic media-permission prompt right below and for
  // `setDisplayMediaRequestHandler`'s own, more specific source-selection
  // prompt further down. Not the agent-facing `AgentAskModal`/`pendingAsk`
  // machinery in message-bus.ts on purpose: this is a WEBPAGE inside a
  // BrowserCard asking, not one of this app's own agent cards, so that
  // modal's "an agent is asking" framing would be wrong here.
  const pendingBrowserPermissionAsks = new Map<string, (allowed: boolean) => void>();
  ipcMain.on("browser:resolve-permission-ask", (_e, requestId: string, allowed: boolean) => {
    pendingBrowserPermissionAsks.get(requestId)?.(allowed);
    pendingBrowserPermissionAsks.delete(requestId);
  });
  const BROWSER_PERMISSION_ASK_TIMEOUT_MS = 30_000;
  function askHumanForBrowserPermission(message: string): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingBrowserPermissionAsks.delete(requestId);
        resolve(false);
      }, BROWSER_PERMISSION_ASK_TIMEOUT_MS);
      pendingBrowserPermissionAsks.set(requestId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      safeSend(win, "browser:ask-permission", requestId, message);
    });
  }

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (MAIN_WINDOW_ONLY_PERMISSIONS.has(permission) && webContents.id === win.webContents.id) {
      callback(true);
      return;
    }
    if (BENIGN_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    if (!PROMPT_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }
    askHumanForBrowserPermission(
      "Uma página aberta num card de navegador quer acessar câmera/microfone, ou compartilhar sua tela. Permitir?",
    ).then(callback);
  });
  // Synchronous by API contract (`navigator.permissions.query` and
  // similar immediate checks) — can't defer to a human here, so this only
  // ever reports the benign allowlist as granted; the real prompt for
  // anything else happens in `setPermissionRequestHandler` above, when a
  // page actually calls the API itself (not just checks its own state).
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (MAIN_WINDOW_ONLY_PERMISSIONS.has(permission) && webContents?.id === win.webContents.id) return true;
    return BENIGN_PERMISSIONS.has(permission);
  });

  // Pre-release audit S2 — used to call back with `sources[0]` (the whole
  // screen) unconditionally, no human ever asked. Now shows its own,
  // more specific confirmation, naming the page's own URL, reusing
  // `askHumanForBrowserPermission` above. Only on an explicit "Permitir"
  // does `desktopCapturer.getSources()` even run — on Wayland with
  // WebRTCPipeWireCapturer enabled, THAT call is what triggers the native
  // xdg-desktop-portal picker dialog for the actual source; there's
  // deliberately no in-app source list (DESIGN-BACKLOG.md item 3 — this
  // app can't enumerate real window names/thumbnails on Wayland, only the
  // portal's own dialog can), so a human effectively gets THREE layered
  // confirmations for screen-share on that platform: the generic media
  // prompt above, this specific one, and the OS's own portal dialog.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sourceUrl = request.frame?.url || "página desconhecida";
    const allowed = await askHumanForBrowserPermission(`A página "${sourceUrl}" quer capturar sua tela. Permitir?`);
    if (!allowed) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => callback(sources.length > 0 ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  });

  // App-level singleton — the RemoteDesktop portal's grant is "let this
  // app inject input", not "let this app control window X", so one session
  // shared by every RemoteWindowCard is correct and avoids a consent
  // dialog per card. See remote-input.ts.
  const remoteInput = createRemoteInputSession();
  ipcMain.handle("remote-input:ensure", () => remoteInput.ensureStarted());
  ipcMain.handle("remote-input:move", (_e, dx: number, dy: number) => remoteInput.moveRelative(dx, dy));
  ipcMain.handle("remote-input:button", (_e, button: number, pressed: boolean) =>
    remoteInput.button(button, pressed),
  );
  ipcMain.handle("remote-input:scroll", (_e, dx: number, dy: number) => remoteInput.scroll(dx, dy));
  ipcMain.handle("remote-input:keysym", (_e, keysym: number, pressed: boolean) =>
    remoteInput.keysym(keysym, pressed),
  );

  const browserRegistry = createBrowserRegistry({
    onNavigate: (id, url) => safeSend(win, "browser:did-navigate", id, url),
    onTitle: (id, title) => safeSend(win, "browser:title", id, title),
    onLoading: (id, loading) => safeSend(win, "browser:loading", id, loading),
    onFrame: (id, jpeg, width, height) => safeSend(win, "browser:frame", id, jpeg, width, height),
    onConsoleMessage: (id, level, message) => safeSend(win, "browser:console-message", id, level, message),
    // Achado ao vivo ("navegador parece 360p") — o display onde a janela
    // REAL do app está, não `getPrimaryDisplay()`, é correto mesmo num
    // setup multi-monitor com DPIs diferentes (a janela pode não estar no
    // display primário).
    getScaleFactor: () => screen.getDisplayMatching(win.getBounds()).scaleFactor,
  });

  // Achado ao vivo (2026-09-02, pedido explícito: "não apenas monitor
  // 4K") — `getScaleFactor` acima é dinâmico (consulta o display real na
  // hora), mas só era CHAMADO uma vez, em `browser:create` — arrastar a
  // janela do app pra um monitor com scaleFactor diferente nunca
  // reavaliava nada depois disso; todo browser card continuava
  // rasterizando na densidade do monitor onde foi criado. `"moved"` (a
  // janela terminou de se mover — evento discreto, não o `"move"`
  // contínuo que dispara a cada pixel de arraste) cobre trocar de
  // monitor; `screen.on("display-metrics-changed")` cobre o SO mudando a
  // escala de um monitor com a janela parada nele (ex: usuário mexe nas
  // configurações de display). `refreshScaleFactor` só retorna não-null
  // quando o valor de fato mudou, então isto não dispara nenhum
  // resize/IPC à toa em todo micro-movimento de janela dentro do mesmo
  // monitor.
  function recheckBrowserScaleFactors() {
    for (const id of browserRegistry.liveIds()) {
      const next = browserRegistry.refreshScaleFactor(id);
      if (next !== null) safeSend(win, "browser:scale-factor-changed", id, next);
    }
  }
  win.on("moved", recheckBrowserScaleFactors);
  screen.on("display-metrics-changed", recheckBrowserScaleFactors);

  messageBus = createMessageBus(sockPath, {
    // Achado ao vivo (2026-09-01): o `.filter(kind === "terminal")` que
    // ficava aqui é o que fazia um agente responder "list_cards doesn't
    // surface browser cards — I need the card ID". Todo card vivo aparece
    // agora; quem precisa mesmo de um PTY filtra do lado do bus
    // (`listTerminalCards`, message-bus.ts), que é onde a restrição de
    // fato existe. `label` vai junto pra `resolveTargetId` poder aceitar o
    // nome que o humano deu ao card como alvo.
    listCards: () =>
      store
        .listAllCards()
        // Escopado na sessão aberta (achado ao vivo 2026-09-01): trocar de
        // board encerra os PTYs e desmonta os cards do anterior, mas eles
        // continuavam saindo aqui — `store.listAllCards()` nunca foi
        // escopado. O sintoma era um `card_status` de um card de outra
        // sessão respondendo "exited" em vez de "não existe", que lê como
        // "a sessão antiga continua lá". Nada nesta lista é operável fora
        // do board ativo: `read_card`/`write_sticky`/`snapshot` dependem do
        // renderer ter o card montado, e o PTY já foi morto. Na Home
        // (`activeBoardId === null`) a lista é legitimamente vazia.
        .filter((c) => c.board_id === activeBoardId)
        .map((c) => {
        const base = { id: c.id, kind: c.kind, label: c.label };
        // Só terminal/chat usam `provider` com o significado do nome, e só
        // terminal/chat/files/changes usam `cwd` como caminho de verdade.
        // Todo o resto reaproveita as duas colunas sem migração (App.tsx's
        // `toRow`: sticky guarda cor + o TEXTO da nota, stroke guarda cor +
        // os pontos, media guarda o tipo + um JSON, browser guarda
        // ownerCardId + a URL). Despejar isso cru num campo chamado "cwd"
        // seria contrato mentiroso agora que a lista não é mais só de
        // terminais — cada kind expõe só o que de fato significa aquilo.
        switch (c.kind) {
          case "terminal":
          case "chat":
            return { ...base, provider: c.provider, cwd: c.cwd };
          case "files":
          case "changes":
            return { ...base, provider: "", cwd: c.cwd };
          case "browser":
            return { ...base, provider: "", cwd: "", url: c.cwd };
          default:
            return { ...base, provider: "", cwd: "" };
        }
      }),
    writeToCard: (id, text) => registry.write(id, text),
    isCardAlive: (id) => registry.isAlive(id),
    // DESIGN-BACKLOG.md item 61 — same "Bash 2°" convention as App.tsx's
    // `describeCard` (AgentAskModal's requester label), reimplemented
    // against store.ts directly since this is main-process code.
    describeCardLabel: (cardId) => {
      const card = store.getCard(cardId);
      if (!card) return `card #${cardId}`;
      if (card.label) return card.label;
      const sameProvider = store
        .listCards(card.board_id)
        .filter((c) => c.kind === "terminal" && c.provider === card.provider)
        .sort((a, b) => Number(a.id) - Number(b.id));
      const ordinal = sameProvider.findIndex((c) => c.id === cardId) + 1;
      const name = card.provider.charAt(0).toUpperCase() + card.provider.slice(1);
      return `${name} ${ordinal}°`;
    },
    getCardBoardId: (id) => store.getCard(id)?.board_id,
    isBoardAutonomous: (boardId) => store.getBoard(boardId)?.autonomous ?? false,
    getBoardConcurrencyCap: (boardId) => store.getBoard(boardId)?.concurrency_cap ?? null,
    countRunningAgentsOnBoard: (boardId) =>
      store
        .listCards(boardId)
        .filter((c) => c.kind === "terminal" && c.provider !== "bash" && registry.isAlive(c.id)).length,
    listTasks: () => store.listTasks(),
    getTask: (id) => store.getTask(id),
    upsertTask: (task) => store.upsertTask(task),
    listAllConnectors: () => store.listAllConnectors(),
    setConnectorKind: (id, kind) => store.setConnectorKind(id, kind),
    onOpenRequest: (requestId, requesterId, url, reason, autoApprove) =>
      safeSend(win, "browser:ask-open", requestId, requesterId, url, reason, autoApprove),
    // Achado ao vivo (2026-09-01): "eu gostaria que o snapshot fosse
    // cirúrgico e fizesse apenas do card e nada mais". Para um card de
    // NAVEGADOR isso é possível de forma exata, e por um caminho totalmente
    // diferente: ele tem uma BrowserWindow offscreen própria, então dá pra
    // fotografar a superfície dele diretamente, sem board nenhum no meio.
    // O caminho antigo (`handleSnapshotRequest`, abaixo) fotografa a JANELA
    // DO APP recortada onde o card está — daí pegar o fundo do canvas nos
    // cantos arredondados, pegar card sobreposto, sair na resolução
    // "tamanho na tela × zoom" e truncar o que estiver fora da área
    // visível, que é exatamente o que foi relatado. Todo outro tipo de
    // card continua pelo caminho antigo: eles só existem como pixels
    // dentro da janela, não há superfície separada pra capturar.
    onSnapshotRequest: (requestId, target) => {
      if (target && "cardId" in target && store.getCard(target.cardId)?.kind === "browser") {
        void browserRegistry.capturePage(target.cardId).then((result) => {
          if (!result.ok) {
            messageBus!.resolveSnapshot(requestId, result);
            return;
          }
          const filePath = join(app.getPath("temp"), `agent-canvas-snapshot-${requestId}.png`);
          writeFileSync(filePath, result.png);
          messageBus!.resolveSnapshot(requestId, { ok: true, path: filePath });
        });
        return;
      }
      handleSnapshotRequest(win, messageBus!, requestId, target);
    },
    // DESIGN-BACKLOG.md item 21, ponto 9, achado 5 — no consent needed
    // (see message-bus.ts's PAGE_TEXT_TIMEOUT_MS comment), so this goes
    // straight to browserRegistry instead of round-tripping through a
    // renderer ask/resolve pair like the two below.
    onPageTextRequest: (requestId, cardId) => {
      void browserRegistry.getPageText(cardId).then((result) => messageBus!.resolvePageText(requestId, result));
    },
    // DESIGN-BACKLOG.md §2.1 — same "no round trip needed" reasoning as
    // onPageTextRequest above: browserRegistry already owns the real
    // webContents, so these resolve straight from here.
    // `ref` (do `browser_snapshot`) vira seletor AQUI, ao lado do registry
    // que carimba o atributo — nem o bus nem o servidor MCP precisam saber
    // o nome dele. Tem precedência sobre `selector`: quem passou um ref
    // acabou de olhar o snapshot e sabe exatamente o que quer.
    browserClick: (cardId, x, y, selector, ref) => {
      const sel = ref ? browserRegistry.refSelector(ref) : selector;
      return sel ? browserRegistry.clickSelector(cardId, sel) : Promise.resolve(browserRegistry.clickAtPoint(cardId, x!, y!));
    },
    browserType: (cardId, text, selector, ref) =>
      browserRegistry.typeText(cardId, text, ref ? browserRegistry.refSelector(ref) : selector),
    browserScroll: (cardId, dx, dy, selector, ref) =>
      browserRegistry.scroll(cardId, dx, dy, ref ? browserRegistry.refSelector(ref) : selector),
    browserQuery: (cardId, selector, ref) => browserRegistry.query(cardId, ref ? browserRegistry.refSelector(ref) : selector!),
    browserEval: (cardId, js) => browserRegistry.evalJs(cardId, js),
    browserSnapshot: (cardId) => browserRegistry.pageSnapshot(cardId),
    browserConsole: (cardId, level, limit) => browserRegistry.getConsole(cardId, level, limit),
    browserNetwork: (cardId, opts) => browserRegistry.getNetwork(cardId, opts),
    browserWaitFor: (cardId, opts) => browserRegistry.waitFor(cardId, opts),
    // DESIGN-BACKLOG.md item 58, M1 — same request/reply shape as
    // snapshot:rect-request/-reply below: only the renderer holds the
    // live xterm.js buffer for a terminal card, main can't read it
    // directly.
    onReadCardRequest: (requestId, cardId, lines) => {
      let settled = false;
      function cleanup() {
        if (settled) return;
        settled = true;
        pendingReadCardReplyCleanup.delete(requestId);
        ipcMain.removeListener("readcard:reply", onReply);
      }
      function onReply(_e: Electron.IpcMainEvent, replyId: string, text: string | null) {
        if (replyId !== requestId || settled) return;
        cleanup();
        messageBus!.resolveReadCard(requestId, text === null ? { ok: false, error: `no open terminal card with id "${cardId}"` } : { ok: true, text });
      }
      pendingReadCardReplyCleanup.set(requestId, cleanup);
      ipcMain.on("readcard:reply", onReply);
      safeSend(win, "readcard:request", requestId, cardId, lines);
    },
    // Pre-release audit B6 — see the two `pendingXReplyCleanup` maps'
    // doc comment near the top of this file.
    onSnapshotTimeout: (requestId) => pendingSnapshotReplyCleanup.get(requestId)?.(),
    onReadCardTimeout: (requestId) => pendingReadCardReplyCleanup.get(requestId)?.(),
    // Achado ao vivo (2026-09-01) — read_sticky/write_sticky. Mesma forma
    // do onReadCardRequest acima e pelo mesmo motivo: o `<textarea>` no
    // renderer é a fonte da verdade enquanto o card está montado.
    onStickyRequest: (requestId, cardId, op) => {
      let settled = false;
      function cleanup() {
        if (settled) return;
        settled = true;
        pendingStickyReplyCleanup.delete(requestId);
        ipcMain.removeListener("sticky:reply", onReply);
      }
      function onReply(_e: Electron.IpcMainEvent, replyId: string, result: StickyResult) {
        if (replyId !== requestId || settled) return;
        cleanup();
        messageBus!.resolveSticky(requestId, result);
      }
      pendingStickyReplyCleanup.set(requestId, cleanup);
      ipcMain.on("sticky:reply", onReply);
      safeSend(win, "sticky:request", requestId, cardId, op);
    },
    onStickyTimeout: (requestId) => pendingStickyReplyCleanup.get(requestId)?.(),
    // DESIGN-BACKLOG.md item 21, ponto 9, achados 1 e 2 — same
    // ask-the-renderer/wait-for-a-human-decision shape as onOpenRequest
    // above, generalized. The renderer owns all card creation (it's the
    // only place with the live board/cardsRef state), so these just
    // relay the request and wait for `spawn:agent-resolve`/`spawn:card-
    // resolve` (below) to call back into the matching resolve*() here.
    onSpawnAgentRequest: (requestId, requesterId, params) =>
      safeSend(win, "spawn:ask-agent", requestId, requesterId, params),
    onSpawnCardRequest: (requestId, requesterId, params) =>
      safeSend(win, "spawn:ask-card", requestId, requesterId, params),
    // DESIGN-BACKLOG.md item 60, peça 1 — live push so a queue panel never
    // has to poll; same safeSend guard as every other main→renderer event.
    onQueueChanged: (boardId, queue) => safeSend(win, "spawn-queue:changed", boardId, queue),
    // Regra geral de auto-conector (2026-09-02) — ver message-bus.ts's
    // doc comment na interface de callbacks.
    onAutoConnect: (fromCardId, toCardId, kind) => safeSend(win, "connector:auto", fromCardId, toCardId, kind),
  });
  ipcMain.handle("browser:get-page-text", (_e, id: string) => browserRegistry.getPageText(id));
  ipcMain.handle("spawn:agent-resolve", (_e, requestId: string, result: { ok: true; cardId: string } | { ok: false; error: string }) =>
    messageBus!.resolveSpawnAgent(requestId, result),
  );
  ipcMain.handle("spawn:card-resolve", (_e, requestId: string, result: { ok: true; cardId: string } | { ok: false; error: string }) =>
    messageBus!.resolveSpawnCard(requestId, result),
  );

  ipcMain.handle(
    "pty:spawn",
    async (_e, id: string, providerId: string, cwd: string, cols: number, rows: number, opts?: SpawnOpts) => {
      // Precisa acontecer ANTES do spawn: `cursor`/`antigravity` leem o
      // registro de MCP do disco na subida, então registrar depois só
      // valeria a partir do próximo card. É no-op imediato pros outros
      // providers e roda uma vez por execução da app (ver o módulo).
      const registration = await ensureMcpRegistered(providerId, binDir);
      if (registration.status === "failed") {
        // Nunca bloqueia o spawn — sem MCP o card ainda tem o `acbridge`,
        // que é exatamente o que ele tinha antes disto existir.
        console.error(`mcp-registration (${providerId}): ${registration.error}`);
      }
      const result = registry.spawn(id, providerId, cwd, cols, rows, opts);
      if ("id" in result) remoteServer?.broadcastCards();
      return result;
    },
  );
  ipcMain.handle("pty:write", (_e, id: string, data: string) => registry.write(id, data));
  ipcMain.handle("pty:resize", (_e, id: string, cols: number, rows: number) => registry.resize(id, cols, rows));
  ipcMain.handle("pty:interrupt", (_e, id: string) => registry.interrupt(id));
  ipcMain.handle("pty:kill", (_e, id: string) => {
    registry.kill(id);
    remoteServer?.broadcastCards();
  });
  // "não consigo mandar foto pelo terminal" (2026-08-27) — ver
  // clipboard-image.ts pro raciocínio completo. Não é `pty:*` de
  // propósito (não fala com nenhum PTY específico, só lê o clipboard do
  // SO), mas fica perto por ser acionado a partir do mesmo lugar
  // (useTerminal.ts's paste handler).
  ipcMain.handle("clipboard:save-pasted-image", () => saveClipboardImage());
  // Test-only trigger (verify harness) — inerte em build empacotado,
  // mesmo guard/precedente de `chat:test-simulate-tool`.
  ipcMain.handle("clipboard:test-write-image", () => {
    if (app.isPackaged) return;
    testWriteClipboardImage();
  });
  // Item 66 — anexo de imagem no composer do chatbox (paste/drop na
  // própria textarea, `ChatCard.tsx`). Diferente do clipboard acima: o
  // renderer já tem um `File` real (`clipboardData.items`/
  // `dataTransfer.files`), então manda os bytes prontos em base64 em vez
  // de pedir pro main ler o clipboard do SO de novo. Limite de tamanho
  // aqui, não no renderer — o mesmo main process que vai montar a
  // request da API é quem sabe o custo real de anexar algo grande demais.
  const MAX_CHAT_ATTACHMENT_BASE64_CHARS = 10 * 1024 * 1024 * 1.4; // ~10MB de bytes reais
  ipcMain.handle("chat:save-attachment-image", (_e, base64: string, mediaType: string) => {
    if (base64.length > MAX_CHAT_ATTACHMENT_BASE64_CHARS) {
      return { ok: false, error: "imagem grande demais (limite ~10MB)" };
    }
    return saveImageBytes(base64, mediaType);
  });
  ipcMain.handle("chat:read-attachment-image", (_e, path: string) => readAttachmentImage(path));

  // Item 57.9 — see board-assets.ts. `save-bytes` for a clipboard paste
  // (only bytes in memory), `copy-from-path` for a real dropped OS file.
  ipcMain.handle("board-assets:save-bytes", (_e, boardId: string, base64: string, mediaType: string) =>
    saveBoardAssetBytes(boardId, base64, mediaType),
  );
  ipcMain.handle("board-assets:copy-from-path", (_e, boardId: string, sourcePath: string) =>
    copyBoardAssetFromPath(boardId, sourcePath),
  );
  // `stellar-asset://asset/<boardId>/<filename>` — boardId/filename BOTH
  // live in the path, not the hostname. Real bug found live building
  // this: a "standard"-privileged scheme (required for fetch/streaming)
  // makes the WHATWG URL parser apply normal-URL host-parsing rules, and
  // a purely-numeric hostname (board ids are small integers stored as
  // strings, e.g. "1") gets silently reinterpreted as an IPv4 address in
  // dotted-decimal shorthand ("1" → "0.0.0.1") — the board-assets folder
  // is still named "1" on disk, so a hostname-based lookup 404s on every
  // single-digit board id. The fixed "asset" segment is just there so
  // the URL has a syntactically valid (non-numeric, harmless) authority.
  protocol.handle("stellar-asset", (request) => {
    const url = new URL(request.url);
    const [, boardId, ...rest] = url.pathname.split("/");
    const filename = decodeURIComponent(rest.join("/"));
    const realPath = boardId ? resolveBoardAsset(decodeURIComponent(boardId), filename) : null;
    if (!realPath) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(realPath).toString());
  });

  ipcMain.handle("store:list", (_e, boardId: string) => store.listCards(boardId));
  ipcMain.handle("store:upsert", (_e, card: CardRow) => store.upsertCard(card));
  ipcMain.handle("store:delete", (_e, id: string) => store.deleteCard(id));

  ipcMain.handle("store:connectors:list", (_e, boardId: string) => store.listConnectors(boardId));
  ipcMain.handle("store:connectors:upsert", (_e, row: ConnectorRow) => store.upsertConnector(row));
  ipcMain.handle("store:connectors:delete", (_e, id: string) => store.deleteConnector(id));
  ipcMain.handle("store:connectors:delete-for-card", (_e, cardId: string) => store.deleteConnectorsForCard(cardId));

  ipcMain.handle("store:favorites:list", () => store.listFavorites());
  ipcMain.handle("store:favorites:add", (_e, url: string, title: string) => store.addFavorite(url, title));
  ipcMain.handle("store:favorites:remove", (_e, url: string) => store.removeFavorite(url));

  ipcMain.handle("store:boards:list", () => store.listBoards());
  ipcMain.handle("store:boards:upsert", (_e, board: BoardRow) => store.upsertBoard(board));
  ipcMain.handle("store:boards:delete", (_e, id: string) => store.deleteBoard(id));
  // DESIGN-BACKLOG.md item 14 — Home's "último acesso".
  ipcMain.handle("store:boards:touch", (_e, id: string, at: number) => store.touchBoard(id, at));
  // DESIGN-BACKLOG.md item 59 — the only IPC channel that can flip
  // `boards.autonomous`. Reachable only from real renderer UI code
  // (App.tsx's session UI), never from message-bus.ts/mcp-server.ts —
  // there is no `BusRequest` cmd that touches this at all, on purpose.
  ipcMain.handle("store:boards:set-autonomous", (_e, id: string, autonomous: boolean) => store.setBoardAutonomous(id, autonomous));
  // Achado ao vivo (2026-09-01) — ver `activeBoardId` e o callback
  // `listCards` acima. Puro estado de sessão: nada é persistido, e um
  // relançamento começa em `null` (a app sempre abre na Home).
  ipcMain.on("board:active", (_e, id: string | null) => {
    activeBoardId = id;
  });
  // DESIGN-BACKLOG.md item 60, peça 2 — same shape/guarantee as
  // set-autonomous above: only real renderer UI reaches this, `cap: null`
  // means "back to the global default", never zero.
  ipcMain.handle("store:boards:set-concurrency-cap", (_e, id: string, cap: number | null) => store.setBoardConcurrencyCap(id, cap));
  ipcMain.handle("store:card-counts", () => store.cardCounts());
  ipcMain.handle("store:next-id-seed", () => store.nextIdSeed());
  // Item 30 — sessions sidebar (every chat card, live or archived) +
  // archive/unarchive (closing a ChatCard archives instead of deleting).
  ipcMain.handle("store:list-chat-sessions", () => store.listChatSessions());
  ipcMain.handle("store:archive-card", (_e, id: string) => store.archiveCard(id, Date.now()));
  ipcMain.handle("store:unarchive-card", (_e, id: string) => store.unarchiveCard(id));

  // "mudar pasta raiz" (ProjectPicker.tsx) — the real, navigable OS folder
  // dialog rather than a hand-built in-app tree browser: the user asked
  // for the workspace root to stop being hardcoded and become something
  // they can actually navigate to, and the native picker already does
  // that (double-click into folders, etc.) with no extra UI to build.
  ipcMain.handle("fs:pick-directory", async (_e, defaultPath: string) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Item 57.8 — "exportação do canvas com seleção de área". `rect` já vem
  // em pixels da área de conteúdo da janela (o mesmo espaço que
  // `capturePage` espera — a ferramenta "export", App.tsx, desenha o
  // recorte direto em client coords, sem nenhuma conversão de mundo/zoom
  // necessária). Reusa a MESMA API (`webContents.capturePage`) que o
  // `snapshot` MCP já usa pra cardId/rect — uma captura real de janela,
  // não um DOM-to-canvas de biblioteca (que não renderiza WebGL/views
  // nativas corretamente); PNG/JPEG via `nativeImage`, PDF embrulha o
  // JPEG num wrapper mínimo (pdf-export.ts).
  async function performExport(rect: Electron.Rectangle, format: "png" | "jpeg" | "pdf", filePath: string) {
    const image = await win.webContents.capturePage(rect);
    const { width, height } = image.getSize();
    if (width === 0 || height === 0) return { ok: false, error: "área vazia (nada capturado)" };
    try {
      const bytes =
        format === "png" ? image.toPNG() : format === "jpeg" ? image.toJPEG(92) : wrapJpegAsPdf(image.toJPEG(92), width, height);
      writeFileSync(filePath, bytes);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  ipcMain.handle(
    "export:capture-rect",
    async (_e, rect: Electron.Rectangle, format: "png" | "jpeg" | "pdf", defaultName: string) => {
      const ext = format === "jpeg" ? "jpg" : format;
      const saveResult = await dialog.showSaveDialog(win, {
        defaultPath: `${defaultName}.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (saveResult.canceled || !saveResult.filePath) return { ok: false, error: "cancelled" };
      return performExport(rect, format, saveResult.filePath);
    },
  );
  // Test-only (scripts/verify) — a native save dialog can't be driven by
  // CDP (it's not part of the web content), same limitation `fs:pick-
  // directory` already has. Bypasses ONLY the dialog step, writing
  // straight to a given path — everything else (capturePage, PNG/JPEG
  // encode, PDF wrapping) is the exact same code the real handler runs.
  // Inert in a packaged build, same guard/precedent as
  // `clipboard:test-write-image`.
  ipcMain.handle(
    "export:capture-rect-test",
    (_e, rect: Electron.Rectangle, format: "png" | "jpeg" | "pdf", filePath: string) => {
      if (app.isPackaged) return { ok: false, error: "test-only" };
      return performExport(rect, format, filePath);
    },
  );

  ipcMain.handle("fs:list", (_e, root: string, path: string) => listDir(root, path));
  ipcMain.handle("fs:read", (_e, root: string, path: string) => readFile(root, path));
  ipcMain.handle("fs:write", (_e, root: string, path: string, content: string) => writeFile(root, path, content));
  ipcMain.handle("fs:read-image", (_e, root: string, path: string) => readImageDataUrl(root, path));
  // DESIGN-BACKLOG.md item 49 — filename search across the whole tree,
  // not just the one directory level `fs:list` fetches.
  ipcMain.handle("fs:search-names", (_e, root: string, query: string) => searchFileNames(root, query));
  // DESIGN-BACKLOG.md item 51 — full-text search across file contents.
  ipcMain.handle("fs:search-contents", (_e, root: string, query: string) => searchFileContents(root, query));
  // DESIGN-BACKLOG.md item 13 — FilesCard quick actions.
  ipcMain.handle("fs:rename", (_e, root: string, path: string, newName: string) => renamePath(root, path, newName));
  ipcMain.handle("fs:delete", (_e, root: string, path: string) => deletePath(root, path));
  ipcMain.handle("fs:create", (_e, root: string, parentPath: string, name: string, kind: "file" | "folder") =>
    createEntry(root, parentPath, name, kind),
  );
  ipcMain.handle("git:status", (_e, cwd: string) => gitStatus(cwd));
  ipcMain.handle("fs:watch-start", (_e, root: string) => startWatching(root));
  ipcMain.handle("fs:watch-stop", (_e, root: string) => stopWatching(root));

  ipcMain.handle("browser:create", (_e, id: string, url: string) => browserRegistry.create(id, url));
  ipcMain.handle("browser:navigate", (_e, id: string, url: string) => browserRegistry.navigate(id, url));
  ipcMain.handle("browser:back", (_e, id: string) => browserRegistry.back(id));
  ipcMain.handle("browser:forward", (_e, id: string) => browserRegistry.forward(id));
  ipcMain.handle("browser:reload", (_e, id: string) => browserRegistry.reload(id));
  ipcMain.handle("browser:open-devtools", (_e, id: string) => browserRegistry.openDevTools(id));
  ipcMain.handle("browser:resize", (_e, id: string, w: number, h: number, zoom?: number) => browserRegistry.resize(id, w, h, zoom));
  ipcMain.handle("browser:set-visible", (_e, id: string, visible: boolean) => browserRegistry.setVisible(id, visible));
  ipcMain.handle("browser:set-focused", (_e, id: string, focused: boolean) => browserRegistry.setFocused(id, focused));
  ipcMain.handle("browser:destroy", (_e, id: string) => browserRegistry.destroy(id));
  ipcMain.on("browser:input-mouse", (_e, id: string, evt: BrowserMouseEvent) => browserRegistry.sendMouseEvent(id, evt));
  ipcMain.on("browser:input-wheel", (_e, id: string, evt: BrowserWheelEvent) => browserRegistry.sendWheelEvent(id, evt));
  ipcMain.on("browser:input-key", (_e, id: string, evt: BrowserKeyEvent) => browserRegistry.sendKeyEvent(id, evt));
  ipcMain.handle("browser:ask-resolve", (_e, requestId: string, allowed: boolean, cardId?: string) =>
    messageBus.resolveOpen(requestId, allowed, cardId),
  );
  // Item 26, teclado — IME e clipboard real (ver browser-registry.ts).
  ipcMain.handle("browser:insert-text", (_e, id: string, text: string) => browserRegistry.insertText(id, text));
  ipcMain.handle("browser:paste", (_e, id: string) => browserRegistry.pasteText(id));
  ipcMain.handle("browser:copy", (_e, id: string) => browserRegistry.copyText(id));
  ipcMain.handle("browser:cut", (_e, id: string) => browserRegistry.cutText(id));
  // Test-only, same guard/reasoning as chat:test-simulate-tool above —
  // there's no editable field to focus on about:blank otherwise, and a
  // real editable field on a real third-party page would make the
  // paste/copy/IME smoke test network-dependent and flaky. Inert in any
  // packaged build a user runs.
  ipcMain.handle("browser:test-make-editable", (_e, id: string) => {
    if (app.isPackaged) return;
    return browserRegistry.testMakeEditable(id);
  });

  // Test-only (2026-09-02), mesmo padrão de `browser:test-make-editable`
  // acima — não dá pra provar "trocar de monitor com scaleFactor
  // diferente" nesta máquina/CI sem um segundo monitor físico com
  // densidade diferente (Wayland nativo, o modo real deste app, nem
  // deixa reposicionar a janela programaticamente — já confirmado nesta
  // sessão). Simula só o GATILHO (o valor de scaleFactor que
  // `getScaleFactor()` teria lido de um monitor diferente) — todo o
  // resto do caminho (`browserRegistry.refreshScaleFactor`'s diffing,
  // `browser:scale-factor-changed` IPC, `BrowserCard.tsx` atualizando o
  // espelho e re-disparando um resize real) roda de verdade, sem
  // simulação nenhuma. `refreshScaleFactor` só existe pra chamar
  // `callbacks.getScaleFactor()` de novo, então setar o entry direto e
  // reusar o MESMO IPC que o caminho real dispara é fiel ao
  // comportamento real, só troca de onde o número novo vem.
  ipcMain.handle("browser:test-force-scale-factor", (_e, id: string, scaleFactor: number) => {
    if (app.isPackaged) return;
    browserRegistry.forceScaleFactor(id, scaleFactor);
    safeSend(win, "browser:scale-factor-changed", id, scaleFactor);
  });

  // EXPERIMENTAL, test-only (2026-09-02) — ver browser-registry.ts's
  // `testSetMaxDensity` doc comment. Só muda o override; não dispara
  // resize sozinho — combine com `browser:test-force-scale-factor` (ou
  // qualquer resize real) pra ver o efeito. Removível quando o "ponto
  // doce" virar a constante `BROWSER_MAX_DENSITY` de verdade.
  ipcMain.handle("browser:test-set-max-density", (_e, value: number | null) => {
    if (app.isPackaged) return;
    browserRegistry.testSetMaxDensity(value);
  });

  ipcMain.handle("ai:summarize", (_e, providerId: string, cwd: string, prompt: string) =>
    runOneShotSummary(providerId, cwd, prompt),
  );

  // Test-only, same guard/reasoning as chat:test-simulate-tool above —
  // DESIGN-BACKLOG.md item 37's crash-safety net (`process.on
  // ("uncaughtException", ...)` above) has no other way to prove it
  // actually works short of throwing a real uncaught exception in main
  // and confirming the process survives it. `setImmediate` so the throw
  // happens genuinely async/uncaught (not synchronously inside this
  // handler, which `ipcMain.handle` would just catch and reject as an
  // ordinary IPC error — that path was already safe before this item and
  // proves nothing new).
  ipcMain.handle("debug:test-trigger-uncaught-exception", () => {
    if (app.isPackaged) return;
    setImmediate(() => {
      throw new Error("test-only uncaught exception — DESIGN-BACKLOG.md item 37 crash-safety-net check");
    });
  });

  // Test-only, same guard/reasoning as above — pre-release audit B6's
  // verify harness has no other way to observe whether main's own
  // `ipcMain` listener for a reply channel actually got cleaned up (vs.
  // leaking) after a renderer-never-replies timeout.
  ipcMain.handle("debug:listener-count", (_e, channel: string) => {
    if (app.isPackaged) return -1;
    return ipcMain.listenerCount(channel);
  });

  // Test-only, same guard — pre-release audit B4's verify harness needs
  // main's REAL heap size to prove a large sandboxed-bash output doesn't
  // balloon it, not just that the returned text is short.
  ipcMain.handle("debug:heap-used-mb", () => {
    if (app.isPackaged) return -1;
    if (global.gc) global.gc();
    return process.memoryUsage().heapUsed / (1024 * 1024);
  });

  // Test-only, same guard — pre-release audit B7's verify harness.
  ipcMain.handle("debug:seen-urls-count", (_e, cardId: string) => {
    if (app.isPackaged) return -1;
    return registry.seenUrlsCount(cardId);
  });

  // Test-only, same guard — Trilha A do navegador's verify harness needs
  // the offscreen BrowserWindow's REAL content-pixel size, straight from
  // Electron, to prove `resize`'s zoom scaling actually happened.
  ipcMain.handle("debug:browser-content-size", (_e, cardId: string) => {
    if (app.isPackaged) return null;
    return browserRegistry.getContentSize(cardId);
  });

  // DESIGN-BACKLOG.md item 12, Fase B/C.
  ipcMain.handle("secrets:has", (_e, provider: SecretProvider) => secretsStore.has(provider));
  ipcMain.handle("secrets:set", (_e, provider: SecretProvider, value: string, baseURL?: string) =>
    secretsStore.set(provider, value, baseURL),
  );
  ipcMain.handle("secrets:clear", (_e, provider: SecretProvider) => secretsStore.clear(provider));
  ipcMain.handle("secrets:encryption-available", () => secretsStore.isEncryptionAvailable());
  // Item 28 — only "generic" ever has one set; used by ChatCard.tsx to
  // prefill the endpoint field when reopening the key form.
  ipcMain.handle("secrets:get-base-url", (_e, provider: SecretProvider) => secretsStore.getBaseURL(provider));

  ipcMain.handle(
    "chat:send",
    (
      _e,
      cardId: string,
      params: { provider: SecretProvider; model: string; systemPrompt: string | null; messages: ChatMessage[]; cwd: string },
    ) => {
      const apiKey = secretsStore.get(params.provider);
      if (!apiKey) return { ok: false, error: `nenhuma API key configurada pra ${params.provider}` };
      if (params.provider === "anthropic") {
        anthropicClient.send(cardId, {
          apiKey,
          model: params.model,
          system: params.systemPrompt,
          messages: params.messages,
          root: params.cwd,
        });
        return { ok: true };
      }
      // "openai"/"gemini"/"generic" all speak the same OpenAI-compatible
      // Chat Completions shape (item 28) — gemini gets a fixed baseURL,
      // generic gets whatever the user configured in the key form
      // (secrets.ts), openai stays undefined (SDK's own default).
      if (params.provider === "generic" && !secretsStore.getBaseURL(params.provider)) {
        return { ok: false, error: "provider genérico sem endpoint (baseURL) configurado" };
      }
      const baseURL =
        params.provider === "gemini" ? GEMINI_OPENAI_BASE_URL : (secretsStore.getBaseURL(params.provider) ?? undefined);
      openaiClient.send(cardId, {
        apiKey,
        model: params.model,
        system: params.systemPrompt,
        messages: params.messages,
        root: params.cwd,
        baseURL,
      });
      return { ok: true };
    },
  );
  ipcMain.handle("chat:cancel", (_e, cardId: string, provider: SecretProvider) =>
    (provider === "anthropic" ? anthropicClient : openaiClient).cancel(cardId),
  );
  ipcMain.handle("chat:write-resolve", (_e, requestId: string, allowed: boolean) => {
    const entry = pendingWriteConsents.get(requestId);
    if (!entry) return;
    pendingWriteConsents.delete(requestId);
    entry.resolve(allowed);
  });
  ipcMain.handle("chat:bash-resolve", (_e, requestId: string, allowed: boolean) => {
    const entry = pendingBashConsents.get(requestId);
    if (!entry) return;
    pendingBashConsents.delete(requestId);
    entry.resolve(allowed);
  });
  // Pre-release audit B2 — fire-and-forget, sent from `App.tsx`'s
  // `finalizeCloseCard` right when a chat card is actually removed.
  ipcMain.on("chat:card-closed", (_e, cardId: string) => resolveConsentsForCard(cardId));
  // Test-only trigger (verify harness — scripts/verify/smoke-chat.mjs),
  // same reasoning/guard as updater.ts's `updater:test-emit-available`:
  // there's no way to exercise the real read_file/write_file/consent/diff
  // pipeline without a real model actually deciding to call a tool, which
  // needs a real paid API call this harness can't make. This drives the
  // SAME real `executeTool` (chat-tools.ts) a real tool_use response
  // would — real fs read/write, real diff, real consent round trip — just
  // substituting "which tool to call" for a direct trigger. Inert in any
  // packaged build a user runs.
  ipcMain.handle("chat:test-simulate-tool", (_e, cardId: string, name: string, input: unknown, root: string) => {
    if (app.isPackaged) return { ok: false, text: "test-only, dev builds only" };
    return executeTool(name, input, {
      root,
      onToolStart: (n, i) => safeSend(win, "chat:tool-start", cardId, n, i),
      onToolResult: (n, ok, summary) => safeSend(win, "chat:tool-result", cardId, n, ok, summary),
      askWriteConsent: (req) => askWriteConsent(cardId, req),
      askBashConsent: (req) => askBashConsent(cardId, req),
      delegateToAgent: (provider, reason) => delegateToAgent(cardId, root, provider, reason),
    });
  });

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

  // LAN-only mobile control (DESIGN-BACKLOG.md item 2) — per-device
  // pairing (item 2 revisited): each call pairs a NEW phone (fresh id +
  // token + QR), `remote:devices` lists everyone already paired (no
  // token in that list — see remote-server.ts), and revoke can target
  // one device or everyone.
  ipcMain.handle("remote:pair-new-device", (_e, label?: string) => remoteServer!.pairNewDevice(label));
  ipcMain.handle("remote:devices", () => remoteServer!.listDevices());
  ipcMain.handle("remote:revoke-device", (_e, id: string) => remoteServer!.revokeDevice(id));
  ipcMain.handle("remote:revoke-all", () => remoteServer!.revokeAll());

  registerUpdater(win);

  // `browserRegistry.destroyAll()` touches `win.contentView` — needs `win`
  // still alive, so it has to run on "close" (before teardown), not
  // "closed" (after: `win` is already a destroyed native object at that
  // point, and `win.contentView.removeChildView(...)` throws "Object has
  // been destroyed", an uncaught exception that crashes the whole main
  // process — confirmed live). Same failure mode `safeSend` above already
  // guards against for `win.webContents.send`; this is the same fix,
  // applied by moving the call to the event where `win` is still valid
  // instead of adding another isDestroyed() guard.
  win.on("close", () => {
    browserRegistry.destroyAll();
  });
  win.on("closed", () => {
    // `screen.on(...)` acima é um listener GLOBAL do módulo `screen`, não
    // escopado a `win` (diferente de `win.on("moved", ...)`, que o
    // próprio Electron já limpa ao destruir a janela) — sem isto, ficaria
    // pendurado referenciando um `win` já destruído se `createWindow()`
    // algum dia rodasse mais de uma vez no mesmo processo.
    screen.removeListener("display-metrics-changed", recheckBrowserScaleFactors);
    stopAllWatchers();
    messageBus?.close();
    mcpServer.close();
    registry.killAll();
    remoteServer?.close();
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
