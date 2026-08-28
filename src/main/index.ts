import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } from "electron";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyRegistry } from "./pty-registry";
import { openStore, type CardRow, type ConnectorRow, type BoardRow } from "./store";
import type { SpawnOpts } from "./providers";
import { createEntry, deletePath, listDir, readFile, readImageDataUrl, renamePath, writeFile } from "./fs-tools";
import { gitStatus } from "./git-tools";
import { saveClipboardImage, testWriteClipboardImage } from "./clipboard-image";
import {
  createBrowserRegistry,
  type BrowserMouseEvent,
  type BrowserWheelEvent,
  type BrowserKeyEvent,
} from "./browser-registry";
import { createMessageBus, type BusRequest } from "./message-bus";
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

const isDev = !app.isPackaged;

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
  // socket, so it doesn't go through message-bus.ts at all). No timeout
  // here unlike those — a diff needing real review shouldn't auto-deny
  // just because the human stepped away; the tool loop simply stays
  // paused until they come back, same as any other open modal in this app.
  const pendingWriteConsents = new Map<string, (allowed: boolean) => void>();
  // DESIGN-BACKLOG.md item 12, Fase D — the `bash` tool's consent gate,
  // same requestId-keyed pending-map shape as `pendingWriteConsents`
  // above (deliberately a SEPARATE map, not a unified one — this
  // codebase's own established idiom for a new consent kind, see
  // message-bus.ts's pendingSnapshots/pendingPageTexts/pendingSpawnAgents/
  // pendingSpawnCards, four near-identical maps rather than one unified
  // one). No timeout, same reasoning as write consent.
  const pendingBashConsents = new Map<string, (allowed: boolean) => void>();
  let nextChatRequestId = 1;
  function askWriteConsent(cardId: string, req: WriteConsentRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = String(nextChatRequestId++);
      pendingWriteConsents.set(requestId, resolve);
      safeSend(win, "chat:ask-write", requestId, cardId, req);
    });
  }
  function askBashConsent(cardId: string, req: BashConsentRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = String(nextChatRequestId++);
      pendingBashConsents.set(requestId, resolve);
      safeSend(win, "chat:ask-bash", requestId, cardId, req);
    });
  }
  // Reuses the EXISTING spawn_agent consent+spawn flow end to end
  // (message-bus.ts's `handleRequest`, the same dispatcher acbridge and
  // the MCP server already call) rather than building a second one — the
  // human sees the exact same AgentAskModal a real `spawn_agent` MCP call
  // already produces. `depth: 0` is correct/honest here (not `undefined`
  // defaulting to 0 inside handleRequest by accident): a chat-initiated
  // delegation is a fresh top-level chain, same as any human-initiated
  // spawn from the rail/radial menu — it isn't itself a spawned PTY
  // process, so it carries no AGENT_CANVAS_SPAWN_DEPTH to inherit.
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
      depth: 0,
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
    onDone: (cardId, fullText) => safeSend(win, "chat:done", cardId, fullText),
    onError: (cardId, message) => safeSend(win, "chat:error", cardId, message),
    ...chatToolCallbacks,
  });
  const openaiClient = createOpenAiClient({
    onToken: (cardId, delta) => safeSend(win, "chat:token", cardId, delta),
    onDone: (cardId, fullText) => safeSend(win, "chat:done", cardId, fullText),
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
    listTerminals: () =>
      store
        .listAllCards()
        .filter((c) => c.kind === "terminal" && registry.isAlive(c.id))
        .map((c) => ({ id: c.id, label: c.label, provider: c.provider, cwd: c.cwd })),
    onWrite: (id, data) => registry.write(id, data),
    onResize: (id, cols, rows) => registry.resize(id, cols, rows),
  });

  // With WebRTCPipeWireCapturer enabled above, a single getSources() call
  // made lazily (at request time, inside this handler — not at app
  // startup, where it was empirically confirmed useless) is itself what
  // triggers the native xdg-desktop-portal picker dialog and returns
  // whatever the user chose in it. There is deliberately no in-app source
  // list here — that path was tried and abandoned (DESIGN-BACKLOG.md item
  // 3): this app can't enumerate real window names/thumbnails on Wayland,
  // only the portal's own dialog can.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
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
  });

  messageBus = createMessageBus(sockPath, {
    listCards: () =>
      store
        .listAllCards()
        .filter((c) => c.kind === "terminal")
        .map((c) => ({ id: c.id, provider: c.provider, cwd: c.cwd })),
    writeToCard: (id, text) => registry.write(id, text),
    onOpenRequest: (requestId, requesterId, url, reason) =>
      safeSend(win, "browser:ask-open", requestId, requesterId, url, reason),
    onSnapshotRequest: (requestId, target) => handleSnapshotRequest(win, messageBus!, requestId, target),
    // DESIGN-BACKLOG.md item 21, ponto 9, achado 5 — no consent needed
    // (see message-bus.ts's PAGE_TEXT_TIMEOUT_MS comment), so this goes
    // straight to browserRegistry instead of round-tripping through a
    // renderer ask/resolve pair like the two below.
    onPageTextRequest: (requestId, cardId) => {
      void browserRegistry.getPageText(cardId).then((result) => messageBus!.resolvePageText(requestId, result));
    },
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
    (_e, id: string, providerId: string, cwd: string, cols: number, rows: number, opts?: SpawnOpts) => {
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
  // DESIGN-BACKLOG.md item 14 — Home's "último acesso".
  ipcMain.handle("store:boards:touch", (_e, id: string, at: number) => store.touchBoard(id, at));
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

  ipcMain.handle("fs:list", (_e, root: string, path: string) => listDir(root, path));
  ipcMain.handle("fs:read", (_e, root: string, path: string) => readFile(root, path));
  ipcMain.handle("fs:write", (_e, root: string, path: string, content: string) => writeFile(root, path, content));
  ipcMain.handle("fs:read-image", (_e, root: string, path: string) => readImageDataUrl(root, path));
  // DESIGN-BACKLOG.md item 13 — FilesCard quick actions.
  ipcMain.handle("fs:rename", (_e, root: string, path: string, newName: string) => renamePath(root, path, newName));
  ipcMain.handle("fs:delete", (_e, root: string, path: string) => deletePath(root, path));
  ipcMain.handle("fs:create", (_e, root: string, parentPath: string, name: string, kind: "file" | "folder") =>
    createEntry(root, parentPath, name, kind),
  );
  ipcMain.handle("git:status", (_e, cwd: string) => gitStatus(cwd));

  ipcMain.handle("browser:create", (_e, id: string, url: string) => browserRegistry.create(id, url));
  ipcMain.handle("browser:navigate", (_e, id: string, url: string) => browserRegistry.navigate(id, url));
  ipcMain.handle("browser:back", (_e, id: string) => browserRegistry.back(id));
  ipcMain.handle("browser:forward", (_e, id: string) => browserRegistry.forward(id));
  ipcMain.handle("browser:reload", (_e, id: string) => browserRegistry.reload(id));
  ipcMain.handle("browser:resize", (_e, id: string, w: number, h: number) => browserRegistry.resize(id, w, h));
  ipcMain.handle("browser:set-visible", (_e, id: string, visible: boolean) => browserRegistry.setVisible(id, visible));
  ipcMain.handle("browser:destroy", (_e, id: string) => browserRegistry.destroy(id));
  ipcMain.on("browser:input-mouse", (_e, id: string, evt: BrowserMouseEvent) => browserRegistry.sendMouseEvent(id, evt));
  ipcMain.on("browser:input-wheel", (_e, id: string, evt: BrowserWheelEvent) => browserRegistry.sendWheelEvent(id, evt));
  ipcMain.on("browser:input-key", (_e, id: string, evt: BrowserKeyEvent) => browserRegistry.sendKeyEvent(id, evt));
  ipcMain.handle("browser:ask-resolve", (_e, requestId: string, allowed: boolean) =>
    messageBus.resolveOpen(requestId, allowed),
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
    const resolve = pendingWriteConsents.get(requestId);
    if (!resolve) return;
    pendingWriteConsents.delete(requestId);
    resolve(allowed);
  });
  ipcMain.handle("chat:bash-resolve", (_e, requestId: string, allowed: boolean) => {
    const resolve = pendingBashConsents.get(requestId);
    if (!resolve) return;
    pendingBashConsents.delete(requestId);
    resolve(allowed);
  });
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
