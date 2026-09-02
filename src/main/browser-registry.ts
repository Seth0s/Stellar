import { BrowserWindow, type Session } from "electron";

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

export type ConsoleEntry = { level: string; message: string; at: number };
export type PageElement = { ref: string; role: string; name: string; tag: string; disabled?: boolean; checked?: boolean; value?: string };
export type NetworkEntry = { method: string; url: string; status: number | null; error?: string; at: number };

/** Achado ao vivo (2026-09-01, relato de um agente que dirigiu o navegador
 * daqui): "debugar uma falha silenciosa (um botão de salvar que não faz
 * nada porque a API deu 500) não tem caminho nenhum pelo lado do Stellar".
 * Console e rede passam a ser gravados por card, em anel — a captura já
 * existia pro console (o contador de erros no header do card vem dela),
 * só era descartada depois de contar. Anel e não lista infinita: uma SPA
 * ruidosa geraria centenas de entradas por minuto e isso vive pela vida
 * inteira do card. */
const CONSOLE_BUFFER = 500;
const NETWORK_BUFFER = 300;

type Entry = {
  win: BrowserWindow;
  visible: boolean;
  scaleFactor: number;
  console: ConsoleEntry[];
  network: NetworkEntry[];
};

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

// Supersample fixo, pedido explícito do usuário (2026-09-02: "mandar
// renderizar o triplo da resolução e aumentar para escala 1:1") — ver o
// doc comment de `resize()` abaixo pro porquê de precisar do PAR
// `setContentSize`+`setZoomFactor` (não `setContentSize` sozinho) pra isto
// ser supersample de verdade, e não só a página acreditando que tem um
// viewport maior. Verificado ao vivo, 3 scripts de diagnóstico isolados
// antes de embarcar: (1) `setContentSize(N×)` sozinho deixa o conteúdo
// lógico da página proporcionalmente MENOR na tela (mais página cabe no
// card, texto ilegível a 3×) — não é supersample; (2) `setContentSize(N×)`
// + `setZoomFactor(N)` juntos mantêm a MESMA área lógica visível (mesmo
// "zoom" aparente do conteúdo) com N²× mais pixels reais de raster por
// trás — supersample de verdade, texto visivelmente mais nítido no
// screenshot comparado lado a lado; (3) clique continua preciso com o
// combo ativo (`sendInputEvent` opera no espaço de coordenadas da janela,
// não no espaço pós-zoom da página — mesmo raciocínio de por que zoom de
// página nunca quebra clique num browser real). Custo real medido numa
// página de conteúdo denso (texto real, não tela em branco): ~5× bytes
// por frame em JPEG qualidade 90 (não 9× — JPEG comprime o detalhe extra
// bem melhor que pixels brutos sugeririam).
const BROWSER_SUPERSAMPLE = 3;

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
  /** `webRequest` só reporta o `webContentsId`; isto o traduz de volta pro
   * card. Uma entrada morre junto com o card em `destroy`. */
  const wcIdToCardId = new Map<number, string>();
  const tappedSessions = new WeakSet<Session>();

  function recordNetwork(webContentsId: number | undefined, record: NetworkEntry) {
    if (webContentsId === undefined) return;
    const cardId = wcIdToCardId.get(webContentsId);
    if (!cardId) return;
    const entry = entries.get(cardId);
    if (!entry) return;
    entry.network.push(record);
    if (entry.network.length > NETWORK_BUFFER) entry.network.shift();
  }

  /** Um tap por sessão, idempotente — ver o comentário no `create`. Só
   * observa (`onCompleted`/`onErrorOccurred`), nunca bloqueia nem reescreve
   * requisição: um listener que responde tarde num `onBeforeRequest`
   * travaria a navegação da página inteira, e não há nada aqui que
   * justifique esse risco. */
  function ensureNetworkTap(session: Session) {
    if (tappedSessions.has(session)) return;
    tappedSessions.add(session);
    session.webRequest.onCompleted((details) => {
      recordNetwork(details.webContentsId, {
        method: details.method,
        url: details.url,
        status: details.statusCode ?? null,
        at: Date.now(),
      });
    });
    session.webRequest.onErrorOccurred((details) => {
      recordNetwork(details.webContentsId, {
        method: details.method,
        url: details.url,
        status: null,
        error: details.error,
        at: Date.now(),
      });
    });
  }

  function create(id: string, url: string): { scaleFactor: number } {
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
    // Supersample fixo (ver doc comment de BROWSER_SUPERSAMPLE/`resize()`)
    // — setado uma vez aqui e nunca mudado depois; `resize()` multiplica o
    // content size pelo MESMO fator, o que cancela o "mais página cabe no
    // card" que `setContentSize` sozinho introduziria.
    wc.setZoomFactor(BROWSER_SUPERSAMPLE);

    wc.on("paint", (_event, _dirty, image) => {
      const entry = entries.get(id);
      if (!entry?.visible) return;
      const { width, height } = image.getSize();
      if (width === 0 || height === 0) return;
      // JPEG, not the raw BGRA bitmap — a 720×560 raw frame is ~1.6MB;
      // over IPC at any real paint rate across several open cards that's
      // not viable. Queixa ao vivo de qualidade "parece 360p" (2026-09-01,
      // depois do fix de deviceScaleFactor) — qualidade 70 estava
      // introduzindo artefato de compressão visível em texto/UI real, um
      // segundo fator de perda 100% nosso, independente de qualquer
      // limitação do Electron/GPU. Subida pra 90: ainda troca um pouco de
      // nitidez por caber num canal IPC repetidamente, mas o degrau de
      // qualidade em 70 era desnecessariamente agressivo pra conteúdo de
      // UI/texto (majoritariamente o que se navega aqui).
      callbacks.onFrame(id, image.toJPEG(90), width, height);
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
    wc.on("console-message", (details) => {
      const entry = entries.get(id);
      if (entry) {
        entry.console.push({ level: details.level, message: details.message, at: Date.now() });
        if (entry.console.length > CONSOLE_BUFFER) entry.console.shift();
      }
      callbacks.onConsoleMessage(id, details.level, details.message);
    });

    entries.set(id, { win, visible: true, scaleFactor, console: [], network: [] });
    // A sessão é a padrão, compartilhada com a janela principal, e o
    // `webRequest` do Electron aceita UM listener por evento por sessão —
    // então o registro é feito uma vez só e despachado por
    // `webContentsId`, nunca um listener por card (o segundo card
    // silenciosamente desligaria o primeiro).
    wcIdToCardId.set(wc.id, id);
    ensureNetworkTap(wc.session);
    void wc.loadURL(normalizeUrl(url));
    return { scaleFactor };
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
  // A do navegador" note, executada 2026-08-31) originalmente também
  // multiplicava a resolução offscreen pelo zoom do board, mesma ideia do
  // `fontSize` do terminal escalando com o zoom. Revertido a pedido
  // explícito do usuário (2026-09-02: "o navegador não precisa ser afetado
  // pelo efeito do zoom aumentar ou diminuir a fonte") — era, na prática,
  // a causa da "resolução quase 4K" que ele notou num teste de zoom bem
  // alto: em `zoom` perto do antigo teto de 3, `factor` chegava a
  // 3×`scaleFactor`, MUITO acima da densidade real do monitor. `zoom` só
  // existe agora no parâmetro por compatibilidade de assinatura com os
  // chamadores existentes (`BrowserCard.tsx`/`browser:resize`) — ignorado
  // aqui de propósito; a resolução do card depende só do tamanho de mundo
  // do rect e do `scaleFactor` real do monitor (Item 6 abaixo), nunca do
  // zoom interativo do board.
  //
  // Item 6 (Trilha B, docs/SCREEN_SPACE_PROJECTION_PLAN.md) — multiplica
  // por `entry.scaleFactor`. IMPORTANTE, achado ao vivo testando isto
  // (2026-09-01, 3 scripts de diagnóstico isolados): `setContentSize`
  // SOZINHO não é supersampling HiDPI de verdade. Confirmado que
  // `webPreferences.offscreen.deviceScaleFactor` é um no-op pro raster
  // real nesta versão/plataforma de Electron (image.getSize() idêntico
  // byte a byte independente do valor) — e pra flag global do Chromium
  // `--force-device-scale-factor` (o `devicePixelRatio` da própria página
  // muda, o raster não). `setContentSize` é a alavanca que muda a
  // resolução real do paint buffer nesta build, mas é TAMBÉM o mesmo
  // número que o layout CSS da página embutida usa como seu próprio
  // viewport — SOZINHO, ele faz a página embutida ACREDITAR que seu
  // viewport é N× maior do que o card mostra visualmente: detalhe mais
  // nítido por pixel, mas proporcionalmente MAIS da página cabe no mesmo
  // card na tela (conteúdo lógico fica menor, não só mais nítido).
  //
  // Supersample fixo (BROWSER_SUPERSAMPLE, pedido explícito do usuário,
  // 2026-09-02: "mandar renderizar o triplo da resolução e aumentar para
  // escala 1:1") — fecha exatamente essa lacuna. `webContents.
  // setZoomFactor()` sozinho já era sabido no-op pro TAMANHO do paint
  // buffer (`getZoomFactor()` reporta certo, o buffer não muda) — mas
  // COMBINADO com um `setContentSize` já maior, o zoom da página faz o
  // conteúdo renderizar N× maior DENTRO desse viewport N× maior,
  // cancelando o "mais página cabe no card": a mesma área lógica fica
  // visível de antes, só que com N²× mais pixels reais de raster por
  // trás — supersample de verdade. Verificado ao vivo com screenshot lado
  // a lado (mesma janela, mesmo card, mesmo crop de tela): texto
  // visivelmente mais nítido, MESMA quantidade de conteúdo visível — e
  // clique continua preciso com o zoom ativo (`sendInputEvent` opera no
  // espaço de coordenadas da JANELA, não no espaço pós-zoom da página,
  // mesmo motivo de zoom de página nunca quebrar clique num browser
  // real). Custo real medido (conteúdo denso, JPEG qualidade 90): ~5×
  // bytes por frame, não 9× — JPEG comprime o detalhe extra bem melhor
  // que a contagem de pixels sugeriria.
  function resize(id: string, w: number, h: number, _zoom = 1) {
    const entry = entries.get(id);
    if (!entry) return;
    const factor = entry.scaleFactor * BROWSER_SUPERSAMPLE;
    entry.win.setContentSize(Math.max(1, Math.round(w * factor)), Math.max(1, Math.round(h * factor)));
  }

  /** Test-only (scripts/verify) — the real content-pixel size the
   * offscreen `BrowserWindow` is currently rasterizing at, straight from
   * Electron itself. Used to prove `resize`'s scaleFactor scaling actually
   * happened, the same "read the real instance, don't infer it" spirit
   * as `terminal-registry.ts`'s `getTerminalFontSize`. */
  function getContentSize(id: string): { w: number; h: number; scaleFactor: number } | null {
    const entry = entries.get(id);
    if (!entry) return null;
    const [w, h] = entry.win.getContentSize();
    return { w, h, scaleFactor: entry.scaleFactor };
  }

  /** Achado ao vivo (2026-09-02, pedido explícito do usuário: "não apenas
   * monitor 4K" — resolução real também precisa reagir a TROCAR de
   * monitor com a janela aberta, não só ao zoom do board). `entry.
   * scaleFactor` (item 6 acima) era resolvido uma ÚNICA vez, em
   * `create()` — arrastar a janela do app pra outro monitor com
   * scaleFactor diferente nunca reavaliava nada, o navegador embutido
   * continuava rasterizando na densidade do monitor ONDE FOI CRIADO, não
   * do monitor onde está agora. `callbacks.getScaleFactor()` em si já é
   * dinâmico (consulta `screen.getDisplayMatching(win.getBounds())` na
   * hora) — só nunca era CHAMADO de novo. `main/index.ts` chama isto pra
   * cada card vivo quando a janela principal se move (`win.on("moved")`)
   * ou quando o SO reporta mudança de métricas de display (`screen.on(
   * "display-metrics-changed")`) — devolve o novo valor só quando ele
   * REALMENTE mudou (evita round-trip de IPC/resize à toa em todo micro-
   * movimento de janela que não cruza monitor nenhum). */
  function refreshScaleFactor(id: string): number | null {
    const entry = entries.get(id);
    if (!entry) return null;
    const next = callbacks.getScaleFactor();
    if (next === entry.scaleFactor) return null;
    entry.scaleFactor = next;
    return next;
  }

  /** Ids de todo browser card com uma `BrowserWindow` offscreen viva —
   * usado por `refreshScaleFactor`'s caller (main/index.ts) pra saber
   * quais cards revisitar num evento de troca de monitor, sem precisar
   * de acesso direto ao Map interno. */
  function liveIds(): string[] {
    return [...entries.keys()];
  }

  /** Test-only (mesmo raciocínio de `testMakeEditable`) — grava
   * `entry.scaleFactor` direto, sem consultar `callbacks.getScaleFactor()`
   * de verdade. Simula só o VALOR que viria de um monitor diferente; o
   * resto do caminho real (IPC pro renderer, `BrowserCard.tsx` re-
   * disparando resize) roda sem nenhuma simulação — ver o handler
   * `browser:test-force-scale-factor` (main/index.ts) pro porquê. */
  function forceScaleFactor(id: string, scaleFactor: number) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.scaleFactor = scaleFactor;
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
  /**
   * Achado ao vivo (2026-09-01, relato de um agente que dirigiu o navegador
   * daqui): um `browser_click` com um seletor estilo Playwright
   * (`button:has-text('Salvar')`) falhava com "Script failed to execute,
   * this normally means an error was thrown" — a mensagem genérica do
   * Electron pra QUALQUER exceção dentro do `executeJavaScript`. O agente
   * não tinha como saber que o problema era o seletor, muito menos que o
   * motor aqui é o `querySelector` do próprio navegador (CSS puro) e não o
   * CSS estendido do Playwright; teve que adivinhar e cair pra
   * `browser_eval` com busca manual por `textContent`.
   *
   * O `try/catch` DENTRO da página é o ponto: um seletor inválido lança
   * `SyntaxError` no `querySelector`, e capturá-lo lá permite distinguir
   * três casos que antes viravam a mesma frase — seletor inválido,
   * seletor válido sem correspondência, e uma falha de verdade na
   * avaliação. Compartilhado por click/scroll/query pra que os três deem a
   * mesma resposta ao mesmo erro.
   *
   * `body` é interpolado como corpo de função e roda com `el` já resolvido.
   */
  async function withSelector<T>(
    id: string,
    selector: string,
    body: string,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(`
        (() => {
          let el;
          try {
            el = document.querySelector(${JSON.stringify(selector)});
          } catch (err) {
            return { __selectorError: String((err && err.message) || err) };
          }
          if (!el) return { __noMatch: true };
          return { __value: (function (el) { ${body} })(el) };
        })()
      `);
      const tagged = raw as { __selectorError?: string; __noMatch?: boolean; __value?: T };
      if (tagged?.__selectorError !== undefined) {
        return {
          ok: false,
          error:
            `invalid CSS selector ${JSON.stringify(selector)}: ${tagged.__selectorError}. ` +
            `Selectors here go straight to the page's own document.querySelector — plain CSS only. ` +
            `Playwright/Puppeteer extensions (:has-text(...), text=..., >> , xpath=...) are NOT supported; ` +
            `use a CSS selector, or browser_eval if you need to match on text content.`,
        };
      }
      if (tagged?.__noMatch) return { ok: false, error: `no element matches selector ${JSON.stringify(selector)}` };
      return { ok: true, value: tagged.__value as T };
    } catch (err) {
      return { ok: false, error: `failed to evaluate selector ${JSON.stringify(selector)} in the page: ${String(err)}` };
    }
  }

  async function clickSelector(
    id: string,
    selector: string,
  ): Promise<{ ok: true; x: number; y: number } | { ok: false; error: string }> {
    const found = await withSelector<{ x: number; y: number }>(
      id,
      selector,
      `el.scrollIntoView({ block: "center", inline: "center" });
       const r = el.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
    );
    if (!found.ok) return found;
    const { x, y } = found.value;
    clickAtPoint(id, x, y);
    return { ok: true, x, y };
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
      const found = await withSelector<{ x: number; y: number }>(
        id,
        selector,
        `const r = el.getBoundingClientRect();
         return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
      );
      if (!found.ok) return found;
      ({ x, y } = found.value);
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
    const found = await withSelector<QueryResult>(
      id,
      selector,
      `const r = el.getBoundingClientRect();
       return {
         exists: true,
         text: (el.innerText ?? el.textContent ?? "").slice(0, 2000),
         value: "value" in el ? String(el.value) : undefined,
         href: "href" in el ? String(el.href) : undefined,
         checked: "checked" in el ? Boolean(el.checked) : undefined,
         disabled: "disabled" in el ? Boolean(el.disabled) : undefined,
         rect: { x: r.x, y: r.y, width: r.width, height: r.height },
       };`,
    );
    // `exists: false` continua sendo uma RESPOSTA, não um erro: perguntar
    // "esse elemento está na página?" e ouvir "não" é o uso normal desta
    // tool. Só o seletor inválido (e uma falha real de avaliação) viram
    // `ok: false` — é essa a distinção que faltava.
    if (!found.ok) {
      if (found.error.startsWith("no element matches")) return { ok: true, exists: false };
      return found;
    }
    return { ok: true, ...found.value };
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

  function getConsole(id: string, level?: string, limit?: number): { ok: true; messages: ConsoleEntry[] } | { ok: false; error: string } {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    const filtered = level ? entry.console.filter((m) => m.level === level) : entry.console;
    // Do FIM da lista: o interessante quase sempre é o que acabou de
    // acontecer, não o que a página logou ao carregar.
    return { ok: true, messages: limit ? filtered.slice(-limit) : filtered };
  }

  function getNetwork(id: string, opts: { status?: number; failedOnly?: boolean; urlContains?: string; limit?: number } = {}) {
    const entry = entries.get(id);
    if (!entry) return { ok: false as const, error: `no browser card with id "${id}"` };
    let list = entry.network;
    // `failedOnly` inclui erro de transporte (`status: null`), não só
    // 4xx/5xx — "a chamada de salvar não deu certo" abrange as duas
    // coisas, e um DNS/CORS falhando é justamente o caso que não aparece
    // em lugar nenhum na tela.
    if (opts.failedOnly) list = list.filter((r) => r.error !== undefined || r.status === null || r.status >= 400);
    if (opts.status !== undefined) list = list.filter((r) => r.status === opts.status);
    if (opts.urlContains) list = list.filter((r) => r.url.includes(opts.urlContains as string));
    return { ok: true as const, requests: opts.limit ? list.slice(-opts.limit) : list };
  }

  /**
   * Espera uma condição na página em vez de dormir e torcer (achado ao
   * vivo 2026-09-01). Polling e não MutationObserver de propósito: o
   * observer teria que ser injetado, sobreviver a navegação e ser
   * desmontado sem vazar, e o custo de um `executeJavaScript` a cada
   * 200ms numa página é irrelevante perto disso.
   */
  const WAIT_POLL_MS = 200;
  async function waitFor(
    id: string,
    opts: { selector?: string; text?: string; gone?: boolean; timeoutMs?: number },
  ): Promise<{ ok: true; waitedMs: number } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    if (!opts.selector && !opts.text) return { ok: false, error: "need either selector or text" };
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const started = Date.now();
    const probe = opts.selector
      ? `(() => { try { return !!document.querySelector(${JSON.stringify(opts.selector)}); } catch (err) { return { __selectorError: String((err && err.message) || err) }; } })()`
      : `(() => (document.body ? document.body.innerText : "").includes(${JSON.stringify(opts.text ?? "")}))()`;
    while (Date.now() - started < timeoutMs) {
      if (entries.get(id) !== entry) return { ok: false, error: `browser card "${id}" closed while waiting` };
      let present: unknown;
      try {
        present = await entry.win.webContents.executeJavaScript(probe);
      } catch (err) {
        return { ok: false, error: `failed to evaluate the wait condition: ${String(err)}` };
      }
      // Um seletor inválido nunca vai ficar verdadeiro — falha na hora em
      // vez de gastar o timeout inteiro e reportar "não apareceu".
      if (present && typeof present === "object" && "__selectorError" in present) {
        return { ok: false, error: `invalid CSS selector ${JSON.stringify(opts.selector)}: ${String((present as { __selectorError: string }).__selectorError)}` };
      }
      if (Boolean(present) === !opts.gone) return { ok: true, waitedMs: Date.now() - started };
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
    const what = opts.selector ? `selector ${JSON.stringify(opts.selector)}` : `text ${JSON.stringify(opts.text)}`;
    return { ok: false, error: `timed out after ${timeoutMs}ms waiting for ${what} to ${opts.gone ? "disappear" : "appear"}` };
  }

  /**
   * Achado ao vivo (2026-09-01): "não existe snapshot por árvore de
   * acessibilidade / ref pra mirar um elemento sem já saber o seletor" — o
   * agente teve que cair pra `browser_eval` com
   * `querySelectorAll` + comparação manual de `textContent` pra achar o
   * botão "Adicionar nota".
   *
   * Isto é o mínimo que resolve o problema real, não uma árvore de
   * acessibilidade de verdade: lista o que é INTERATIVO e VISÍVEL, com o
   * nome que um humano lê na tela, e carimba `data-stellar-ref` em cada um
   * pra que `browser_click`/`browser_type` possam mirar por `ref` depois.
   *
   * Três decisões que o formato exige:
   *
   *  - **Nome acessível na ordem certa**: `aria-label`, depois o `<label>`
   *    associado, depois `placeholder`/`title`/`alt`/`value`, e só então o
   *    texto visível. Um botão de ícone só tem `aria-label`; um input só
   *    tem label ou placeholder. Cair direto no `innerText` acharia
   *    "" pra metade dos controles de uma UI real.
   *  - **Só o que está visível**: `getClientRects().length` mais
   *    `visibility`/`opacity`. Um menu fechado tem os itens no DOM e
   *    mirá-los produz um clique que não acontece — pior que não listar.
   *  - **Os refs são reemitidos a cada chamada**, e o carimbo anterior é
   *    limpo. Um ref é válido até a próxima navegação ou re-render, igual
   *    ao Playwright MCP: guardar ref velho e clicar depois é justamente o
   *    erro que uma numeração estável convidaria.
   */
  const SNAPSHOT_MAX_ELEMENTS = 400;
  async function pageSnapshot(id: string): Promise<{ ok: true; url: string; title: string; elements: PageElement[]; truncated: boolean } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(`
        (() => {
          const SEL = [
            "a[href]", "button", "input", "select", "textarea", "summary",
            "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
            "[role=tab]", "[role=menuitem]", "[role=option]", "[role=switch]",
            "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
          ].join(",");
          for (const old of document.querySelectorAll("[data-stellar-ref]")) old.removeAttribute("data-stellar-ref");
          function visible(el) {
            if (el.getClientRects().length === 0) return false;
            const st = getComputedStyle(el);
            return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0;
          }
          function accessibleName(el) {
            const aria = el.getAttribute("aria-label");
            if (aria && aria.trim()) return aria.trim();
            const labelledBy = el.getAttribute("aria-labelledby");
            if (labelledBy) {
              const parts = labelledBy.split(/\s+/).map((x) => document.getElementById(x)).filter(Boolean);
              const joined = parts.map((n) => (n.innerText || n.textContent || "").trim()).join(" ").trim();
              if (joined) return joined;
            }
            if (el.id) {
              const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) {
                const t = (lbl.innerText || lbl.textContent || "").trim();
                if (t) return t;
              }
            }
            const closestLabel = el.closest("label");
            if (closestLabel) {
              const t = (closestLabel.innerText || closestLabel.textContent || "").trim();
              if (t) return t;
            }
            for (const attr of ["placeholder", "title", "alt", "name"]) {
              const v = el.getAttribute(attr);
              if (v && v.trim()) return v.trim();
            }
            const text = (el.innerText || el.textContent || "").trim();
            if (text) return text.replace(/\s+/g, " ").slice(0, 120);
            if (el.value) return String(el.value).slice(0, 120);
            return "";
          }
          function roleOf(el) {
            const explicit = el.getAttribute("role");
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === "a") return "link";
            if (tag === "button" || tag === "summary") return "button";
            if (tag === "select") return "combobox";
            if (tag === "textarea") return "textbox";
            if (tag === "input") {
              const t = (el.getAttribute("type") || "text").toLowerCase();
              if (t === "checkbox" || t === "radio") return t;
              if (t === "submit" || t === "button" || t === "reset") return "button";
              return "textbox";
            }
            return "generic";
          }
          const out = [];
          let n = 0;
          for (const el of document.querySelectorAll(SEL)) {
            if (!visible(el)) continue;
            if (out.length >= ${SNAPSHOT_MAX_ELEMENTS}) return { url: location.href, title: document.title, elements: out, truncated: true };
            const ref = "e" + ++n;
            el.setAttribute("data-stellar-ref", ref);
            const item = { ref, role: roleOf(el), name: accessibleName(el), tag: el.tagName.toLowerCase() };
            if (el.disabled) item.disabled = true;
            if (typeof el.checked === "boolean" && el.checked) item.checked = true;
            if (el.value !== undefined && el.value !== "" && el.type !== "password") item.value = String(el.value).slice(0, 120);
            out.push(item);
          }
          return { url: location.href, title: document.title, elements: out, truncated: false };
        })()
      `);
      const parsed = raw as { url: string; title: string; elements: PageElement[]; truncated: boolean };
      return { ok: true, ...parsed };
    } catch (err) {
      return { ok: false, error: `failed to snapshot the page: ${String(err)}` };
    }
  }

  /** Um `ref` do `pageSnapshot` vira um seletor CSS comum — todo o resto do
   * caminho (click/type/scroll/query) segue exatamente igual. */
  function refSelector(ref: string): string {
    return `[data-stellar-ref="${ref.replace(/"/g, '\\"')}"]`;
  }


  /** Captura a página do card, e SÓ ela (achado ao vivo 2026-09-01: "eu
   * gostaria que o snapshot fosse cirúrgico e fizesse apenas do card e
   * nada mais"). O `snapshot` de sempre fotografa a JANELA DO APP recortada
   * onde o card está no board — então pega o fundo do canvas por baixo de
   * cantos arredondados, pega qualquer card sobreposto, sai na resolução
   * "tamanho na tela × zoom do board", e trunca o que estiver fora da área
   * visível. Aqui não existe board nenhum: a BrowserWindow offscreen deste
   * card é uma superfície própria, então a captura é exatamente o conteúdo
   * renderizado, na resolução real, independente de onde (ou se) o card
   * aparece na tela. */
  async function capturePage(id: string): Promise<{ ok: true; png: Buffer } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const image = await entry.win.webContents.capturePage();
      return { ok: true, png: image.toPNG() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  function destroy(id: string) {
    const entry = entries.get(id);
    if (entry) wcIdToCardId.delete(entry.win.webContents.id);
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
    refreshScaleFactor,
    liveIds,
    forceScaleFactor,
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
    getConsole,
    getNetwork,
    waitFor,
    pageSnapshot,
    refSelector,
    capturePage,
    destroy,
    destroyAll,
  };
}
