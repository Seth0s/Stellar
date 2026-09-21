import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  session,
  shell,
} from "electron";
import { appendFileSync, chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPtyRegistry } from "./pty-registry";
import {
  decidePtyHoldAppend,
  decideRendererGone,
  decideSafeSend,
  decideSafeSendErrorLog,
  formatRendererGoneLogLine,
  pruneRendererGoneReloads,
  RENDERER_GONE_LOG_BASENAME,
  type RendererGoneDecision,
} from "./renderer-gone-decision";
import { identifyCurrentSession } from "./session-identify";
import { isSessionIdClaimed } from "./session-watch";
import { decideIdentifyApply, decideIdentifyCardGate, decideIdentifyChoiceApply } from "./session-identify-apply";
// Fase B (atalhos), round 2 — `matchesCombo`/`getShortcutCombo` vêm de
// `renderer/src/shortcut-registry.ts` de propósito: é um módulo puro (zero
// import de React/DOM/Electron, confirmado — só depende de `keyboard-
// shortcut-guard.ts`, também puro), então importável daqui sem trazer
// nada do bundle do renderer junto (cada alvo do electron-vite — main/
// preload/renderer — é compilado separado; um import relativo simples
// resolve normal). Não existe pasta `shared/` neste repo pra um único
// arquivo justificar criar; o ponto real é que main usa o MESMO objeto
// `combo` que o registro declara pro zoom, não uma cópia dos literais —
// ver o doc comment de `getShortcutCombo`.
import { matchesCombo, getShortcutCombo, type ShortcutKeyEvent } from "../renderer/src/shortcut-registry";
import { deriveCardDisplayName } from "../shared/card-identity";
import { t, setLocale, resolveLocale, isLocale, type Locale } from "../shared/i18n";
import { createLocalePrefs } from "./locale-prefs";
import { openStore, type CardRow, type ConnectorRow, type BoardRow, type TaskRow } from "./store";
import { decideFailureKind, stampFailureKindJson, interruptionReasonFromResultJson } from "./failure-kind-decision";
import { describeStatusAskResolved } from "./status-write-decision";
import { createTaskWriteFunnel } from "./task-write-funnel";
import { applyTaskPromptWrite, type TaskPromptWriteMode } from "../task-prompt-decision";
import { normalizeTaskPurpose, normalizeTaskReview, type TaskPurpose } from "../task-purpose";
import { deriveParticipationDivergence, deriveTaskStatus } from "../task-status-derive";
import { checkAgentAvailability, providerById, type SpawnOpts } from "./providers";
import { projectEffortValues, providersReloadNotices } from "./agent-availability-projection";
import {
  MEASURED_THIRD_PARTY_SPECS,
  PROVIDERS_CONFIG_SCHEMA_VERSION,
  bootstrapProvidersConfig,
  createProvidersConfigWatcher,
  ensureProvidersConfigFile,
  formatProvidersReloadLine,
  loadDynamicProviders,
  parseProviderSpec,
  parseProviderSpecs,
  providersConfigPath,
  type DynamicProviderSpec,
} from "./providers-dynamic";
import { shouldStampParticipationSession } from "./participation-session-decision";
import { resolveDeclaredTaskId } from "./card-spawn-env-decision";
import { refreshUserEnv, setSystemLanguageHint, userEnvSnapshot } from "./user-env";
import { composeSystemLanguageHint } from "./locale-env-decision";
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
import { startWatching, stopWatching, stopAllWatchers, setWatchedDirs, getWatchStats } from "./file-watcher";
import { saveClipboardImage, saveImageBytes, saveAttachmentBytes, readAttachmentImage, testWriteClipboardImage } from "./clipboard-image";
import { defaultVoiceConfigInput, resolveVoiceConfig, WhisperTranscriber } from "./voice-transcription";
import { wrapJpegAsPdf } from "./pdf-export";
import { saveBoardAssetBytes, copyBoardAssetFromPath, resolveBoardAsset } from "./board-assets";
import { PICK_MEDIA_EXTENSIONS, resolvePickedMediaFile } from "./spawn-media-decision";
import {
  createBrowserRegistry,
  type BrowserMouseEvent,
  type BrowserWheelEvent,
  type BrowserKeyEvent,
  type BrowserContextMenuParams,
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
import { decideSingleInstancePolicy, describeSingleInstanceRefusal } from "./single-instance-decision";
import { createNotifyCoalescer } from "./notify-coalescer";
import {
  APP_NAME,
  SOCK_BASENAME,
  applyUserDataMigration,
  decideUserDataMigration,
  legacyUserDataDir,
  probeLegacyInstanceLive,
  readMigrationFsSnapshot,
} from "./user-data-migration";
import { resolveBuildIdentity, type BuildIdentity } from "./build-identity";
import { ACBRIDGE_PROTOCOL } from "./acbridge-protocol-decision";

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

// Fase B (atalhos), round 2 — os dois combos que `before-input-event`
// (mais abaixo, `createWindow`) realmente casa contra, lidos direto do
// registro em vez de literais soltos aqui. `getShortcutCombo` lança se o
// id sumir do registro — falha no boot, não um zoom quieto e quebrado.
const ZOOM_IN_COMBO = getShortcutCombo("canvas.zoomIn");
const ZOOM_OUT_COMBO = getShortcutCombo("canvas.zoomOut");

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
// state into ~/.config/Electron instead of ~/.config/stellar. Pin it
// explicitly so userData is deterministic regardless of launch method.
// First boot after this rename runs `user-data-migration.ts` (copy
// essentials from the legacy `agent-canvas` dir; leave that dir intact).
app.setName(APP_NAME);

// Bug real relatado (Pop!_OS, 2026-09-09) — sem lock de instância única,
// nada impedia DUAS instâncias do Stellar coexistindo (ex.: um segundo
// clique no launcher). `createWindow()`, chamado de `app.whenReady().then()`
// lá embaixo, é quem abre o store, o socket do acbridge
// (`message-bus.ts`'s `createMessageBus`) e o servidor MCP — nada disso
// roda antes de `whenReady`, então barrar a 2ª instância AQUI, antes de
// qualquer `.then()` rodar, evita o efeito colateral inteiro, não só o
// socket. Sequência confirmada que isto fecha: 2ª instância sobe, unlinka
// o `.sock` da 1ª (viva) na entrada de `createMessageBus`, binda o seu, a
// janela da 2ª fecha, seu `close()` unlinka de novo — sobra a 1ª instância
// com o server escutando num inode sem nome nenhum no filesystem, e o Stop
// hook do Claude Code (`acbridge turn-complete`) passa a falhar com
// `connect ENOENT` mesmo com o processo do Stellar vivo.
//
// Posição CORRIGIDA (revisão do coordenador, 2026-09-09) — este bloco
// tinha ficado ANTES do `app.setName()` acima numa primeira versão desta
// correção. Errado: `requestSingleInstanceLock()` deriva sua chave da
// identidade/userData do app (mesmo `app.getPath("userData")` que
// `sockPath`/`openStore`/`createSecretsStore` usam, linhas abaixo), e o
// comentário logo acima de `app.setName()` já documenta que, sem ele,
// `app.name` cai pro default do Electron ("Electron") em vez de
// "stellar" quando lançado pelo entry point compilado (não `electron
// .`) — exatamente como electron-vite dev e o binário empacotado rodam.
// Pegar o lock ANTES do `setName()` adquiria sob a identidade errada, não
// sob "stellar": tinha que rodar depois, e ainda assim antes de
// qualquer efeito colateral real (store/socket/mcp/janela), daí ficar bem
// aqui.
//
// Política 2026-09-14 (`single-instance-decision.ts`): SEMPRE pedir o
// lock — dev e packaged compartilham o mesmo `setName` / userData /
// socket / DB. O gate antigo em `app.isPackaged` (permitir dev com o
// instalado aberto) era exatamente a classe de bug: acbridge cruzado,
// seed de id colidindo (FURO 2), medição ambígua de "código velho".
// Medido no mesmo dia: 11 scopes `app-electron-*` subiram com
// `/opt/Stellar/stellar` ainda vivo. Separar userData por modo foi
// rejeitado — o board real (Maestro + Idyplatform) sumiria em dev sem
// migração explícita. Fluxo novo: fechar uma instância antes de abrir a
// outra; a 2ª tentativa foca a que detém o lock via `second-instance`.
const singleInstancePolicy = decideSingleInstancePolicy(app.isPackaged);
const gotSingleInstanceLock = singleInstancePolicy.requestLock
  ? app.requestSingleInstanceLock()
  : true;
if (singleInstancePolicy.quitIfLost && !gotSingleInstanceLock) {
  // Fala antes de morrer — ver `describeSingleInstanceRefusal`. `quit()`
  // é assíncrono e não garante que nada mais saia depois; escrever aqui,
  // síncrono, é o que garante que a linha exista no stderr de quem
  // lançou (agente ou humano).
  process.stderr.write(`${describeSingleInstanceRefusal(app.getPath("userData"))}\n`);
  // `app.quit()` é assíncrono — não interrompe a execução síncrona deste
  // módulo. O guard dentro de `app.whenReady().then()` lá embaixo
  // (`if (!gotSingleInstanceLock) return;`) é o que garante de verdade que
  // `createWindow()` nunca roda nesta instância, mesmo se `ready` disparar
  // antes do quit terminar.
  app.quit();
}

/** Identity of THIS process — shared by Settings UI, MCP `build_identity`,
 * and `hello` / `acbridge version`. See build-identity.ts. */
function currentBuildIdentity(): BuildIdentity {
  return resolveBuildIdentity({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    busProtocol: ACBRIDGE_PROTOCOL,
    // electron-vite / packaged launches keep cwd at the project or install
    // root; when that isn't a git work tree, probe returns commit:null.
    gitCwd: process.cwd(),
  });
}

/**
 * A PTY/browser-view event can fire after the window has already been torn
 * down — killing a process (or destroying a view) on `win.on("closed")` is
 * not synchronous with the OS actually reaping it, so its exit/data event
 * can still arrive afterward. `win.webContents.send` on an already-destroyed
 * window throws "Object has been destroyed" (uncaught, since these fire from
 * event-emitter callbacks, not from an ipcMain handler) and crashes the
 * whole main process — confirmed live. Every send in this file goes through
 * this guard instead of calling `win.webContents.send` directly.
 *
 * 2026-09-14 follow-up: `win.isDestroyed()` alone is not enough. A live
 * BrowserWindow whose renderer frame is already gone (the journal incident)
 * still passes that check, and every `send` throws "Render frame was
 * disposed…". Gate via `decideSafeSend` (sticky `rendererReachable` +
 * contents destroyed) and catch the race; only the first frame-disposed
 * in a streak is logged — see `decideSafeSendErrorLog`.
 */
let mainWindowRendererReachable = true;
let safeSendFrameDisposedStreak = 0;

/**
 * A janela principal (a única com preload/UI de verdade) — publicada por
 * `createWindow`, `null` antes dela e depois de fechada. Existe para os
 * pushes que NASCEM fora de `createWindow`, sem acesso ao `win` local de lá:
 * hoje o relatório do watcher de `providers.json`, criado no `whenReady`
 * (antes da janela) e disparado por evento de arquivo (depois dela).
 *
 * Não dá para usar `BrowserWindow.getAllWindows()[0]` no lugar disto: os
 * cards de navegador têm `BrowserWindow` offscreen próprio (`browser-
 * registry.ts`), e mandar por `safeSend` numa janela dessas mexeria no
 * `mainWindowRendererReachable` da janela PRINCIPAL (é estado compartilhado
 * por desenho, ver o comentário acima) — um frame offscreen morto
 * silenciaria os sends da janela real.
 */
let mainWindow: BrowserWindow | null = null;

function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]) {
  const gate = decideSafeSend({
    windowDestroyed: win.isDestroyed(),
    contentsDestroyed: win.isDestroyed() ? true : win.webContents.isDestroyed(),
    rendererReachable: mainWindowRendererReachable,
  });
  if (gate.action === "skip") return;
  try {
    win.webContents.send(channel, ...args);
    safeSendFrameDisposedStreak = 0;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const logDecision = decideSafeSendErrorLog({
      errorMessage,
      consecutiveFrameDisposed: safeSendFrameDisposedStreak,
    });
    if (logDecision.kind === "frame-disposed") {
      safeSendFrameDisposedStreak += 1;
      // Sticky flag — further sends skip before throw (and PTY onData holds).
      mainWindowRendererReachable = false;
    } else {
      safeSendFrameDisposedStreak = 0;
    }
    if (logDecision.log) {
      console.error(`[safeSend] ${channel}:`, errorMessage);
    }
  }
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

/** DESIGN-BACKLOG.md §2.1 "identidade e descoberta de card", ponto 1 —
 * `deriveCardDisplayName`'s `fallbackHint` pra um `media` sem label: o
 * filename, mais útil que o substantivo genérico "Mídia". `card.cwd`
 * guarda `{assetPath, rotation, view}` como JSON pra este kind (mesma
 * convenção de `App.tsx`'s `toRow`/`parseMedia` — main nunca teve motivo
 * pra ler essa coluna antes disto, então esta é a primeira vez que
 * precisa saber o formato). Mesma postura defensiva de `parseMedia`: linha
 * malformada devolve `null` (cai pro substantivo genérico), nunca lança.
 * `null` pra qualquer outro kind — só `media` tem algo mais específico
 * que o substantivo a oferecer aqui. */
function mediaFilenameFallback(card: CardRow): string | null {
  if (card.kind !== "media") return null;
  try {
    const parsed = JSON.parse(card.cwd) as { assetPath?: unknown };
    const assetPath = typeof parsed?.assetPath === "string" ? parsed.assetPath : "";
    const filename = assetPath.split(/[\\/]/).pop();
    return filename || null;
  } catch {
    return null;
  }
}

/** Ponto único, dentro do processo main, que monta o `CardIdentitySnapshot`
 * pra `deriveCardDisplayName` — `describeCardLabel` (1 card por chamada) e
 * `listCards` (todos de um board, abaixo) chamam ESTE helper em vez de
 * cada um montar o snapshot à mão, pra nunca arriscar os dois divergirem
 * de novo por um detalhe de mapeamento esquecido num dos dois lugares. */
function cardDisplayName(card: CardRow, sameBoardCards: readonly CardRow[]): string {
  return deriveCardDisplayName(
    { id: card.id, kind: card.kind, label: card.label, provider: card.provider, fallbackHint: mediaFilenameFallback(card) },
    sameBoardCards.map((c) => ({ id: c.id, kind: c.kind, label: c.label, provider: c.provider })),
  );
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
  // DESIGN-BACKLOG.md §2.1 i18n fase 1 — resolve locale before any HUMAN-
  // facing string is read (application menu + browser context menu below).
  // Override lives in locale.json under userData (not store.ts — board DB
  // is a different concern). Agent-facing strings never call `t()`.
  const localePrefs = createLocalePrefs(app.getPath("userData"));
  const systemLocale = app.getLocale();
  setLocale(resolveLocale(systemLocale, localePrefs.getOverride()));
  // PTY locale synthesis uses the OS preferred language
  // (`getPreferredSystemLanguages()[0]`), not Chromium's application
  // locale. `app.getLocale()` above is correct for the Stellar UI
  // catalog — it follows the packaged `locales/` folder — but a
  // Brazilian Mac whose `.app` omitted `pt.lproj` reports `en-US`
  // there. Writing that into LANG would fix encoding and erase
  // Portuguese, which is exactly what rule 2 exists to prevent.
  // Region is paired from `getSystemLocale()` only when the preferred
  // tag is language-only and the languages match. The POSIX name is
  // still vetoed by `locale -a`.
  setSystemLanguageHint(
    composeSystemLanguageHint(app.getPreferredSystemLanguages(), app.getSystemLocale()),
  );

  function applyLocale(next: Locale): void {
    setLocale(next);
    Menu.setApplicationMenu(buildShortcutSafeMenu());
  }

  function buildShortcutSafeMenu(): Electron.Menu {
    return Menu.buildFromTemplate([
      {
        label: t("menu.edit"),
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: t("menu.view"),
        submenu: [
          { role: "toggleDevTools" },
          ...(app.isPackaged
            ? []
            : [
                { role: "reload" as const, accelerator: "F5" },
                { role: "forceReload" as const, accelerator: "Shift+F5" },
              ]),
        ],
      },
    ]);
  }

  // Atalhos fase A, item 4 — revisão pós-review rodada 3 (2026-09-09,
  // achado único, ALTA): a rodada anterior neutralizava Ctrl+R/Ctrl+W via
  // `before-input-event` + um cache `terminalFocused` alimentado por IPC
  // assíncrono do renderer (`focusin`/`focusout`). A CORRIDA real: sair de
  // um terminal (clicar fora) e teclar Ctrl+R ANTES do `focusout` chegar
  // ao main fazia o acelerador nativo recarregar a janela — perda de
  // estado real do usuário. Encurtar a janela de tempo não resolve
  // corrida nenhuma, só reduz a chance dela se manifestar.
  //
  // Solução do reviewer (melhor que a original) — REMOVER o acelerador da
  // fonte em vez de tentar vencer a corrida: um `Menu` PRÓPRIO,
  // construído aqui, que simplesmente não inclui os roles que geram
  // reload/close/zoom/quit/minimize. Sem esses roles, Ctrl+R/Ctrl+W (e
  // companhia) não têm NENHUM comportamento nativo pra neutralizar —
  // deixam de existir por construção, não por timing. `Menu.
  // buildFromTemplate`, não `Menu.setApplicationMenu(null)`: um menu nulo
  // mataria TAMBÉM o Ctrl+Shift+I (`role: "toggleDevTools"` é um item do
  // menu default do Electron; sem menu nenhum, o atalho de teclado dele
  // some junto) — o motivo original de nunca ter usado `null` na rodada 1
  // continua valendo. O Edit abaixo existe só pra manter Ctrl+A/C/V/X/Z
  // nativos em campos de texto — cada um desses roles já vem com o
  // acelerador padrão do Electron, nenhum hardcoded aqui.
  //
  // Eliminados de graça (nenhum role correspondente neste menu, logo
  // nenhum acelerador nativo): Ctrl+Shift+R (`forceReload`), Ctrl+0
  // (`resetZoom`), Ctrl+W (`close`, já neutralizado na rodada 1 — agora
  // eliminado na fonte também), Ctrl+Q (`quit`) e Ctrl+M (`minimize`) —
  // todos roles do menu default do Electron que simplesmente não estão
  // neste template. `before-input-event` (main/index.ts, mais abaixo)
  // encolheu pra cuidar só de Ctrl+Plus/Ctrl+Minus (redireciona pro zoom
  // do canvas) — isso NUNCA teve corrida (não depende de estado do
  // renderer, só faz `preventDefault` + reenvia um gatilho, nenhum cache
  // envolvido) e não tinha por que mudar. Ctrl+R/Ctrl+W não são mais
  // tratados lá: sem role nenhum os alimentando, o keydown flui normal
  // pro DOM — chega ao xterm (reverse-i-search/apagar-palavra) quando um
  // terminal está focado, sem cache, sem IPC, sem corrida possível.
  //
  // NÃO eliminados por este menu (fora do alcance de qualquer `Menu` do
  // Electron, confirmado pelo review) — Alt+←/→: navegação de histórico
  // embutida no `content` layer do Chromium que o Electron usa por baixo,
  // INDEPENDENTE de menu (gotcha documentado da comunidade Electron — só
  // dá pra neutralizar via `before-input-event`, que não faz isso hoje).
  // Registrado, não tratado agora — fase B decide. F5/Ctrl+P/Ctrl+F NUNCA
  // fizeram parte do menu default do Electron (confirmado pelo review) —
  // a suspeita da rodada 1 estava errada, não é que "podem nunca ter
  // feito nada": nunca fizeram mesmo. F5 fica livre por isso — ver abaixo.
  //
  // Achado leve da rodada 3 (review aprovou o resto, pediu só isto) — sem
  // NENHUM role de reload, quem desenvolve com HMR perdeu Ctrl+R/Ctrl+
  // Shift+R como fluxo de trabalho de verdade (recarregar a janela pra
  // ver uma mudança), não só uma conveniência de usuário final. Reabrir
  // via role 'reload'/'forceReload' SEM MAIS mexer no acelerador voltaria
  // a competir com reverse-i-search/apagar-palavra do xterm (a corrida
  // que a rodada 3 acabou de eliminar) — mas Electron permite dar um
  // `accelerator` PRÓPRIO a um `role`, substituindo (não somando) o
  // default do role: `{ role: "reload", accelerator: "F5" }` só responde
  // a F5, nunca a Ctrl+R. F5 (não Ctrl+Shift+R) porque a investigação
  // acima já confirma as duas coisas que importam: não é tecla de
  // readline/shell, e não colidia com nada neste app antes (nunca foi
  // acelerador de menu aqui). `Shift+F5` pro forceReload pela mesma razão.
  // `!app.isPackaged`: só existe em dev — um build empacotado continua
  // sem NENHUM caminho de reload, exatamente como a rodada 3 deixou.
  // Menu labels: `buildShortcutSafeMenu()` / `t()` (i18n fase 1) — built
  // once here and again when the locale override changes.
  Menu.setApplicationMenu(buildShortcutSafeMenu());

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
  // Header nativo do Mac (2026-09-08) — `frame: false` (usado nas outras
  // plataformas pro Titlebar.tsx custom) some com o traffic-light cluster
  // de vez; `titleBarStyle`/`trafficLightPosition` só fazem efeito com
  // `frame` NÃO false (confirmado na doc oficial do Electron). `"hidden"`,
  // não `"hiddenInset"` — a doc atual trata hiddenInset como a variante
  // antiga, hidden + trafficLightPosition é quem dá controle fino de
  // posição hoje. Offset (12, 11) estimado pra centralizar visualmente nos
  // 34px do `--titlebar-h` (tokens.css) — não verificado num Mac de
  // verdade, ajustar ao testar (Titlebar.tsx esconde os 3 botões próprios
  // no darwin via `window.platform`, ver preload/index.ts).
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: testBounds?.width ?? 1280,
    height: testBounds?.height ?? 800,
    ...(testBounds ? { x: testBounds.x, y: testBounds.y } : {}),
    ...(isMac
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 11 } }
      : { frame: false }),
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
  // Ver o doc comment de `mainWindow`: é por aqui que os pushes que nascem
  // fora deste escopo (o watcher de `providers.json`) chegam na UI.
  mainWindow = win;

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

  // 2026-09-14 — renderer-gone blindness. Policy in renderer-gone-decision.ts.
  // Log path under userData survives restart (owner looks here, not journal).
  const rendererGoneLogPath = join(app.getPath("userData"), RENDERER_GONE_LOG_BASENAME);
  let rendererGoneIsQuitting = false;
  let recentRendererGoneReloads: number[] = [];
  const heldPtyChunks = new Map<string, { chunks: string[]; bytes: number }>();

  function recordRendererGone(line: string) {
    try {
      appendFileSync(rendererGoneLogPath, line);
    } catch (err) {
      console.error("[renderer-gone] failed to append log:", err);
    }
    console.error(`[renderer-gone] ${line.trim()}`);
  }

  function holdPtyData(id: string, data: string) {
    const existing = heldPtyChunks.get(id) ?? { chunks: [], bytes: 0 };
    const decision = decidePtyHoldAppend({
      existingBytes: existing.bytes,
      incoming: data,
    });
    if (decision.action === "append") {
      existing.chunks.push(data);
      existing.bytes = decision.nextBytes;
      heldPtyChunks.set(id, existing);
      return;
    }
    const joined = existing.chunks.join("") + data;
    const kept = joined.slice(decision.keepFrom);
    heldPtyChunks.set(id, { chunks: [kept], bytes: decision.nextBytes });
  }

  function flushHeldPtyData() {
    for (const [id, held] of heldPtyChunks) {
      if (held.chunks.length === 0) continue;
      safeSend(win, "pty:data", id, held.chunks.join(""));
    }
    heldPtyChunks.clear();
  }

  function applyRendererGoneDecision(
    reason: string,
    exitCode: number,
    decision: Extract<RendererGoneDecision, { record: true }>,
    nowMs: number,
  ) {
    recordRendererGone(
      formatRendererGoneLogLine({ atMs: nowMs, reason, exitCode, decision }),
    );
    if (decision.action === "reload") {
      recentRendererGoneReloads = pruneRendererGoneReloads(
        [...recentRendererGoneReloads, nowMs],
        nowMs,
      );
      // Defer out of the `render-process-gone` stack. Measured 2026-09-14:
      // calling `reload()` synchronously here coincided with the browser
      // process dying SIGTRAP (exit 133) before the page came back — log
      // said `action:"reload"` but CDP went ECONNREFUSED. setImmediate
      // lets Chromium finish tearing down the dead frame first.
      setImmediate(() => {
        try {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            console.error("[renderer-gone] reloading webContents (deferred)");
            win.webContents.reload();
          } else {
            console.error("[renderer-gone] skip reload — window/contents already destroyed");
          }
        } catch (err) {
          console.error("[renderer-gone] reload failed:", err);
          rendererGoneIsQuitting = true;
          app.quit();
        }
      });
      return;
    }
    rendererGoneIsQuitting = true;
    app.quit();
  }

  win.webContents.on("render-process-gone", (_event, details) => {
    mainWindowRendererReachable = false;
    const nowMs = Date.now();
    const decision = decideRendererGone({
      reason: details.reason,
      exitCode: details.exitCode,
      nowMs,
      recentReloadAtMs: recentRendererGoneReloads,
      windowAlive: !win.isDestroyed(),
      isQuitting: rendererGoneIsQuitting,
    });
    if (!decision.record) return;
    applyRendererGoneDecision(details.reason, details.exitCode, decision, nowMs);
  });

  win.webContents.on("did-finish-load", () => {
    mainWindowRendererReachable = true;
    safeSendFrameDisposedStreak = 0;
    flushHeldPtyData();
  });

  app.on("before-quit", () => {
    rendererGoneIsQuitting = true;
    // Fatia 3b (ab83ba5f): o outro caminho de saída. Idempotente — se o
    // `win.on("close")` já flushou, este não entrega nada de novo.
    taskNotifyCoalescer.close();
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
  const sockPath = join(app.getPath("userData"), SOCK_BASENAME);
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

  /** Sticky item "Fila de concorrência quebrada", achado 2 (2026-09-03) —
   * fechar um card real (não um processo que simplesmente morreu) apaga a
   * linha do store (`store:delete` abaixo) essencialmente na mesma
   * síncrona de `finalizeCloseCard` no renderer, enquanto a saída real do
   * processo PTY (o que dispara `resolveCardExit` → `tryDispatchQueued`,
   * `onExit` do registry mais abaixo) chega DEPOIS, assíncrona — o sinal
   * mata o processo, o SO confirma a saída mais tarde. Se a linha já sumiu
   * quando esse evento chega, `getCardBoardId` (usado por
   * `resolveCardExit`) retorna `undefined` e o drain da fila é pulado em
   * silêncio, mesmo havendo capacidade livre de verdade. Cache curto,
   * populado logo ANTES do delete (abaixo) — só existe pra sobreviver essa
   * janela entre "linha apagada" e "processo confirmado morto"; um card
   * fechado tem exatamente um `onExit` esperado depois, então cada entrada
   * se limpa sozinha num timeout generoso em vez de crescer pra sempre. */
  const recentlyClosedCardBoardIds = new Map<string, string>();
  // onSessionFound (impose) can fire DURING spawn, BEFORE spawn_agent's
  // linkTaskCard writes the participation row. Buffer the id so the
  // subsequent link can stamp it — otherwise session_id stays null on
  // the very path that discovers it first.
  const pendingParticipationSessions = new Map<string, string>();
  function rememberBoardIdBeforeDelete(cardId: string) {
    const boardId = store.getCard(cardId)?.board_id;
    if (!boardId) return;
    recentlyClosedCardBoardIds.set(cardId, boardId);
    setTimeout(() => recentlyClosedCardBoardIds.delete(cardId), 60_000);
  }

  const mcpServer = createMcpServer({
    // Default 0 lets the OS assign a free ephemeral port — the URL is only
    // ever read in-process (registry's `mcpUrl` getter below), never
    // persisted or exposed externally, so there's nothing a fixed port
    // buys a real launch and it only invites EADDRINUSE when two instances
    // run at once. AGENT_CANVAS_MCP_PORT stays for the verify harness's
    // isolated test instances, which DO need a predictable port to dial
    // directly from outside the process (see smoke-mcp.mjs).
    port: Number(process.env.AGENT_CANVAS_MCP_PORT) || 0,
    handleRequest: (req: BusRequest) => messageBus!.handleRequest(req, { channel: "http" }),
  });

  const registry = createPtyRegistry({
    onData: (id, data) => {
      // Hold while the frame is dead — scrollback is agent work product;
      // discard would erase output produced during the gap. Cap + tail
      // truncate in decidePtyHoldAppend. remote mirror still gets live bytes.
      if (!mainWindowRendererReachable) {
        holdPtyData(id, data);
      } else {
        safeSend(win, "pty:data", id, data);
      }
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
    // CAMADA 3 — Fila derives pending/running from `registry.isAlive`, but
    // `task:changed` used to fire only on task-row writes. Measured
    // 2026-09-14: linkImplementerToTask pushes before `pty:spawn` (card
    // exists, PTY not yet in the Map → cardAlive=false frozen on the
    // Fila), and onExit never pushed. One consumer of the registry's
    // liveness edge — not a third copy of "task reached done" detection.
    onLivenessChanged: (id) => {
      // Board without a new query shape: principal task row carries
      // board_id; if the card row is already gone (close→delete before
      // async onExit), the same short-lived cache resolveCardExit uses.
      const task = store.listTasks().find((t) => t.card_id === id);
      const boardId =
        task?.board_id ?? store.getCard(id)?.board_id ?? recentlyClosedCardBoardIds.get(id);
      // Fatia 3b-2 (ab83ba5f): IMEDIATO de propósito. Isto é vivacidade da
      // LENDA do card, não escrita de task — a saída de um card precisa
      // aparecer na hora, e é raro.
      if (boardId) notifyTaskChanged(boardId);
    },
    onSessionFound: (id, sessionId) => {
      // Camada 2: stamp participation BEFORE (and independent of) the
      // renderer write-back. Card DELETE must not erase the id the task
      // needs to resume. Only resumable providers (claude/cursor).
      const provider =
        store.getCard(id)?.provider ??
        store.listTaskCardsForCardHistory(id)[0]?.provider ??
        null;
      if (shouldStampParticipationSession(provider)) {
        const n = store.setParticipationSessionId(id, sessionId);
        if (n === 0) pendingParticipationSessions.set(id, sessionId);
      }
      safeSend(win, "pty:session-found", id, sessionId);
    },
    // DESIGN-BACKLOG.md, achado 2 (2026-09-11) — canal dedicado pro aviso
    // de resumeId inválido (ver `pty-registry.ts`'s doc comment em
    // `onResumeInvalid`): DOM de verdade no rodapé do card
    // (`TerminalCard.tsx`), nunca bytes no pty — sobrevive a qualquer
    // clear/redraw de TUI em tela cheia.
    onResumeInvalid: (id, reason, staleResumeId) => safeSend(win, "pty:resume-invalid", id, reason, staleResumeId),
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
        .map((c) => ({
          id: c.id,
          // The mobile/remote surface has only this human-facing label
          // field, so expose the same display-only name as list_cards. The
          // ordinal is still never used as an id or routing key.
          label: cardDisplayName(c, store.listCards(c.board_id)),
          provider: c.provider,
          cwd: c.cwd,
        })),
    onWrite: (id, data) => registry.write(id, data, "human"),
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
    askHumanForBrowserPermission(t("dialog.mediaPermission")).then(callback);
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
    const sourceUrl = request.frame?.url || t("dialog.unknownPage");
    const allowed = await askHumanForBrowserPermission(t("dialog.displayCapture", { url: sourceUrl }));
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
    onFrame: (id, jpeg, width, height, region) => safeSend(win, "browser:frame", id, jpeg, width, height, region),
    onConsoleMessage: (id, level, message) => safeSend(win, "browser:console-message", id, level, message),
    onContextMenu: (id, params) => safeSend(win, "browser:context-menu", id, params),
    onCdpEvent: (id, method, params) => safeSend(win, "browser:cdp-event", id, method, params),
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

  // Espelha `preload/index.ts`'s `TaskBoardItem` (mesmo shape, sem import
  // cruzado main/preload — nenhum outro tipo IPC deste arquivo importa de
  // `preload` hoje, ver `onQueueChanged`'s callback logo abaixo, que
  // declara sua própria forma inline pelo mesmo motivo). Mantidos em
  // sincronia à mão; um esquecimento aqui só quebra em runtime pro
  // renderer, nunca silenciosamente — `tsc` no lado do preload aponta o
  // campo que sumiu.
  type TaskBoardItem = {
    id: string;
    prompt: string | null;
    provider: string | null;
    status: string;
    cardId: string | null;
    boardId: string | null;
    order: number | null;
    suggestedOrder: number | null;
    implicitOrder: number | null;
    retryCount: number;
    createdAt: number;
    updatedAt: number;
    lastActor: "app" | "agent" | "human" | "orchestrator" | null;
    cards: { cardId: string; role: string; kind: string | null; provider: string | null; label: string | null }[];
    report: { verdict: "aprovado" | "reprovado" | null; updatedAt: number } | null;
    // RODADA 2 (review de fidelidade ao protótipo v5) — pílula "espera
    // <id>". `deps` é o array cru de `deps_json` (já existia desde a Fase
    // 1); `depStatuses` só cobre OS ids desta lista (nunca o board
    // inteiro) — cada um resolvido por `store.getTaskStatus`, uma consulta
    // dedicada por dep (deps são poucos por task, não é o N+1 que a
    // listagem em massa evita). Um dep AUSENTE de `depStatuses` (não
    // "null", ausente mesmo) significa "não sei" — `waitingOnDepId`
    // (task-board-model.ts) trata isso como não-bloqueante, nunca um
    // falso positivo.
    deps: string[];
    depStatuses: Record<string, string>;
    purpose: TaskPurpose | null;
    /** Layer-1 review requirement. `null` = never declared. */
    review: "wanted" | null;
    depPurposes: Record<string, TaskPurpose | null>;
    cardAlive: boolean;
    statusTransitions: { toValue: string; at: number }[];
    /** DESIGN-BACKLOG.md §2.1 Decisão 8 — sinal vivo de divergência.
     * Ambos null = sem divergência. Espelha `tasks.diverged_status` /
     * `diverged_actor`. */
    divergedStatus: string | null;
    divergedActor: "app" | "agent" | "human" | "orchestrator" | null;
    requestedStatus: string | null;
    requestedReason: string | null;
    requestedBy: string | null;
    requestedAt: number | null;
    /** RODADA 4 — histórico de participação (`task_verdicts`), com
     * provider do card pra gráfico 1 / pílulas. */
    verdicts: { cardId: string; role: string; verdict: string | null; at: number; provider: string | null }[];
    /** Ator da 1ª transição de status — `human` ⇒ criada pela UI do quadro. */
    firstActor: "app" | "agent" | "human" | "orchestrator" | null;
    /** DESIGN-BACKLOG.md "Falha TIPADA" — motivo visível quando a task
     * voltou pra "a fazer" por interrupção (não julgamento). */
    interruptionReason: string | null;
  };
  // DESIGN-BACKLOG.md §2.1 Fase 2, peça 2 — o quadro de tasks (renderer)
  // precisa de push ao vivo, espelhando `onConnectorKindChanged`/
  // `onConnectorLabelChanged` logo abaixo: mesmo filtro por `activeBoardId`
  // antes de `safeSend`, pro board aberto nunca receber tráfego de IPC de
  // uma task de OUTRO board. `buildTaskBoard` monta a "anatomia" inteira
  // (peça 4: selo de origem, chips com papel, relatório do card principal,
  // status de dependência) com só 5 consultas NO TOTAL por chamada
  // (`listTasksByBoard` + `listLastActorsForBoard` + `listTaskCardsForBoard`
  // + `listReportsForBoard` + UMA `getTaskStatusesByIds` cobrindo toda
  // dependência do board de uma vez, RODADA 3 — a versão da rodada 2 fazia
  // uma consulta POR DEPENDÊNCIA POR TASK, achado A do review adversarial)
  // — nunca um `getTask`/`getReport`/`getTaskStatus` por task.
  function buildTaskBoard(boardId: string): TaskBoardItem[] {
    // DESIGN-BACKLOG.md §2.1 — live Fila shows the ACTIVE sprint only.
    // Closed-sprint done/failed stay on their old sprint_id; the selector
    // renders those from `snapshot_json`, never by re-querying live status.
    const activeSprint = store.getActiveSprint(boardId);
    const allOnBoard = store.listTasksByBoard(boardId);
    const tasks = activeSprint
      ? allOnBoard.filter((t) => t.sprint_id === activeSprint.id || !t.sprint_id)
      : allOnBoard;
    const lastActorByTask = new Map(store.listLastActorsForBoard(boardId).map((r) => [r.task_id, r.last_actor]));
    const cardsByTask = new Map<
      string,
      {
        cardId: string;
        role: string;
        kind: string | null;
        provider: string | null;
        model: string | null;
        effort: string | null;
        label: string | null;
        orphan: boolean;
      }[]
    >();
    for (const tc of store.listTaskCardsForBoard(boardId)) {
      const list = cardsByTask.get(tc.task_id) ?? [];
      list.push({
        cardId: tc.card_id,
        role: tc.role,
        kind: tc.card_kind,
        provider: tc.card_provider,
        model: tc.card_model,
        effort: tc.card_effort,
        label: tc.card_label,
        orphan: tc.card_orphaned === 1,
      });
      cardsByTask.set(tc.task_id, list);
    }
    const reportByCardId = new Map(store.listReportsForBoard(boardId).map((r) => [r.card_id, r]));
    // RODADA 2 — mesma convenção de parse que message-bus.ts's
    // onTaskDone já usa pra este mesmo campo (`deps_json ?
    // JSON.parse(...) : []`, sem try/catch): só este código escreve essa
    // coluna, sempre via JSON.stringify, então não há formato estranho a
    // se defender de.
    const depsByTask = new Map<string, string[]>(tasks.map((t) => [t.id, t.deps_json ? JSON.parse(t.deps_json) : []]));
    // RODADA 3 (review adversarial da rodada 2, achado A) — coleta a UNIÃO
    // de toda dependência referenciada por QUALQUER task do board primeiro,
    // resolve todas de uma vez (`getTaskStatusesByIds`, uma consulta só),
    // e só DEPOIS fatia por task (JS puro, sem custo de banco algum) —
    // nunca mais uma consulta por dependência por task.
    const allDepIds = new Set<string>();
    for (const deps of depsByTask.values()) for (const d of deps) allDepIds.add(d);
    const depStatusById = store.getTaskStatusesByIds([...allDepIds]);
    const depPurposeById = store.getTaskPurposesByIds([...allDepIds]);
    // Fidelidade visual ao protótipo v5, delta 6 (trilha de transição) —
    // mesma consulta (uma por board inteiro, `JOIN`, sem N+1) que o
    // gráfico 3 já usava só quando o painel abria; anexada aqui, em TODA
    // task, em todo push.
    const transitionsByTask = new Map<string, { toValue: string; fromValue: string | null; at: number }[]>();
    for (const row of store.listStatusTransitionsForBoard(boardId)) {
      const list = transitionsByTask.get(row.task_id) ?? [];
      list.push({ toValue: row.to_value, fromValue: row.from_value, at: row.at });
      transitionsByTask.set(row.task_id, list);
    }
    // RODADA 4 — vereditos + firstActor (pílulas / gráficos / aviso de
    // task humana pega). Duas consultas por board, mesmo padrão do resto.
    const verdictsByTask = new Map<
      string,
      { cardId: string; role: string; verdict: string | null; at: number; provider: string | null }[]
    >();
    for (const row of store.listVerdictsForBoard(boardId)) {
      const list = verdictsByTask.get(row.task_id) ?? [];
      list.push({
        cardId: row.card_id,
        role: row.role,
        verdict: row.verdict,
        at: row.at,
        provider: row.card_provider,
      });
      verdictsByTask.set(row.task_id, list);
    }
    const firstActorByTask = new Map(store.listFirstActorsForBoard(boardId).map((r) => [r.task_id, r.first_actor]));
    return tasks.map((t) => {
      const report = t.card_id ? reportByCardId.get(t.card_id) : undefined;
      const deps = depsByTask.get(t.id) ?? [];
      const depStatuses: Record<string, string> = {};
      const depPurposes: Record<string, TaskPurpose | null> = {};
      for (const depId of deps) {
        const s = depStatusById[depId];
        if (s !== undefined) depStatuses[depId] = s;
        if (Object.prototype.hasOwnProperty.call(depPurposeById, depId)) {
          depPurposes[depId] = normalizeTaskPurpose(depPurposeById[depId]);
        }
      }
      const cardAlive = t.card_id ? registry.isAlive(t.card_id) : false;
      const lastActor = lastActorByTask.get(t.id) ?? null;
      const effectiveStatus = deriveTaskStatus(t.status, cardAlive);
      const { divergedStatus, divergedActor } = deriveParticipationDivergence({
        storedStatus: t.status,
        effectiveStatus,
        lastStatusActor: lastActor,
        existingDivergedStatus: t.diverged_status,
        existingDivergedActor: t.diverged_actor,
      });
      return {
        id: t.id,
        prompt: t.prompt,
        provider: t.provider,
        status: effectiveStatus,
        cardId: t.card_id,
        boardId: t.board_id,
        order: t.order,
        suggestedOrder: t.suggested_order,
        implicitOrder: t.implicit_order,
        retryCount: t.retry_count,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        lastActor: lastActorByTask.get(t.id) ?? null,
        cards: cardsByTask.get(t.id) ?? [],
        report: report ? { verdict: (report.verdict ?? null) as "aprovado" | "reprovado" | null, updatedAt: report.updated_at } : null,
        deps,
        depStatuses,
        purpose: normalizeTaskPurpose(t.purpose),
        review: normalizeTaskReview(t.review),
        depPurposes,
        // Fidelidade visual ao protótipo v5, delta 4 — `registry.isAlive`
        // é uma consulta a um Map em memória (pty-registry.ts), O(1),
        // então uma chamada por task aqui não é o N+1 que o comentário
        // antigo de `TaskCard.tsx`'s `alive` temia (aquele custo seria
        // real pra uma leitura de PTY de verdade, não pra uma checagem de
        // Map). `false` quando não há card vinculado.
        cardAlive,
        statusTransitions: transitionsByTask.get(t.id) ?? [],
        // DESIGN-BACKLOG.md §2.1 Decisão 8 — sinal vivo no push
        // `task:changed` (canal do quadro; o aviso ao agente vai por
        // typeAndSubmit + envelope MCP). Derived on read (CAMADA 3).
        divergedStatus,
        divergedActor,
        requestedStatus: t.requested_status ?? null,
        requestedReason: t.requested_reason ?? null,
        requestedBy: t.requested_by ?? null,
        requestedAt: t.requested_at ?? null,
        verdicts: verdictsByTask.get(t.id) ?? [],
        firstActor: firstActorByTask.get(t.id) ?? null,
        interruptionReason: interruptionReasonFromResultJson(t.result_json),
      };
    });
  }
  function notifyTaskChanged(boardId: string | null) {
    if (!boardId || boardId !== activeBoardId) return;
    safeSend(win, "task:changed", boardId, buildTaskBoard(boardId));
  }
  // RODADA 3, peça 5 — rodapé de escopo (`board X · N tasks · M em outros
  // boards`). GLOBAL (nunca filtrado por `activeBoardId`, ao contrário de
  // `notifyTaskChanged` acima): a contagem de OUTROS boards precisa
  // atualizar mesmo quando a task que mudou não é do board aberto —
  // mesma convenção sem filtro que `onQueueChanged` já usa (index.ts, ver
  // seu próprio comentário). Barato mesmo sem filtro: uma única consulta
  // `GROUP BY`, chamada no máximo uma vez por gravação de task, nunca por
  // render.
  function notifyTaskScopeChanged() {
    safeSend(win, "task-board-scope:changed", store.taskCountsByBoard());
  }

  // ---------------------------------------------------------------------
  // Fiação da fatia 3b (task ab83ba5f): o push da Fila passa a avisar por
  // JANELA em vez de por escrita.
  //
  // MEDIDO antes disto (seq 509): cada push custa 3,75ms de SQLite + 1,48MB
  // de JSON, e as escritas são BIMODAIS — 153 de 217 intervalos numa hora
  // são de 0ms (mesmo milissegundo) e o resto são dezenas de segundos.
  // Coalescer a rajada corta a maior parte dos pushes sem atrasar nada
  // perceptível (janela de 200ms; 100/250/500 medidos dão o mesmo
  // resultado, então a escolha da janela não é crítica).
  //
  // O CONTRATO do coalescer está em tests/unit/notify-coalescer.test.ts —
  // inclusive o que importa aqui: `close()` FLUSHA o pendente, nunca limpa
  // o timer sem entregar (é o único jeito de este conserto virar perda de
  // dado). Esta fiação não cria NENHUM outro caminho que desarme o timer:
  // só `close()` o toca, e `close()` entrega.
  //
  // `deliver` recebe a CHAVE e reconstrói o estado AGORA (não um payload
  // congelado no aviso): o push nunca carrega retrato velho, e um board que
  // deixou de ser o ativo entre o aviso e a entrega é corretamente ignorado
  // pelo próprio `notifyTaskChanged`.
  // ---------------------------------------------------------------------
  const TASK_NOTIFY_WINDOW_MS = 200;
  const taskNotifyCoalescer = createNotifyCoalescer({
    windowMs: TASK_NOTIFY_WINDOW_MS,
    // A chave é o board. `""` é o aviso SEM board (task com `board_id`
    // null ainda precisa atualizar o rodapé de escopo, que é global) — e
    // `notifyTaskChanged` já ignora vazio, então só o rodapé sai.
    deliver: (key) => {
      notifyTaskChanged(key || null);
      notifyTaskScopeChanged();
    },
  });

  // Choke point único pra toda gravação de task (agente via MCP/acbridge,
  // motor interno de retry/auto-dispatch, OU os três gestos humanos da
  // Fila abaixo) — `store.upsertTask` já grava a transição (actor chega
  // dentro do próprio `task`, ver seu comentário grande em store.ts); o
  // funil empurra o board pra quem estiver com ele aberto, o rodapé de
  // escopo de todo mundo, e — a partir da `StatusWriteDecision` que o
  // store devolveu, nunca do que o chamador quis gravar — avisa o motor
  // de dependentes quando a task de fato CHEGOU em `done`. Antes
  // (2026-09-13) essa detecção morava só dentro de `update_task` no bus:
  // aprovar por botão, arrastar pra "concluído" e Allow no modal gravavam
  // `done` sem ninguém observar. Ver task-write-funnel.ts.
  //
  // `persistColumnDrop` — DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 (review
  // adversarial rodada 3, achado 2): um único gesto de arraste pode gravar
  // MAIS de uma task (a arrastada + vizinhas que materializam
  // `implicit_order`, ver `computeColumnDrop`); `store.applyColumnDrop` é
  // uma `db.transaction` e o push acontece UMA vez depois dela.
  const { persistTask, persistColumnDrop } = createTaskWriteFunnel({
    upsertTask: (task) => store.upsertTask(task),
    applyColumnDrop: (dragged, siblings) => store.applyColumnDrop(dragged, siblings),
    afterWrite: (boardId) => {
      // Fatia 3b (ab83ba5f): aviso por JANELA, não por escrita. O board vai
      // como chave (o rodapé de escopo sai junto na entrega).
      taskNotifyCoalescer.notify(boardId ?? "");
    },
    // `messageBus` é criado logo abaixo com `persistTask` como callback —
    // lookup por chamada, não captura, por isso o optional chaining.
    onTaskDone: (taskId) => messageBus?.onTaskDone(taskId),
  });

  messageBus = createMessageBus(sockPath, {
    // Achado ao vivo (2026-09-01): o `.filter(kind === "terminal")` que
    // ficava aqui é o que fazia um agente responder "list_cards doesn't
    // surface browser cards — I need the card ID". Todo card vivo aparece
    // agora; quem precisa mesmo de um PTY filtra do lado do bus
    // (`listTerminalCards`, message-bus.ts), que é onde a restrição de
    // fato existe. `label` vai junto pra `resolveTargetId` poder aceitar o
    // nome que o humano deu ao card como alvo.
    listCards: () => {
      const cards = store
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
        .filter((c) => c.board_id === activeBoardId);
      return cards.map((c) => {
        const base = { id: c.id, kind: c.kind, label: c.label, displayName: cardDisplayName(c, cards) };
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
      });
    },
    writeToCard: (id, text) => registry.write(id, text, "delivery"),
    writeToCardWithOrigin: (id, text, origin) => registry.write(id, text, origin),
    beginCardDelivery: (id) => registry.beginDelivery(id),
    endCardDelivery: (id) => registry.endDelivery(id),
    isCardAlive: (id) => registry.isAlive(id),
    getCardLastActivityAt: (id) => registry.getLastActivityAt(id),
    getCardWriteReadiness: (id) => registry.getWriteReadiness(id),
    // Prototipo (2026-09-06) — ver message-bus.ts's doc comment no cmd
    // `turn_complete`. Push simples pro renderer, mesmo padrão de
    // `pty:session-found`/`pty:data` abaixo — nenhum estado novo aqui no
    // main, só relay.
    notifyTurnComplete: (cardId) => {
      safeSend(win, "pty:turn-complete", cardId);
    },
    // O FATO DE TURNO (task 4245c6f5) — leitura e escrita do registry, para
    // `card_status` parar de deduzir trabalho de bytes. Fica ao lado do
    // relay acima de propósito: mesmo sinal, dois destinos, e o doc comment
    // de lá ("nenhum estado novo aqui no main") deixou de valer para o
    // fato — o push continua sendo só UI.
    getCardTurnEndedAt: (cardId) => registry.getTurnFacts(cardId)?.turnEndedAt ?? null,
    getCardLastWorkGrantedAt: (cardId) => registry.getLastWorkGrantedAt(cardId),
    markCardTurnComplete: (cardId) => registry.markTurnComplete(cardId),
    // Activity bar — send_to_card writes the body from main, outside
    // the renderer's xterm onData hook. Same channel shape as
    // `pty:turn-complete`: fire-and-forget, keyed by card/PTY id.
    // `useTerminal.ts` applies the existing `"input"` event.
    notifyCardInput: (cardId) => {
      safeSend(win, "pty:turn-input", cardId);
    },
    // Bug real relatado (Pop!_OS, 2026-09-09) — ver o comentário do
    // `server.on("error")` em message-bus.ts. Mesmo padrão fire-and-forget
    // de `notifyTurnComplete` acima: relay simples pro renderer via
    // `safeSend`, nenhuma UI construída aqui (fora de escopo desta
    // correção) — só torna o estado observável em vez de silencioso.
    notifyBusUnavailable: (message) => {
      safeSend(win, "acbridge:unavailable", message);
    },
    getBuildIdentity: () => currentBuildIdentity(),
    // DESIGN-BACKLOG.md §2.1 "identidade e descoberta de card", ponto 1 —
    // delega pra `deriveCardDisplayName` (shared/card-identity.ts), a
    // ÚNICA fonte agora — usada aqui (notificações, prefixo de
    // `send_to_card`) e por `list_cards` (dispatchRequest's cmd "list",
    // message-bus.ts) igual, e pelo header de cada card no renderer
    // (App.tsx's `describeCard`, mesmo módulo). Antes desta unificação,
    // esta função tinha o próprio ramo de ordinal SEM checar
    // `kind === "terminal"` primeiro — qualquer card non-terminal
    // (`card.provider === ""` pra quase todo kind) produzia um `" 1°"`
    // quebrado; achado ao comparar contra a versão correta que o renderer
    // já tinha (`describeCard`, que sempre checou o kind).
    describeCardLabel: (cardId) => {
      const card = store.getCard(cardId);
      if (!card) return `card #${cardId}`;
      return cardDisplayName(card, store.listCards(card.board_id));
    },
    getCardBoardId: (id) => store.getCard(id)?.board_id ?? recentlyClosedCardBoardIds.get(id),
    /** Active board in the live window — fallback for anonymous MCP
     * callers (no `?card=` stamp) that still spawn onto the open board.
     * Media asset copies need a board id even when identity is blank. */
    getActiveBoardId: () => activeBoardId ?? undefined,
    // DESIGN-BACKLOG.md §2.1 "Fila" — unlike `listCards`, this lookup is
    // explicitly board-scoped and store-backed, so an MCP request cannot
    // mistake a queue on another board for the current one. `listCards`
    // already excludes archived rows; archived task cards therefore do not
    // occupy the singleton slot.
    listCardsForBoard: (boardId) =>
      store.listCards(boardId).map((card) => ({
        id: card.id,
        boardId: card.board_id,
        kind: card.kind,
        archivedAt: card.archived_at,
      })),
    isBoardAutonomous: (boardId) => store.getBoard(boardId)?.autonomous ?? false,
    getBoardOrchestratorCardId: (boardId) => store.getBoard(boardId)?.orchestrator_card_id ?? null,
    // RODADA 4 — ver o comentário grande da entrada `boardExists` na
    // interface de callbacks (message-bus.ts).
    boardExists: (boardId) => store.getBoard(boardId) !== undefined,
    getBoardConcurrencyCap: (boardId) => store.getBoard(boardId)?.concurrency_cap ?? null,
    // Pendentes #188 ("delete_card"/"update_card_content") — direct store
    // access, same as getCardBoardId above, for a card that may not be on
    // whichever board is currently loaded.
    getAnyCard: (id) => {
      const row = store.getCard(id);
      return row
        ? {
            boardId: row.board_id,
            kind: row.kind,
            provider: row.provider ?? null,
            model: row.model ?? null,
            effort: row.effort ?? null,
            resume_id: row.resume_id ?? null,
          }
        : undefined;
    },
    deleteCardDirect: (id) => {
      store.deleteConnectorsForCard(id);
      store.deleteCard(id);
    },
    updateStickyContentDirect: (id, content, mode) => {
      const row = store.getCard(id);
      if (!row) return { ok: false, error: `no card with id "${id}"` };
      // toRow's convention (App.tsx) — a sticky's content lives in the
      // generic `cwd` column, no schema of its own.
      const next = mode === "append" ? (row.cwd ?? "") + content : content;
      store.upsertCard({ ...row, cwd: next, updated_at: Date.now() });
      return { ok: true, content: next };
    },
    countRunningAgentsOnBoard: (boardId) =>
      store
        .listCards(boardId)
        .filter((c) => c.kind === "terminal" && c.provider !== "bash" && registry.isAlive(c.id)).length,
    listTasks: () => store.listTasks(),
    // DESIGN-BACKLOG.md §2.1 item 6 — the indexed counterpart, wired now
    // that this file is no longer locked by another agent's work.
    listTasksByBoard: (boardId) => store.listTasksByBoard(boardId),
    // PERF (task c9db1d86) — the `view:"summary"` counterparts. Both are
    // declared REQUIRED in message-bus.ts's callbacks type, so `tsc` refuses
    // a wiring that forgets one instead of letting `list_tasks view:"summary"`
    // silently fall back to the full SELECT. Deliberately explicit rather
    // than folded into the two lambdas above: those take no argument, so an
    // optional `view` parameter on the existing signature would be swallowed
    // here without a single type error — the exact silent no-op this pair
    // exists to avoid.
    listTasksSummary: () => store.listTasksSummary(),
    listTasksSummaryByBoard: (boardId) => store.listTasksSummaryByBoard(boardId),
    // PERF (task 9dd877c8) — minimal row for the 5s idle scan
    // (`scanIdleWithoutReport`), which was reading the whole table to use
    // `card_id` and `status`. Same "required, so tsc forces the wiring"
    // reasoning as the pair above.
    listTasksForIdleScan: () => store.listTasksForIdleScan(),
    getTask: (id) => store.getTask(id),
    // Fase 2, peça 2 — era `store.upsertTask(task)` direto; `persistTask`
    // (funil acima) é o MESMO efeito mais o push pro board aberto e a
    // detecção de `done` → `onTaskDone`. Cobre TODO caminho que já passava
    // por aqui: `create_task`/`update_task` (MCP), o motor de auto-dispatch
    // (`dispatchIfUnblocked`/`markTaskFailed`, message-bus.ts) e os três
    // gestos humanos da Fila abaixo (aprovar, arrastar, Allow). O bus NÃO
    // chama `onTaskDone` por conta própria depois de `update_task` — seria
    // a segunda cópia da regra que este funil elimina.
    upsertTask: (task) => persistTask(task),
    // Fora da fatia 3b-2 de propósito (ab83ba5f): interação HUMANA olhando a
    // tela. 200ms seria invisível, mas a economia grande e MEDIDA mora nos
    // sites de report/veredito — não misturar as duas coisas.
    setStatusAsk: (taskId, ask) => {
      const result = store.setStatusAsk(taskId, ask);
      const row = store.getTask(taskId);
      if (row) notifyTaskChanged(row.board_id);
      return result;
    },
    // SPRINTS FICAM IMEDIATOS de propósito (fatia 3b-2, deliberadamente fora):
    // estes sites também disparam `onSprintsChanged` — canal DIFERENTE do
    // `task:changed` — e o coalescer atrasa só `task:changed` + o rodapé de
    // escopo. Coalescer estas três linhas sem separar os canais engoliria o
    // aviso de sprint junto. Não "termine o trabalho" por simetria: se um dia
    // valer, o canal de sprint precisa ser tratado em separado.
    listSprints: (boardId) => store.listSprints(boardId),
    openSprint: (boardId) => store.openSprint(boardId),
    closeSprint: (boardId) => {
      const result = store.closeSprint(boardId, (id) => registry.isAlive(id));
      if (result.ok) notifyTaskChanged(boardId);
      return result;
    },
    renameSprint: (sprintId, name) => store.renameSprint(sprintId, name),
    deleteSprint: (sprintId) => {
      const result = store.deleteSprint(sprintId);
      if (result.ok) notifyTaskChanged(result.deleted.board_id);
      return result;
    },
    onSprintsChanged: (boardId) => {
      if (!win || boardId !== activeBoardId) return;
      safeSend(win, "task-sprints:changed", boardId);
    },
    // DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" — direct
    // store pass-through, mesmo padrão das 3 linhas de tasks acima.
    getReport: (cardId, afterSeq) => store.getReport(cardId, afterSeq),
    // Fase 2, peça 4 — um relatório novo pode fazer a task PROPOR conclusão
    // (barra de "aprovado") sem que `status` mude nenhum bit — só gravar
    // (`store.upsertReport`, intocado) não bastava, o board aberto
    // também precisa saber. Mesmo scan por `card_id` que
    // `resolveCardExit` (message-bus.ts) já faz pra achar a task de um
    // card — não um novo padrão de custo.
    upsertReport: (row) => {
      // Fatia 3b-2 (ab83ba5f) — este é um dos 92% do volume medido (288
      // vereditos + 40 reports numa hora contra 24 carimbos do funil): o
      // MESMO aviso para a MESMA Fila, agora por janela.
      store.upsertReport(row);
      const task = store.listTasks().find((t) => t.card_id === row.card_id);
      if (task?.board_id) taskNotifyCoalescer.notify(task.board_id);
    },
    nextReportSeqSeed: () => store.nextReportSeqSeed(),
    // DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" —
    // UI do quadro agora consome `task_verdicts` (pílulas + gráficos 1/2),
    // então o push precisa rodar DEPOIS da gravação — o `upsertReport`
    // logo acima notifica ANTES desta linha no fluxo de `report`, e
    // sem este notify o push sai sem a rodada nova.
    recordParticipationRound: (cardId, verdict, at) => {
      const written = store.recordParticipationRound(cardId, verdict, at);
      const seen = new Set<string>();
      for (const row of written) {
        if (seen.has(row.task_id)) continue;
        seen.add(row.task_id);
        const task = store.getTask(row.task_id);
        // A CHAVE É O BOARD, não a task — e é isso que faz este laço valer
        // a pena: ele pode visitar N tasks, mas N tasks do mesmo board
        // viram UMA janela e UMA entrega. Trocar a chave por `task_id`
        // trocaria 288 pushes/h por 288 janelas/h, ou seja nada.
        if (task?.board_id) taskNotifyCoalescer.notify(task.board_id);
      }
    },
    listTaskCardsForCard: (cardId) => store.listTaskCardsForCard(cardId),
    // CAMADA 4 — judgment write gate on update_task needs the task-side
    // dump (role of requester on THIS task), not the card-side live filter.
    getTaskCards: (taskId) => store.getTaskCards(taskId),
    // `task_cards.role` explicit write (`spawn_agent role` /
    // `link_task_card`). Same push `persistTask` does: the Fila derives
    // the ` ↔ review` arrow from these rows, so it must see the new one
    // without a reload.
    linkTaskCard: (taskId, cardId, role, profile) => {
      store.linkTaskCard(taskId, cardId, role, profile);
      const pending = pendingParticipationSessions.get(cardId);
      if (pending) {
        store.setParticipationSessionId(cardId, pending);
        pendingParticipationSessions.delete(cardId);
      }
      const task = store.getTask(taskId);
      // Fatia 3b-2 (ab83ba5f): com o link, o mesmo aviso por janela.
      if (task) taskNotifyCoalescer.notify(task.board_id ?? "");
    },
    listAllConnectors: () => store.listAllConnectors(),
    recordSpawn: (input) => store.recordSpawn(input),
    findSpawnByChild: (toCardId) => store.findSpawnByChild(toCardId),
    listSpawnsByParent: (fromCardId) => store.listSpawnsByParent(fromCardId),
    // A lacuna que este comentário descrevia (2026-09-09: `set_connector_kind`
    // gravava no banco e não avisava ninguém, então um board aberto só via
    // o `kind` novo depois de recarregar) foi FECHADA em 2026-09-10 —
    // `onConnectorKindChanged` logo abaixo, espelhando o push do `label`.
    setConnectorKind: (id, kind) => store.setConnectorKind(id, kind),
    setConnectorLabel: (id, label) => store.setConnectorLabel(id, label),
    getConnectorBoardId: (id) => store.getConnectorBoardId(id),
    // Live push so an already-open board's pill updates without reload.
    // Achado 2 (review adversarial, 2026-09-09) — scoped to the OPEN board
    // before sending, same `board_id === activeBoardId` filter `listCards`
    // above already applies for reads; without it, an agent updating a
    // connector's label on a background board pushed straight into
    // whichever board the renderer happens to have open right now, which
    // just silently drops it by id (harmless-looking, but the wrong
    // board's IPC traffic for no reason). This is genuinely new here — no
    // OTHER push in this file (`pty:data` included) filters by
    // `activeBoardId` today; that's this file's existing pattern for
    // reads, not an established convention for pushes, so this is the
    // first one, not a copy of one.
    onConnectorLabelChanged: (id, label, boardId) => {
      if (boardId !== activeBoardId) return;
      safeSend(win, "connector:label-changed", id, label);
    },
    // Irmão do push acima, mesmo filtro de board aberto pelo mesmo motivo
    // (um agente mexendo em conector de board de fundo não deve gerar
    // tráfego de IPC pro board que está na tela, que só descartaria por id).
    onConnectorKindChanged: (id, kind, boardId) => {
      if (boardId !== activeBoardId) return;
      safeSend(win, "connector:kind-changed", id, kind);
    },
    onOpenRequest: (requestId, requesterId, url, reason, autoApprove) =>
      safeSend(win, "browser:ask-open", requestId, requesterId, url, reason, autoApprove),
    onCloseCardRequest: (requestId, requesterId, target, reason, autoApprove) =>
      safeSend(win, "card:ask-close", requestId, requesterId, target, reason, autoApprove),
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
    prepareMediaAsset: (boardId, sourcePath) => copyBoardAssetFromPath(boardId, sourcePath),
    // DESIGN-BACKLOG.md item 60, peça 1 — live push so a queue panel never
    // has to poll; same safeSend guard as every other main→renderer event.
    onQueueChanged: (boardId, queue) => safeSend(win, "spawn-queue:changed", boardId, queue),
    // Regra geral de auto-conector (2026-09-02) — ver message-bus.ts's
    // doc comment na interface de callbacks.
    onAutoConnect: (fromCardId, toCardId, kind, label) =>
      safeSend(win, "connector:auto", fromCardId, toCardId, kind, label),
  });
  ipcMain.handle("browser:get-page-text", (_e, id: string) => browserRegistry.getPageText(id));
  // Achado ao vivo, 2026-09-03 — "aviso antes mesmo de abrir um agente":
  // o Topbar consulta isto uma vez ao entrar num board, ANTES de qualquer
  // spawn de card, pra avisar de cara quais CLIs faltam instalar (ver
  // Topbar.tsx/useAgentAvailability.ts). Substitui o antigo aviso que só
  // aparecia DEPOIS de tentar (e falhar) spawnar o card — quebrava o
  // fluxo (removido de TerminalCard.tsx/useTerminal.ts).
  // A PROJEÇÃO DA CAPACIDADE (2026-09-20) — o renderer NÃO recebe
  // `capacity`, e por isso cada fato de capacidade que a UI precisa virava
  // uma SEGUNDA TABELA hardcoded do lado de lá: `card-types.ts`'s
  // PROVIDER_EFFORT_VALUES era `capacity.effort.values` de claude e
  // antigravity copiado valor por valor (e exigiu sincronização à mão quando
  // o antigravity mudou de faixa em 2026-09-12), enquanto cline e
  // commandcode declaram as suas e a UI não oferecia nenhuma.
  //
  // O que se projeta é o que a UI CONSOME, com nome próprio — nunca o
  // `capacity` inteiro, que acoplaria o renderer ao formato interno do spec
  // e vazaria campos que só o main usa (role, mcp, delivery, session…).
  //
  // `effortValues`: os valores oferecíveis, na ORDEM DECLARADA (as
  // declarações são escritas do menor para o maior; um `Set`/`sort` aqui
  // perderia isso). Vazio = o provider não declara esforço (`bash`, cursor,
  // codex) e a UI simplesmente NÃO oferece o controle — ausência nunca vira
  // um select vazio. É o único campo projetado hoje; o fim de turno (B1) e o
  // prompt de sistema (B3) entram por este mesmo caminho quando as decisões
  // deles forem tomadas — não antes, para não projetar campo sem consumidor.
  ipcMain.handle("agents:check-availability", () =>
    checkAgentAvailability().map((agent) => ({
      ...agent,
      effortValues: projectEffortValues(providerById(agent.id)?.capacity.effort),
    })),
  );
  ipcMain.handle("spawn:agent-resolve", (_e, requestId: string, result: { ok: true; cardId: string } | { ok: false; error: string }) =>
    messageBus!.resolveSpawnAgent(requestId, result),
  );
  ipcMain.handle("spawn:card-resolve", (_e, requestId: string, result: { ok: true; cardId: string } | { ok: false; error: string }) =>
    messageBus!.resolveSpawnCard(requestId, result),
  );
  ipcMain.handle("card:close-resolve", (_e, requestId: string, allowed: boolean) => messageBus!.resolveCloseCard(requestId, allowed));

  ipcMain.handle(
    "pty:spawn",
    async (_e, id: string, providerId: string, cwd: string, cols: number, rows: number, opts?: SpawnOpts) => {
      // Reattach after renderer-gone reload: PTYs survive in main (React
      // cleanup never ran). Remount always calls spawn — without this
      // early return, a second process would orphan the survivor.
      if (registry.isAlive(id)) {
        return { id };
      }
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
      // Restore (and any spawn that omitted opts.taskId) re-reads the
      // store link: a card already amarrado to a task gets
      // AGENT_CANVAS_TASK_ID without inventing one. First spawn via
      // spawn_agent({ taskId }) / auto-dispatch still passes it in opts
      // because the link is written only after the card exists.
      const taskId = resolveDeclaredTaskId({
        explicit: opts?.taskId,
        primaryTaskIds: store.listTasks().filter((t) => t.card_id === id).map((t) => t.id),
        linkTaskIds: store.listTaskCardsForCard(id).map((l) => l.task_id),
      });
      const result = registry.spawn(id, providerId, cwd, cols, rows, { ...opts, taskId });
      if ("id" in result) remoteServer?.broadcastCards();
      return result;
    },
  );
  ipcMain.handle("pty:write", (_e, id: string, data: string, origin: "human" | "delivery" | "auto") => {
    if (origin !== "human" && origin !== "delivery" && origin !== "auto") return;
    registry.write(id, data, origin);
  });
  // Human Design Mode "Enviar" (BrowserCard) — same `cmd: "send"` that
  // `send_to_card` / `acbridge send` already use. Thin wire only; the
  // engine stays in message-bus.ts (`typeAndSubmit` / `deliverCard`).
  ipcMain.handle("bus:send", (_e, target: string, text: string) => {
    if (typeof target !== "string" || typeof text !== "string") {
      return { ok: false as const, error: "invalid send" };
    }
    return messageBus!.handleRequest({ cmd: "send", target, text });
  });
  // GlobalComposer.tsx polls this to turn a `send` receipt's `queued` into
  // a real delivered/parked/failed state in the UI — same `get_delivery`
  // bus cmd the MCP tool of the same name already reads, not a new fact.
  ipcMain.handle("bus:get-delivery", (_e, id: string) => {
    if (typeof id !== "string") return { ok: false as const, error: "invalid delivery id" };
    return messageBus!.handleRequest({ cmd: "get_delivery", id });
  });
  ipcMain.handle("pty:resize", (_e, id: string, cols: number, rows: number) => registry.resize(id, cols, rows));
  ipcMain.handle("pty:interrupt", (_e, id: string) => registry.interrupt(id));
  ipcMain.handle("pty:kill", (_e, id: string) => {
    registry.kill(id);
    remoteServer?.broadcastCards();
  });
  // Manual identify — one card, one click. Disk/CLI I/O stays in main
  // (`identifyCurrentSession`). The renderer only receives the result.
  // Optional `chooseId`: human picked among ambiguous candidates.
  ipcMain.handle("pty:identify-session", async (_e, id: string, chooseId?: string) => {
    if (typeof id !== "string" || id.length === 0) return { status: "unavailable" as const };
    const card = store.getCard(id);
    const gate = decideIdentifyCardGate(card);
    if (gate) return gate;
    const ownClaimedId = registry.getClaimedSessionId(id);
    const pid = registry.getPid(id) ?? undefined;
    if (typeof chooseId === "string" && chooseId.length > 0) {
      // Allowed set = every on-disk/CLI match for this cwd (no process
      // filter) — the pick came from that list in the footer.
      const listed = await identifyCurrentSession(card!.provider, card!.cwd, {});
      const allowed = listed.ids;
      return decideIdentifyChoiceApply(chooseId, allowed, isSessionIdClaimed, ownClaimedId);
    }
    const result = await identifyCurrentSession(card!.provider, card!.cwd, { pid });
    return decideIdentifyApply(result, isSessionIdClaimed, ownClaimedId);
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
      return { ok: false, error: t("error.imageTooLarge") };
    }
    return saveImageBytes(base64, mediaType);
  });
  ipcMain.handle("chat:read-attachment-image", (_e, path: string) => readAttachmentImage(path));
  // Anexo do composer GLOBAL (imagem OU documento) — mesma família, mesmo
  // diretório efêmero (`clipboard-image.ts`). O limite de tamanho vale aqui
  // pelo mesmo motivo do chat: quem sabe o custo de gravar é o main.
  ipcMain.handle("clipboard:save-attachment", (_e, base64: string, fileName: string, mediaType: string) => {
    if (typeof base64 !== "string" || typeof fileName !== "string" || typeof mediaType !== "string") {
      return { ok: false, error: t("error.attachmentBadRequest") };
    }
    if (base64.length > MAX_CHAT_ATTACHMENT_BASE64_CHARS) {
      return { ok: false, error: t("error.imageTooLarge") };
    }
    return saveAttachmentBytes(base64, fileName, mediaType);
  });

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
  ipcMain.handle("store:delete", (_e, id: string) => {
    rememberBoardIdBeforeDelete(id);
    return store.deleteCard(id);
  });

  ipcMain.handle("store:connectors:list", (_e, boardId: string) => store.listConnectors(boardId));
  ipcMain.handle("store:connectors:upsert", (_e, row: ConnectorRow) => store.upsertConnector(row));
  ipcMain.handle("store:connectors:delete", (_e, id: string) => store.deleteConnector(id));
  ipcMain.handle("store:connectors:delete-for-card", (_e, cardId: string) => store.deleteConnectorsForCard(cardId));
  // Human UI card birth — honest absence of reason/requester. Agent
  // spawns go through message-bus.recordSpawn instead.
  ipcMain.handle(
    "store:spawns:record-human",
    (
      _e,
      input: {
        boardId: string;
        toCardId: string;
        provider?: string | null;
        cardKind?: string | null;
        cwd?: string | null;
      },
    ) => {
      if (store.findSpawnByChild(input.toCardId)) return;
      store.recordSpawn({
        boardId: input.boardId,
        fromCardId: null,
        toCardId: input.toCardId,
        reason: null,
        provider: input.provider ?? null,
        cardKind: input.cardKind ?? null,
        cwd: input.cwd ?? null,
        origin: "human",
      });
    },
  );

  ipcMain.handle("store:favorites:list", () => store.listFavorites());
  ipcMain.handle("store:favorites:add", (_e, url: string, title: string) => store.addFavorite(url, title));
  ipcMain.handle("store:favorites:remove", (_e, url: string) => store.removeFavorite(url));

  ipcMain.handle("store:boards:list", () => store.listBoards());
  ipcMain.handle("store:boards:upsert", (_e, board: BoardRow) => store.upsertBoard(board));
  // `deleteBoard` reatribui as tasks do board pra `board_id = NULL` antes de
  // remover a linha (ver seu comentário em store.ts), e isso MUDA as
  // contagens por board — mas `notifyTaskScopeChanged` só era chamado de
  // `persistTask`, que não participa deste caminho. Sem o empurrão aqui, o
  // rodapé de escopo fica com o número velho (contando um board que não
  // existe mais) até a próxima gravação de task qualquer. Achado de review
  // adversarial da fase 2 do card task (2026-09-11).
  ipcMain.handle("store:boards:delete", (_e, id: string) => {
    store.deleteBoard(id);
    notifyTaskScopeChanged();
  });
  // DESIGN-BACKLOG.md item 14 — Home's "último acesso".
  ipcMain.handle("store:boards:touch", (_e, id: string, at: number) => store.touchBoard(id, at));
  // DESIGN-BACKLOG.md item 59 — the only IPC channel that can flip
  // `boards.autonomous`. Reachable only from real renderer UI code
  // (App.tsx's session UI), never from message-bus.ts/mcp-server.ts —
  // there is no `BusRequest` cmd that touches this at all, on purpose.
  ipcMain.handle("store:boards:set-autonomous", (_e, id: string, autonomous: boolean) => store.setBoardAutonomous(id, autonomous));
  // Board orchestrator mark — UI-only, same narrow write path guarantee
  // as set-autonomous. Never reachable from message-bus/mcp-server.
  ipcMain.handle("store:boards:set-orchestrator-card", (_e, boardId: string, cardId: string | null) =>
    store.setBoardOrchestratorCardId(boardId, cardId),
  );
  // Achado ao vivo (2026-09-01) — ver `activeBoardId` e o callback
  // `listCards` acima. Puro estado de sessão: nada é persistido, e um
  // relançamento começa em `null` (a app sempre abre na Home).
  ipcMain.on("board:active", (_e, id: string | null) => {
    activeBoardId = id;
  });
  // DESIGN-BACKLOG.md item 60, peça 2 — same shape/guarantee as
  // set-autonomous above: only real renderer UI reaches this, `cap: null`
  // means "back to the global default", never zero.
  ipcMain.handle("store:boards:set-concurrency-cap", (_e, id: string, cap: number | null) => {
    const result = store.setBoardConcurrencyCap(id, cap);
    // Sticky item "Fila de concorrência quebrada", achado 1 — sem isso,
    // subir o cap num board com fila nunca reavaliava nada até o timeout
    // de 10min da request enfileirada.
    messageBus?.notifyConcurrencyCapChanged(id);
    return result;
  });
  ipcMain.handle("store:card-counts", () => store.cardCounts());
  ipcMain.handle("store:next-id-seed", () => store.nextIdSeed());
  // Item 30 — sessions sidebar (every chat card, live or archived) +
  // archive/unarchive (closing a ChatCard archives instead of deleting).
  ipcMain.handle("store:list-chat-sessions", () => store.listChatSessions());
  ipcMain.handle("store:archive-card", (_e, id: string) => store.archiveCard(id, Date.now()));
  ipcMain.handle("store:unarchive-card", (_e, id: string) => store.unarchiveCard(id));

  // DESIGN-BACKLOG.md §2.1 Fase 2 — o quadro de tasks é o primeiro
  // consumidor no renderer de `tasks`/`task_transitions`/`task_cards`
  // (Fase 1 só tinha MCP/acbridge). Carga inicial/troca de board (o push
  // `task:changed` acima cobre toda mudança POSTERIOR a este board estar
  // aberto).
  ipcMain.handle("store:tasks:list-by-board", (_e, boardId: string) => buildTaskBoard(boardId));
  // DESIGN-BACKLOG.md §2.1 decisões 8/9 — "o app NUNCA marca concluído
  // sozinho": isto é o botão que aceita a PROPOSTA que um `report{verdict:
  // "aprovado"}` já fez (peça 4's barra), nunca um caminho automático —
  // só existe porque um humano clicou. `actor: "human"` grava a transição
  // como tal (mesma decisão 8: "quem decide é o humano").
  ipcMain.handle("store:tasks:approve-completion", (_e, taskId: string) => {
    const existing = store.getTask(taskId);
    if (!existing) return { ok: false, error: `no such task "${taskId}"` };
    persistTask({ ...existing, status: "done", updated_at: Date.now(), actor: "human" });
    return { ok: true };
  });
  // Third path — human Allow/Deny on the Fila task-detail modal. Allow is
  // a human status write (decision 8 rule 4: apply + clear divergence +
  // retainStatusAsk clears the ask). Deny drops only the ask.
  ipcMain.handle("store:tasks:respond-status-ask", (_e, taskId: string, allowed: boolean) => {
    const existing = store.getTask(taskId);
    if (!existing) return { ok: false, error: `no such task "${taskId}"` };
    const requested = existing.requested_status;
    if (!requested) return { ok: false, error: "no pending status ask" };
    const requesterId = existing.requested_by;
    if (allowed) {
      let result_json = existing.result_json;
      if (requested === "failed" && existing.status !== "failed") {
        result_json = stampFailureKindJson(result_json, decideFailureKind("explicit_failed"));
      }
      persistTask({ ...existing, status: requested, result_json, updated_at: Date.now(), actor: "human" });
    } else {
      // Fora da fatia 3b-2: gesto humano (limpar o pedido de status) — mesmo
      // motivo do `setStatusAsk` no bus, logo acima.
      store.setStatusAsk(taskId, null);
      notifyTaskChanged(existing.board_id);
    }
    // Resume of a request the agent made (`request_task_status`) — not an
    // unsolicited interrupt. Truth is already on the task; this push is the
    // fallback until a programmatic wait/poll exists. Delivery goes through
    // `enqueueCardDelivery` with steer:true (0b728f1): same as send_to_card,
    // so a mid-turn park injects once instead of sitting in follow-ups.
    if (requesterId) {
      messageBus?.notifyHumanMovedTask(requesterId, describeStatusAskResolved(requested, allowed));
    }
    return { ok: true };
  });
  // RODADA 4 — criar task pela UI do quadro (coluna "a fazer"). NÃO passa
  // por message-bus/`create_task` de propósito: aquele caminho força
  // `actor: "agent"`. Aqui `actor: "human"` é deliberado — decisão 8 faz
  // o status nascer autoritativo (travado contra sobrescrita app/agente).
  ipcMain.handle("store:tasks:create", (_e, boardId: string, prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return { ok: false, error: "empty prompt" };
    if (!store.getBoard(boardId)) return { ok: false, error: `no such board "${boardId}"` };
    const now = Date.now();
    const id = randomUUID();
    persistTask({
      id,
      prompt: trimmed,
      provider: null,
      status: "pending",
      card_id: null,
      board_id: boardId,
      cwd: null,
      result_json: null,
      deps_json: null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: null,
      fallback_providers_json: null,
      order: null,
      suggested_order: null,
      implicit_order: null,
      diverged_status: null,
      diverged_actor: null,
      created_at: now,
      updated_at: now,
      actor: "human",
    });
    return { ok: true, taskId: id };
  });
  // Human edit of the stored briefing (Fila modal). Same append-default
  // / explicit-replace contract as MCP `update_task`, but `actor: "human"`
  // so a prompt write never looks like an agent status move. persistTask
  // pushes the board; it does not type into a live card.
  ipcMain.handle(
    "store:tasks:update-prompt",
    (_e, taskId: string, prompt: string, mode?: TaskPromptWriteMode) => {
      const existing = store.getTask(taskId);
      if (!existing) return { ok: false, error: `no such task "${taskId}"` };
      const resolved = mode ?? "append";
      if (resolved !== "append" && resolved !== "replace") {
        return { ok: false, error: `mode must be "append" or "replace"` };
      }
      const now = Date.now();
      const applied = applyTaskPromptWrite({ existing: existing.prompt, incoming: prompt, mode: resolved, at: now });
      if (!applied.ok) return applied;
      persistTask({
        ...existing,
        prompt: applied.prompt,
        updated_at: now,
        actor: "human",
        statusProposed: false,
      });
      return { ok: true, prompt: applied.prompt };
    },
  );
  // DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 — arrastar entre colunas/dentro
  // da coluna. Tudo já chega PRONTO do renderer (task-board-model.ts's
  // `COLUMN_TO_STATUS`/`computeColumnDrop` — decidir "pra onde"/"que
  // prioridade"/"quem mais precisa materializar posição" é lógica pura,
  // testada lá, nunca duplicada aqui).
  //
  // ACHADO DE REVIEW ADVERSARIAL (RODADA 3, achado 1, ALTO) — a rodada 2
  // gravava `order` em TODAS as tasks do lote (arrastada + vizinhas),
  // tornando as vizinhas PERMANENTEMENTE imunes a um `suggestedOrder`
  // futuro do agente. Fix: só `draggedTaskId` recebe `order`/`status`
  // (via `store.applyColumnDrop`'s primeira metade, a MESMA lógica de
  // `upsertTask`/transição de sempre) — `siblingImplicitOrders` grava
  // `implicit_order` (terceiro nível, nunca `order`) só pra quem
  // precisou virar comparável, sem tocar `status`/`order`/`suggested_order`
  // de ninguém.
  //
  // ACHADO DE REVIEW ADVERSARIAL (RODADA 3, achado 2, BAIXO-MÉDIO) — todo
  // o lote é atômico (`persistColumnDrop`/`store.applyColumnDrop`,
  // `db.transaction`) e gera UM push só, não um por linha.
  //
  // No PTY push on drag (2026-09-14): unsolicited interrupt into the work
  // card. Truth is on the task before this returns; the Fila shows the
  // human-move mark. Allow/Deny of a status ask is a different channel
  // (resume of a request) and keeps `notifyHumanMovedTask`.
  ipcMain.handle(
    "store:tasks:move",
    (
      _e,
      draggedTaskId: string,
      status: string,
      order: number,
      siblingImplicitOrders: { id: string; implicitOrder: number }[],
    ) => {
      const existing = store.getTask(draggedTaskId);
      if (!existing) return { ok: false, error: `no such task "${draggedTaskId}"` };
      // DESIGN-BACKLOG.md "Falha TIPADA" — human drag into "falhou" is
      // julgada (explicit judgment), never an interruption.
      let result_json = existing.result_json;
      if (status === "failed" && existing.status !== "failed") {
        result_json = stampFailureKindJson(result_json, decideFailureKind("explicit_failed"));
      }
      const dragged: TaskRow = { ...existing, status, order, result_json, updated_at: Date.now(), actor: "human" };
      persistColumnDrop(dragged, siblingImplicitOrders);
      return { ok: true };
    },
  );
  // RODADA 3, peça 5 — carga inicial do rodapé de escopo; `notifyTaskScopeChanged` acima cobre toda mudança POSTERIOR.
  ipcMain.handle("store:tasks:counts-by-board", () => store.taskCountsByBoard());
  // RODADA 3, peça 6 — gráfico 3 (tempo em cada estado). Deliberadamente
  // SEM push: fica atrás de um painel escondido por padrão, então buscado
  // só quando o humano abre o toggle (TaskCard.tsx) — nenhum custo
  // enquanto o painel não é aberto, ao contrário de `buildTaskBoard`
  // (rodada a cada gravação de task).
  ipcMain.handle("store:tasks:transitions-by-board", (_e, boardId: string) => store.listStatusTransitionsForBoard(boardId));
  // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — botão humano no card
  // Fila. `closeSprint` congela o snapshot no store; push avisa o card
  // pra recarregar a lista (não embute o payload — o painel já busca sob
  // demanda, mesmo padrão do gráfico 3).
  function serializeSprint(s: import("./store").SprintRow) {
    return {
      id: s.id,
      boardId: s.board_id,
      number: s.number,
      name: s.name,
      startedAt: s.started_at,
      closedAt: s.closed_at,
      countTodo: s.count_todo,
      countDoing: s.count_doing,
      countDone: s.count_done,
      countFailed: s.count_failed,
      migratedIn: s.migrated_in,
      migratedOut: s.migrated_out,
      hasSnapshot: s.snapshot_json != null,
    };
  }
  function notifySprintsChanged(boardId: string) {
    if (!win || boardId !== activeBoardId) return;
    safeSend(win, "task-sprints:changed", boardId);
  }
  ipcMain.handle("store:tasks:list-sprints", (_e, boardId: string) => store.listSprints(boardId).map(serializeSprint));
  ipcMain.handle("store:tasks:sprint-snapshot", (_e, sprintId: string) => {
    const row = store.getSprint(sprintId);
    if (!row) return { ok: false as const, error: `no such sprint "${sprintId}"` };
    if (row.closed_at == null) return { ok: false as const, error: "active sprint has no frozen snapshot — use the live board" };
    const tasks = store.getSprintSnapshot(sprintId);
    if (!tasks) return { ok: false as const, error: "sprint has no snapshot" };
    return {
      ok: true as const,
      sprint: serializeSprint(row),
      tasks: tasks.map((t) => ({
        id: t.id,
        prompt: t.prompt,
        status: t.status,
        order: t.order,
        suggestedOrder: t.suggested_order,
        implicitOrder: t.implicit_order,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    };
  });
  ipcMain.handle("store:tasks:close-sprint", (_e, boardId: string) => {
    const result = store.closeSprint(boardId, (id) => registry.isAlive(id));
    if (!result.ok) return result;
    notifyTaskChanged(boardId);
    notifySprintsChanged(boardId);
    return { ok: true as const, closed: serializeSprint(result.closed), opened: serializeSprint(result.opened) };
  });
  ipcMain.handle("store:tasks:open-sprint", (_e, boardId: string) => {
    const result = store.openSprint(boardId);
    if (!result.ok) return result;
    notifySprintsChanged(boardId);
    return { ok: true as const, sprint: serializeSprint(result.sprint) };
  });
  ipcMain.handle("store:tasks:rename-sprint", (_e, sprintId: string, name: string | null) => {
    const result = store.renameSprint(sprintId, name);
    if (!result.ok) return result;
    notifySprintsChanged(result.sprint.board_id);
    return { ok: true as const, sprint: serializeSprint(result.sprint) };
  });
  ipcMain.handle("store:tasks:delete-sprint", (_e, sprintId: string) => {
    const result = store.deleteSprint(sprintId);
    if (!result.ok) return result;
    notifyTaskChanged(result.deleted.board_id);
    notifySprintsChanged(result.deleted.board_id);
    return {
      ok: true as const,
      deleted: serializeSprint(result.deleted),
      restored: result.restored ? serializeSprint(result.restored) : null,
      movedTaskCount: result.movedTaskCount,
    };
  });

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

  // Human rail "Mídia": OS file dialog BEFORE any card exists. Cancel →
  // null (no ghost card, no toast). Accept → same validation as
  // `spawn_card kind:"media"` (`resolvePickedMediaFile` →
  // `decideSpawnMediaPath`); renderer still copies via board-assets.
  // Filters = MediaCard's real set only (PICK_MEDIA_EXTENSIONS).
  //
  // CDP cannot drive a native dialog — `fs:pick-media-file-test-next`
  // arms the NEXT `pick-media-file` call with a path (same resolve
  // function; packaged builds refuse). Replacing `window.fs.pickMediaFile`
  // in the renderer does NOT work: contextBridge freezes the API object.
  let testNextMediaPickPath: string | null = null;
  ipcMain.handle("fs:pick-media-file-test-next", (_e, filePath: string | null) => {
    if (app.isPackaged) return { ok: false as const, error: "test-only" };
    // `null` clears a pending arm. `""` arms a simulated cancel (dialog
    // returned no path). Any other string is the injected absolute path.
    if (filePath === null) testNextMediaPickPath = null;
    else if (filePath === "") testNextMediaPickPath = "";
    else testNextMediaPickPath = filePath.trim() || "";
    return { ok: true as const };
  });
  ipcMain.handle("fs:pick-media-file", async () => {
    if (!app.isPackaged && testNextMediaPickPath !== null) {
      const injected = testNextMediaPickPath;
      testNextMediaPickPath = null;
      if (injected === "") return null;
      return resolvePickedMediaFile(injected);
    }
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        {
          name: "Images & PDF",
          extensions: [...PICK_MEDIA_EXTENSIONS],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return resolvePickedMediaFile(result.filePaths[0]!);
  });
  ipcMain.handle("fs:pick-media-file-test", (_e, filePath: string) => {
    if (app.isPackaged) return { ok: false as const, error: "test-only" };
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      return { ok: false as const, error: "test path required" };
    }
    return resolvePickedMediaFile(filePath);
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
    if (width === 0 || height === 0) return { ok: false, error: t("error.emptyCapture") };
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
  ipcMain.handle("fs:watch-start", (_e, root: string, clientId: string) => startWatching(root, clientId));
  ipcMain.handle("fs:watch-set-dirs", (_e, root: string, clientId: string, dirs: string[]) =>
    setWatchedDirs(root, clientId, dirs),
  );
  ipcMain.handle("fs:watch-stop", (_e, root: string, clientId: string) => stopWatching(root, clientId));
  ipcMain.handle("fs:watch-stats", () => getWatchStats());

  ipcMain.handle("browser:create", (_e, id: string, url: string) => browserRegistry.create(id, url));
  ipcMain.handle("browser:navigate", (_e, id: string, url: string) => browserRegistry.navigate(id, url));
  ipcMain.handle("browser:back", (_e, id: string) => browserRegistry.back(id));
  ipcMain.handle("browser:forward", (_e, id: string) => browserRegistry.forward(id));
  ipcMain.handle("browser:reload", (_e, id: string) => browserRegistry.reload(id));
  ipcMain.handle("browser:open-devtools", (_e, id: string) => browserRegistry.openDevTools(id));
  // DESIGN-BACKLOG.md §2.1 — CDP do inspector embutido (browser-cdp.ts).
  // Attach/detach são disparados pelo mount/unmount de BrowserInspector.tsx,
  // não pela criação/destruição do card — ver o doc comment de
  // `attachInspector` em browser-registry.ts pro porquê.
  ipcMain.handle("browser:cdp-attach", (_e, id: string) => browserRegistry.attachInspector(id));
  ipcMain.handle("browser:cdp-detach", (_e, id: string) => browserRegistry.detachInspector(id));
  ipcMain.handle("browser:cdp-send", (_e, id: string, method: string, params?: object) => browserRegistry.sendCdp(id, method, params));
  // Pendentes #188 — menu de contexto nativo do Chromium embutido.
  // `x`/`y` já chegam em coordenadas reais de tela relativas a `win`
  // (BrowserCard.tsx fez a conversão a partir do retângulo real do
  // canvas — ver `browser-registry.ts`'s `context-menu` listener e o
  // doc comment de `BrowserContextMenuParams`). Cada item chama um
  // método já existente do registry — nada novo em termos de mecanismo,
  // só um jeito nativo de disparar o que o rail/teclado já disparavam.
  ipcMain.handle(
    "browser:show-context-menu",
    (_e, id: string, x: number, y: number, params: BrowserContextMenuParams) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      template.push(
        { label: t("menu.back"), enabled: params.canGoBack, click: () => browserRegistry.back(id) },
        { label: t("menu.forward"), enabled: params.canGoForward, click: () => browserRegistry.forward(id) },
        { label: t("menu.reload"), click: () => browserRegistry.reload(id) },
      );
      if (params.linkURL) {
        template.push(
          { type: "separator" },
          { label: t("menu.openLink"), click: () => browserRegistry.navigate(id, params.linkURL) },
          { label: t("menu.copyLinkAddress"), click: () => clipboard.writeText(params.linkURL) },
        );
      }
      if (params.mediaType === "image" && params.srcURL) {
        template.push(
          { type: "separator" },
          { label: t("menu.copyImageAddress"), click: () => clipboard.writeText(params.srcURL) },
        );
      }
      if (params.selectionText || params.isEditable) {
        template.push({ type: "separator" });
        if (params.selectionText) template.push({ label: t("menu.copy"), click: () => browserRegistry.copyText(id) });
        if (params.isEditable) {
          template.push(
            { label: t("menu.cut"), click: () => browserRegistry.cutText(id) },
            { label: t("menu.paste"), click: () => browserRegistry.pasteText(id) },
          );
        }
      }
      // Pendentes #188 — abre o mini-inspector EMBUTIDO no card
      // (BrowserCard.tsx's `BrowserInspector`) em vez do DevTools real
      // destacado — o menu kebab "Abrir DevTools" continua existindo pra
      // quem quiser o DevTools de verdade, sem elemento nenhum focado.
      // `params.x/y` aqui ainda no espaço de CONTEÚDO (mesmo do evento
      // `context-menu` original), é o que `document.elementFromPoint` do
      // inspector espera.
      template.push(
        { type: "separator" },
        { label: t("menu.inspectElement"), click: () => safeSend(win, "browser:open-inspector", id, params.x, params.y) },
      );
      Menu.buildFromTemplate(template).popup({ window: win, x, y });
    },
  );
  ipcMain.handle("browser:resize", (_e, id: string, w: number, h: number, zoom?: number) => browserRegistry.resize(id, w, h, zoom));
  ipcMain.handle("browser:set-visible", (_e, id: string, visible: boolean) => browserRegistry.setVisible(id, visible));
  ipcMain.handle("browser:set-focused", (_e, id: string, focused: boolean) => browserRegistry.setFocused(id, focused));
  ipcMain.handle("browser:destroy", (_e, id: string) => browserRegistry.destroy(id));
  // Pendentes #188 — mini-inspector embutido no card (BrowserCard.tsx's
  // `BrowserInspector`). `evalJs`/`getConsole` já existiam pro lado MCP
  // (message-bus.ts) — mesmo poder, agora alcançável pela própria UI do
  // Stellar sem gate humano extra, mesma categoria de risco de
  // `getPageText`/`clickAtPoint` (já sem gate): é o PRÓPRIO usuário
  // rodando JS no card que ELE está olhando, não um agente externo.
  ipcMain.handle("browser:eval", (_e, id: string, js: string) => browserRegistry.evalJs(id, js));
  ipcMain.handle("browser:get-console", (_e, id: string) => browserRegistry.getConsole(id));
  // Pendentes #188 — aba Application/Network do inspector redesenhado
  // como coluna dockável (aprovado pelo usuário via protótipo HTML,
  // 2026-09-06). `getNetwork`/`getCookies` já existiam no registry (o
  // primeiro pro lado MCP, `getCookies` novo) — só faltava alcançar a UI.
  ipcMain.handle("browser:get-network", (_e, id: string) => browserRegistry.getNetwork(id));
  ipcMain.handle("browser:get-cookies", (_e, id: string) => browserRegistry.getCookies(id));
  // DESIGN-BACKLOG.md §2.1 item 7 — aba Sources. `fetchSource` roda no
  // main process (`net.fetch`, sem CORS, sem passar pelo teto de 20k
  // chars do `evalJs`) — ver o doc comment dela em browser-registry.ts.
  ipcMain.handle("browser:fetch-source", (_e, id: string, url: string) => browserRegistry.fetchSource(id, url));
  // DESIGN-BACKLOG.md §2.1 item 8 — aba Performance. `getProcessStats`
  // (`app.getAppMetrics()`, sem CDP) — ver o doc comment dela em
  // browser-registry.ts.
  ipcMain.handle("browser:get-process-stats", (_e, id: string) => browserRegistry.getProcessStats(id));
  // Pendentes #188 — aba Application (metade local/session storage; a
  // metade de cookies já é `browser:get-cookies` acima, via
  // `session.cookies.get` — não duplicar a mesma leitura por dois
  // caminhos diferentes).
  ipcMain.handle("browser:get-local-session-storage", (_e, id: string) => browserRegistry.getLocalSessionStorage(id));
  ipcMain.handle("browser:delete-local-session-item", (_e, id: string, area: "local" | "session", key: string) =>
    browserRegistry.deleteLocalSessionItem(id, area, key),
  );
  ipcMain.handle(
    "browser:set-device-emulation",
    (_e, id: string, params: { width: number; height: number; deviceScaleFactor: number; mobile: boolean } | null) =>
      browserRegistry.setDeviceEmulation(id, params),
  );
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

  // Test-only — live proof for renderer-gone recovery (smoke-renderer-gone.mjs).
  // setImmediate so the invoke can resolve before the frame dies; a sync
  // crash inside the handler left the page's Promise hanging and, measured
  // 2026-09-14, the renderer PID sometimes never actually exited.
  ipcMain.handle("debug:crash-renderer", () => {
    if (app.isPackaged) return;
    setImmediate(() => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.forcefullyCrashRenderer();
      }
    });
  });
  ipcMain.handle("debug:renderer-gone-log-path", () => {
    if (app.isPackaged) return null;
    return rendererGoneLogPath;
  });

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

  // Human-input gate probe (2026-09-14) — verify harness reads buffer
  // contents without touching the PTY. Packaged builds refuse.
  ipcMain.handle("debug:human-input-gate", () => {
    if (app.isPackaged) return null;
    return registry.dumpHumanInputGate();
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

  // DESIGN-BACKLOG.md §2.1 i18n fase 1 — locale detection + persisted override.
  ipcMain.handle("i18n:get", () => {
    const override = localePrefs.getOverride();
    const locale = resolveLocale(systemLocale, override);
    return { locale, override, systemLocale };
  });
  ipcMain.handle("app:build-identity", () => currentBuildIdentity());
  ipcMain.handle("i18n:set-override", (_e, override: unknown) => {
    const next =
      override === null || override === undefined ? null : isLocale(override) ? override : null;
    if (override !== null && override !== undefined && next === null) {
      const current = localePrefs.getOverride();
      return { locale: resolveLocale(systemLocale, current), override: current, systemLocale };
    }
    localePrefs.setOverride(next);
    const locale = resolveLocale(systemLocale, next);
    applyLocale(locale);
    return { locale, override: next, systemLocale };
  });

  ipcMain.handle(
    "chat:send",
    (
      _e,
      cardId: string,
      params: { provider: SecretProvider; model: string; systemPrompt: string | null; messages: ChatMessage[]; cwd: string },
    ) => {
      const apiKey = secretsStore.get(params.provider);
      if (!apiKey) return { ok: false, error: t("error.noApiKey", { provider: params.provider }) };
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
        return { ok: false, error: t("error.genericNoEndpoint") };
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

  // Atalhos fase A, item 4 — revisão pós-review rodada 3 (2026-09-09): o
  // `Menu` próprio construído no topo de `createWindow()` já elimina
  // Ctrl+R/Ctrl+W (e Ctrl+Shift+R/Ctrl+0/Ctrl+Q/Ctrl+M) na fonte — sem
  // role nenhum os alimentando, não sobra comportamento nativo pra
  // neutralizar aqui, e o keydown flui normal pro DOM (chega ao xterm
  // quando um terminal está focado). O `terminalFocused`/`win:terminal-
  // focus`/o efeito de `focusin`/`focusout` da rodada anterior sumiram
  // inteiros — nenhum cache, nenhuma corrida possível, porque não sobrou
  // nada de main pra saber sobre foco de terminal.
  //
  // O que SOBRA aqui é só Ctrl+Plus/Ctrl+Minus: sem role `zoomIn`/
  // `zoomOut` no menu, o Chromium não tem mais zoom nativo pra brigar com
  // o óptico do canvas, mas o REDIRECIONAMENTO pro zoom do canvas
  // continua sendo uma feature pedida (item 4 original), não só uma
  // neutralização — só o renderer tem o `zoomBy`/`ZOOM_STEP`
  // (useWorldTransform.ts), daí o gatilho por IPC. Isso NUNCA teve
  // corrida (não lê nenhum estado do renderer, só `preventDefault` +
  // reenvia), não havia motivo pra mexer aqui.
  //
  // Investigado (achado do item 4, ainda válido): o card de NAVEGADOR não
  // é mais um `WebContentsView` filho desta janela — foi reescrito pra
  // renderização offscreen (ver o doc comment de `createBrowserRegistry`
  // em browser-registry.ts, 2026-08-26): cada card de navegador é uma
  // `BrowserWindow` oculta própria, com seu PRÓPRIO `webContents`,
  // pintando num buffer que o renderer desenha num `<canvas>` dentro do
  // DOM desta janela (BrowserCard.tsx) — esse `<canvas>` É parte do
  // webContents desta janela, então uma tecla apertada com ele focado
  // passa por ESTE `before-input-event` antes de `BrowserCard.tsx`'s
  // `onCanvasKeyDown` decidir o que encaminhar pro webContents offscreen
  // separado do card. Efeito colateral real, MENOR agora que só
  // Ctrl+Plus/Ctrl+Minus passam por aqui (Ctrl+R/Ctrl+W voltaram a fluir
  // normal, encaminhados crus pro card de navegador focado como qualquer
  // outro atalho arbitrário — mesmo caminho do Ctrl+S): só essas duas
  // teclas de zoom deixam de ser encaminhadas cruas pra dentro da página
  // embutida quando o card de navegador está focado. Não achei nenhum uso
  // hoje de uma página embutida dependendo disso (o card de navegador já
  // tem seus próprios botões de reload/navegação), mas é comportamento
  // observável — não confirmável sem o app aberto (xvfb quebrado aqui).
  //
  // Registrado, NÃO tratado agora (fase B decide com o registro central
  // na mão) — Alt+←/→ (navegação de histórico) é o único item real que
  // sobrevive a QUALQUER `Menu`: é um comportamento embutido no `content`
  // layer do Chromium que o Electron usa por baixo, independente de menu
  // (gotcha documentado da comunidade Electron) — só um
  // `before-input-event` dedicado neutraliza, e este não faz isso hoje.
  // F5/Ctrl+P/Ctrl+F estavam nesta lista desde a rodada 1 como supostos
  // roles do menu default, mas não achei nenhum role padrão do Electron
  // com acelerador F5/Ctrl+P/Ctrl+F documentado — suspeita herdada, não
  // fato confirmado; podem nunca ter feito nada de especial nesta app.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (!input.control && !input.meta) return;
    // Round 2 (achado 1a do review) — casa contra `ZOOM_IN_COMBO`/
    // `ZOOM_OUT_COMBO` (o MESMO objeto que `shortcut-registry.ts` declara
    // pra `canvas.zoomIn`/`canvas.zoomOut`) via `matchesCombo`, no lugar
    // dos literais que existiam aqui antes. `input.key` não precisa de
    // `.toLowerCase()` manual — `matchesCombo` já faz o case-fold pra
    // teclas de um caractere. `metaKey` nunca vem `true` aqui (Electron
    // reporta Cmd como `input.meta`, já lido acima em `!input.control &&
    // !input.meta`), mas o adaptador inclui os dois campos pra bater com
    // `ShortcutKeyEvent` (a mesma forma que o despachante do renderer usa).
    const asShortcutEvent: ShortcutKeyEvent = {
      key: input.key,
      code: input.code,
      ctrlKey: input.control,
      metaKey: input.meta,
      shiftKey: input.shift,
      altKey: input.alt,
    };
    if (matchesCombo(asShortcutEvent, ZOOM_IN_COMBO)) {
      event.preventDefault();
      safeSend(win, "win:zoom-accelerator", "in");
      return;
    }
    if (matchesCombo(asShortcutEvent, ZOOM_OUT_COMBO)) {
      event.preventDefault();
      safeSend(win, "win:zoom-accelerator", "out");
    }
  });

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
    // Fatia 3b (ab83ba5f): o flush ANTES de a janela morrer é a garantia do
    // contrato do coalescer — um push pendente na janela de 200ms sai agora
    // (o renderer ainda está vivo neste evento), em vez de ser descartado
    // junto com o timer. `close()` é idempotente.
    taskNotifyCoalescer.close();
    browserRegistry.destroyAll();
  });
  win.on("closed", () => {
    // `screen.on(...)` acima é um listener GLOBAL do módulo `screen`, não
    // escopado a `win` (diferente de `win.on("moved", ...)`, que o
    // próprio Electron já limpa ao destruir a janela) — sem isto, ficaria
    // pendurado referenciando um `win` já destruído se `createWindow()`
    // algum dia rodasse mais de uma vez no mesmo processo.
    screen.removeListener("display-metrics-changed", recheckBrowserScaleFactors);
    if (mainWindow === win) mainWindow = null;
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

/**
 * Resolução do PATH do usuário (user-env.ts), disparada no boot e nunca
 * esperada por ninguém: o snapshot síncrono já serve desde o import, e
 * esta chamada só o melhora com o PATH real da login shell. Existe porque
 * um `.app` aberto pelo Finder no macOS herda o PATH do launchd, onde
 * nenhuma CLI de agente instalada pelo usuário aparece.
 *
 * O aviso ao renderer é o que impede um falso "não instalado" de ficar
 * congelado na tela: `useAgentAvailability.ts` checa uma vez por vida do
 * app, e essa vez pode acontecer antes desta resolução terminar.
 */
// Foca/restaura a janela existente em vez de deixar a 2ª instância abrir a
// dela própria — só a instância que DETÉM o lock recebe este evento
// (Electron: emitido no processo original quando uma 2ª tentativa é
// barrada pelo `requestSingleInstanceLock()` acima).
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  // Ver o comentário de `requestSingleInstanceLock()` no topo do arquivo —
  // `app.quit()` já foi chamado ali pra 2ª instância, mas é assíncrono;
  // este guard é quem de fato impede `createWindow()` (store, socket do
  // acbridge, servidor MCP) de rodar aqui numa corrida onde `ready` dispara
  // antes do quit terminar.
  if (!gotSingleInstanceLock) return;

  // Identity migration (`agent-canvas` → `stellar`) must run after setName
  // (so userData is the new path) and before openStore inside createWindow.
  // Does not delete the legacy directory. Aborts start if a pre-migration
  // instance is still holding the legacy sock — new lock key ≠ old key.
  const newUserData = app.getPath("userData");
  const legacyDir = legacyUserDataDir(newUserData);
  const legacyLive = await probeLegacyInstanceLive(join(legacyDir, SOCK_BASENAME));
  const decision = decideUserDataMigration(readMigrationFsSnapshot(legacyDir, newUserData, legacyLive));
  if (decision.action === "abort") {
    const messages: Record<typeof decision.reason, string> = {
      "legacy-instance-live":
        `[stellar] Recusando start: instância legada ainda escuta em ${join(legacyDir, SOCK_BASENAME)}. ` +
        `Feche todos os cards/processos agent-canvas antes de abrir o Stellar com a identidade nova.`,
      "partial-interrupted":
        `[stellar] Migração incompleta em ${newUserData} (marcador ${join(newUserData, ".migration-in-progress")}). ` +
        `Remova o destino parcial à mão se for seguro, ou restaure a partir de ${legacyDir} — não apague o legado sem confirmação.`,
      "target-conflict":
        `[stellar] ${newUserData} já tem agent-canvas.db sem marcador de migração. ` +
        `Não vou sobrescrever. Resolva o conflito antes de abrir.`,
    };
    console.error(messages[decision.reason]);
    app.quit();
    return;
  }
  if (decision.action === "migrate") {
    const result = applyUserDataMigration(legacyDir, newUserData);
    if (!result.ok) {
      console.error(`[stellar] Migração de userData falhou: ${result.error}`);
      app.quit();
      return;
    }
    console.info(
      `[stellar] Migração agent-canvas → stellar: copiados [${result.copied.join(", ")}] de ${legacyDir}. ` +
        `Diretório legado intacto (reversível).`,
    );
  }

  // GATILHO do hot-reload (task 510df7b9): a leitura do boot vira a LINHA DE
  // BASE do watcher, e daqui para a frente editar `providers.json` à mão
  // re-sincroniza o registro vivo — sem reiniciar e sem passar pela tela de
  // Settings. O watcher mora em `providers-dynamic.ts` (decisão + I/O
  // juntos, como o loader) e chama o MESMO `loadDynamicProviders` do boot:
  // poda incluída, e o contrato de "não podar quando a leitura é duvidosa"
  // (JSON quebrado / formato recusado no topo) incluído — nenhum segundo
  // caminho de carga existe aqui.
  //
  // O relatório sai em dois lugares, porque um deles pode não existir:
  // `console.info` (visível no terminal de quem roda em dev e, no
  // empacotado, para quem lança o binário de um terminal — mesma aposta do
  // aviso de instância única, no topo deste arquivo) e o push
  // `providers:config-changed` para a janela principal — o canal que a UI de
  // Settings precisa para dizer "relido: entraram X, saíram Y, a linha N foi
  // recusada". O push usa a `mainWindow` publicada por `createWindow` (ver o
  // doc comment dela): o watcher nasce ANTES da janela, os eventos de arquivo
  // chegam depois.
  //
  // Ao contrário do watcher de arquivos do FilesCard (`file-watcher.ts`, um
  // `fs.watch` por diretório ABERTO na tela), este é um só, pelo diretório do
  // userData, filtrando o nome do arquivo — e não cresce com nada.
  //
  // Consequência aceita e conhecida: `app:add-provider`/`app:remove-provider`
  // (logo abaixo) gravam nesse MESMO arquivo, então o save do formulário
  // dispara uma releitura ~300ms depois. Ela é idempotente sobre o conteúdo
  // que o próprio handler acabou de validar e gravar, e o preço de não ter
  // dois caminhos de carga divergindo — o formulário não ganha atalho nenhum
  // no registro por causa disso.
  // ---------------------------------------------------------------------
  // O ARQUIVO DO USUÁRIO NASCE INSTRUÍDO — e o que já existe é completado
  // (task d9aa8b1a). O relato: o botão "editar" do Settings abria um
  // `providers.json` de 44 bytes, `{ "schemaVersion": 1, "providers": [] }`,
  // sem `$schema` (então sem autocompletar) e sem o exemplo — num arquivo para
  // o qual a própria UI acabou de apontar o usuário como o lugar de sobrescrever
  // o `baseArgs` (task c857539c).
  //
  // A CAUSA era fiação, não desenho: `initialProvidersConfig` e
  // `ensureProvidersSchemaFile` existiam desde a 64aed52b, documentadas e
  // testadas, e sem um único chamador de produção — por isso este passo, e por
  // isso o gate em tests/unit/providers-config-seed.test.ts, que pergunta
  // "alguém chama isto?".
  //
  // ORDEM, e ela importa duas vezes: ANTES do `loadDynamicProviders` abaixo,
  // para a linha de base do watcher ser lida de um arquivo já semeado (gravar
  // depois seria escrever com o observador armado, e um boot com um reload
  // espúrio no relatório); e ANTES do `createProvidersConfigWatcher`, pelo
  // mesmo motivo. Aqui também é o único ponto do boot em que `newUserData` já
  // existe e ainda não há janela: nada aqui depende de UI.
  //
  // O log é HONESTO sobre o que aconteceu e não alarma o que é normal: nascer
  // e ser completado são fatos de uma vez (o segundo, uma vez por arquivo
  // pobre que já existia); `unchanged` é o caso de todo boot seguinte e não
  // vira linha. Arquivo ilegível/quebrado sai como AVISO, com o caminho e o
  // motivo, porque é a única situação em que o usuário precisa olhar — e o
  // arquivo fica intocado de propósito.
  const providersBootstrap = bootstrapProvidersConfig(newUserData);
  if (providersBootstrap.config.action === "created" || providersBootstrap.config.action === "migrated") {
    const what =
      providersBootstrap.config.action === "created"
        ? "criado com $schema e _example"
        : `completado com ${providersBootstrap.config.addedKeys.join(", ")} (o resto do arquivo ficou como estava)`;
    console.info(`[providers] ${providersBootstrap.config.path} ${what}.`);
  }
  if (providersBootstrap.config.error !== null) {
    console.warn(
      `[providers] ${providersBootstrap.config.action}: ${providersBootstrap.config.error} — NÃO toquei no arquivo.`,
    );
  }
  if (providersBootstrap.schema.error !== null) {
    console.warn(`[providers] schema ao lado do providers.json não pôde ser escrito: ${providersBootstrap.schema.error}`);
  }

  const bootProvidersLoad = loadDynamicProviders(newUserData);
  const providersWatcher = createProvidersConfigWatcher({
    userDataDir: newUserData,
    baseline: bootProvidersLoad,
    onReload: (report) => {
      // A linha é formatada UMA vez e viaja pronta: o log daqui e o aviso da
      // tela de Settings mostram a MESMA redação (`formatProvidersReloadLine`,
      // task ebe8a79c). Se o renderer redigisse a sua, as duas versões do
      // mesmo fato divergiriam na primeira mudança de formato do relatório.
      const line = formatProvidersReloadLine(report);
      console.info(`[providers] ${line}`);
      // Os DOIS avisos que este reload deve emitir vêm de onde são testáveis
      // (agent-availability-projection.ts): o segundo faz o snapshot do
      // renderer acompanhar o arquivo em vez de congelar no boot — sem ele o
      // rail, o menu radial e os pickers continuam mostrando o mundo velho (e
      // a faixa de esforço editada fica com o valor antigo na tela).
      if (mainWindow) {
        for (const notice of providersReloadNotices(report, line)) {
          safeSend(mainWindow, notice.channel, ...notice.args);
        }
      }
    },
  });
  app.once("will-quit", () => providersWatcher.stop());

  // ---------------------------------------------------------------------
  // MOTOR DE VOZ (2026-09-20) — whisper.cpp LOCAL, decisão do dono do repo:
  // o áudio não sai da máquina. `voice-transcription.ts` tem o porquê de cada
  // escolha (binário já instalado, ffmpeg presente, porta 8199 porque a 8080
  // é do llama-swap, e "modelo ausente" como estado de primeira classe — a UI
  // diz o que falta e o comando de download em vez de falhar mudo).
  //
  // O server sobe no começo da gravação (`voice:warmup`, esconde o load do
  // modelo atrás da fala) e MORRE no fim da transcrição — `stop()` no quit é
  // a rede de segurança, não o caminho normal.
  // ---------------------------------------------------------------------
  const voiceTranscriber = new WhisperTranscriber(() =>
    resolveVoiceConfig(defaultVoiceConfigInput(newUserData, process.env)),
  );
  app.once("will-quit", () => voiceTranscriber.stop());
  ipcMain.handle("voice:status", () => voiceTranscriber.status());
  ipcMain.handle("voice:warmup", () => voiceTranscriber.warmup());
  ipcMain.handle("voice:transcribe", (_e, base64: unknown, mimeType: unknown) => {
    if (typeof base64 !== "string") return { ok: false, error: t("error.attachmentBadRequest") };
    return voiceTranscriber.transcribe(base64, typeof mimeType === "string" ? mimeType : "");
  });

  // ---------------------------------------------------------------------
  // Providers dinâmicos — a fiação IPC da tela de Settings
  // (renderer/src/ProvidersPage.tsx, task cebaf3c8).
  //
  // ONDE ESTES HANDLERS MORAM, e por quê: AQUI dentro, onde `newUserData`
  // já existe (`app.getPath("userData")`, poucas linhas acima). A primeira
  // versão desta fiação foi escrita dentro de `createWindow()` — outro
  // escopo, sem `newUserData` — e não compilava (5x TS2304): o caminho que
  // grava o arquivo era uma referência morta.
  //
  // POR QUE IPC DEDICADO, e não o `window.fs.read`/`write` que a tela
  // tentava usar: aquele `fs` é CONFINADO a um root (`readFile(root, path)`
  // → `confine`) e `root=""` transforma o caminho absoluto do userData em
  // relativo — o escape é recusado, então a tela nunca leria nem gravaria
  // nada (falha silenciosa, dentro de um try/catch). Pior: dar `root=""`
  // daria à tela de Settings escrita solta em qualquer caminho. Aqui o main
  // lê, valida com o MESMO parser que o loader usa (a validação de registro
  // continua com uma fonte só, `providers-dynamic.ts`) e grava apenas o
  // arquivo que é assunto desta tela.
  // ---------------------------------------------------------------------
  function readProvidersConfigFile(path: string):
    | { kind: "missing" }
    | { kind: "invalid"; error: string }
    | { kind: "ok"; raw: Record<string, unknown>; providers: unknown[] } {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
      return { kind: "invalid", error: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { kind: "invalid", error: `${path} is not a JSON object` };
      }
      const raw = parsed as Record<string, unknown>;
      const providers = Array.isArray(raw.providers) ? raw.providers : [];
      return { kind: "ok", raw, providers };
    } catch (err) {
      return { kind: "invalid", error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Grava `providers` preservando o RESTO do arquivo (chaves que esta tela
   * não conhece não são dela para apagar) e de forma atômica: um
   * `writeFileSync` interrompido no meio deixaria ilegível um arquivo que o
   * usuário edita à mão por definição — e a config dele é o único registro
   * dos providers dele.
   */
  function writeProvidersConfig(path: string, raw: Record<string, unknown>, providers: unknown[]): void {
    const next = { ...raw, schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION, providers };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  }

  /**
   * O que a tela mostra: o que o LOADER de fato registrou (inclui o
   * catálogo embutido — cline/commandcode), mais as recusas dele. Quem
   * decide precedência (nativo > arquivo > embutido) continua sendo o
   * loader; aqui só se junta rótulo/binário/MCP para exibir.
   */
  function providersPageView() {
    const path = providersConfigPath(newUserData);
    const loaded = loadDynamicProviders(newUserData);
    const file = readProvidersConfigFile(path);
    const fileEntries = file.kind === "ok" ? file.providers : [];

    const row = (spec: DynamicProviderSpec, source: "file" | "app") => ({
      id: spec.id,
      label: spec.label,
      binaryNames: [...spec.binaryNames],
      // A identidade que a UI não via (task c857539c): com que flags fixas o
      // provider sobe, e se uma delas desliga os prompts — DECLARADO no spec
      // e medido por quem o declarou; ausente é "sem claim". Vazio vira
      // frase na tela ("sem flags fixas"), nunca ausência silenciosa.
      baseArgs: [...(spec.baseArgs ?? [])],
      bypassesPermissionPrompts: spec.bypassesPermissionPrompts === true,
      mcpEnabled: spec.capacity.mcp.mechanism === "global-config",
      mcpConfigPath: spec.capacity.mcp.mechanism === "global-config" ? spec.capacity.mcp.configPath : null,
      mcpConfigKey: spec.capacity.mcp.mechanism === "global-config" ? spec.capacity.mcp.configKey : null,
      source,
      // O loader recusou este id porque um NATIVO já o possui — a tela
      // precisa dizer isso, senão o usuário "cadastra" e nada acontece.
      skipped: loaded.skipped.includes(spec.id),
    });

    const fromFile = parseProviderSpecs({ schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION, providers: fileEntries });
    const shippedIds = new Set(loaded.shippedDefaults);
    const rows = [
      ...fromFile.specs.map((s) => row(s, "file" as const)),
      ...MEASURED_THIRD_PARTY_SPECS.filter((s) => shippedIds.has(s.id)).map((s) => row(s, "app" as const)),
    ].sort((a, b) => a.id.localeCompare(b.id));

    return {
      path,
      fileRead: loaded.fileRead,
      // Erro de ARQUIVO (JSON inválido/permissão) — o que impede a tela de
      // mostrar qualquer coisa. Recusas por entrada vão em `rejected`.
      error: loaded.error,
      rejected: [...loaded.rejected, ...(file.kind === "invalid" ? [{ index: -1, id: null, reason: file.error }] : [])],
      skipped: loaded.skipped,
      rows,
    };
  }

  ipcMain.handle("app:get-providers-config-path", () => providersConfigPath(newUserData));

  /**
   * Escape hatch do briefing: abre o JSON cru no editor do SO — este app não
   * constrói editor de JSON. O arquivo precisa EXISTIR para o editor abrir
   * com conteúdo, então um arquivo ausente nasce aqui — e nasce pela MESMA
   * função do boot (`ensureProvidersConfigFile`), não por um segundo caminho
   * de escrita: era `writeProvidersConfig(path, {}, [])`, que produzia
   * exatamente o arquivo mudo de 44 bytes que a task d9aa8b1a veio consertar.
   * Aqui o caso é raro (só acontece se o usuário apagar o arquivo com o app
   * aberto), mas o conteúdo não pode ser diferente do que o boot produz.
   */
  ipcMain.handle("app:open-providers-config", async () => {
    const path = providersConfigPath(newUserData);
    const file = readProvidersConfigFile(path);
    if (file.kind === "missing") ensureProvidersConfigFile(newUserData);
    const openError = await shell.openPath(path);
    return { ok: openError === "", error: openError === "" ? null : openError };
  });

  /** Ler JÁ recarrega o registro (hot-reload do loader, item 4 do
   * briefing): é o mesmo gesto que o usuário faria ao voltar do editor. */
  ipcMain.handle("app:read-providers-config", () => providersPageView());

  /**
   * Adiciona (ou reedita) um provider dinâmico. O form manda só o que ele
   * sabe expressar — id, label, binários e o MCP — e o RESTO da declaração é
   * preenchido aqui, com defaults seguros e DECLARADOS:
   *   systemPrompt `none`, effort `none` (reason "no-flag"), model `none`
   *   (reason "shell"), delivery `positional`, sessão sem id imposto,
   *   `installCommand` nulo. É o que o briefing pede: os campos técnicos
   *   (flags de resume/effort/model) exigem conhecer a CLI de cor e não se
   *   adivinham por UI — quem sabe edita o JSON cru.
   * `acbridgeOnPath: true` NÃO é um palpite sobre a CLI: `pty-registry.ts`
   * põe o `binDir` no PATH de TODO card, então o `acbridge` está lá — é o
   * que sustenta o `report` de um provider sem MCP (ver `deriveReportChannel`).
   *
   * Um id que JÁ existe (no arquivo ou no catálogo embutido) não é
   * rebaixado: o que o form não expressa é PRESERVADO da declaração
   * anterior, então editar o rótulo de um `cline` não apaga a capacidade
   * medida dele.
   */
  ipcMain.handle("app:add-provider", (_e, input: unknown) => {
    const path = providersConfigPath(newUserData);
    const file = readProvidersConfigFile(path);
    // Arquivo existente e ILEGÍVEL não é sobrescrito: o conteúdo quebrado é
    // do usuário, e apagá-lo seria perder o trabalho dele em silêncio.
    if (file.kind === "invalid") return { ok: false, error: file.error };

    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, error: "app:add-provider expects a provider object" };
    }
    const candidate = input as { id?: unknown; label?: unknown; binaryNames?: unknown; mcp?: unknown };
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    const binaryNames = Array.isArray(candidate.binaryNames)
      ? candidate.binaryNames
          .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
          .map((entry) => entry.trim())
      : [];
    const mcpInput = candidate.mcp === null || candidate.mcp === undefined ? null : candidate.mcp;
    let mcp: DynamicProviderSpec["capacity"]["mcp"] = { mechanism: "none" };
    if (mcpInput !== null) {
      if (typeof mcpInput !== "object" || Array.isArray(mcpInput)) {
        return { ok: false, error: "`mcp` must be null or an object with configPath/configKey" };
      }
      const configPath = typeof (mcpInput as { configPath?: unknown }).configPath === "string" ? (mcpInput as { configPath: string }).configPath.trim() : "";
      const configKey = typeof (mcpInput as { configKey?: unknown }).configKey === "string" ? (mcpInput as { configKey: string }).configKey.trim() : "";
      if (!configPath) return { ok: false, error: "`mcp.configPath` is required when MCP is enabled" };
      if (!configKey) return { ok: false, error: "`mcp.configKey` is required when MCP is enabled" };
      mcp = { mechanism: "global-config", configPath, configKey, serverShape: "stdio-command" };
    }

    const fresh: DynamicProviderSpec = {
      id,
      label,
      binaryNames,
      installCommand: null,
      capacity: {
        role: "agent",
        session: { canImposeSessionId: false },
        systemPrompt: { mechanism: "none" },
        mcp,
        acbridgeOnPath: true,
        effort: { mechanism: "none", reason: "no-flag" },
        model: { mechanism: "none", reason: "shell" },
        delivery: { briefMechanism: "positional" },
      },
    };
    const parsed = parseProviderSpec(fresh);
    if (!parsed.ok) return { ok: false, error: parsed.reason };

    const existing = file.kind === "ok" ? file.providers : [];
    const previousRaw = existing.find(
      (entry) => entry !== null && typeof entry === "object" && (entry as { id?: unknown }).id === id,
    );
    const previousParsed = previousRaw === undefined ? null : parseProviderSpec(previousRaw);
    const base: DynamicProviderSpec | null = previousParsed?.ok
      ? previousParsed.spec
      : (MEASURED_THIRD_PARTY_SPECS.find((spec) => spec.id === id) ?? null);
    const merged: DynamicProviderSpec = base
      ? {
          ...base,
          id,
          label,
          binaryNames,
          capacity: { ...base.capacity, mcp: parsed.spec.capacity.mcp },
        }
      : parsed.spec;

    const others = existing.filter(
      (entry) => !(entry !== null && typeof entry === "object" && (entry as { id?: unknown }).id === merged.id),
    );
    writeProvidersConfig(path, file.kind === "ok" ? file.raw : {}, [...others, merged]);
    return { ok: true, view: providersPageView() };
  });

  ipcMain.handle("app:remove-provider", (_e, id: unknown) => {
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: "missing provider id" };
    const path = providersConfigPath(newUserData);
    const file = readProvidersConfigFile(path);
    if (file.kind === "invalid") return { ok: false, error: file.error };
    const existing = file.kind === "ok" ? file.providers : [];
    const remaining = existing.filter(
      (entry) => !(entry !== null && typeof entry === "object" && (entry as { id?: unknown }).id === id),
    );
    if (remaining.length === existing.length) {
      return { ok: false, error: `no entry for provider "${id}" in the config file` };
    }
    writeProvidersConfig(path, file.kind === "ok" ? file.raw : {}, remaining);
    return { ok: true, view: providersPageView() };
  });

  createWindow();
  void refreshUserEnv().then(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) safeSend(win, "agents:availability-stale", userEnvSnapshot().source);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
