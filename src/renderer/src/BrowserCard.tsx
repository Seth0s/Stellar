import { memo, useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import type { Rect } from "./board-model";
import styles from "./BrowserCard.module.css";

// DESIGN-BACKLOG.md §2.1 Item E — Mobile/Tablet mirroring the real
// devices CentralByte's own presets target. "Fluido" (free resize) has
// no distinct action here — every card in this app already resizes
// freely by default, unlike CentralByte's panes which can be locked to
// a fixed size; there's nothing for a "go back to fluid" preset to undo.
const VIEWPORT_PRESETS: { label: string; icon: "viewportMobile" | "viewportTablet"; w: number; h: number }[] = [
  { label: "Mobile (390×844)", icon: "viewportMobile", w: 390, h: 844 },
  { label: "Tablet (768×1024)", icon: "viewportTablet", w: 768, h: 1024 },
];

// Must stay in sync with browser-registry.ts's own BROWSER_SUPERSAMPLE/
// BROWSER_MAX_DENSITY — `applyResize` below mirrors the exact same
// `factor` the main process really applies, so `contentSizeRef` (click-
// mapping, `toCanvasPoint`) matches the real offscreen content size
// instead of drifting from it. Achado ao vivo (2026-09-02, monitor 4K
// real do usuário): um `BROWSER_SUPERSAMPLE` fixo, sem teto, ignora o
// `scaleFactor` real do monitor ao decidir o quanto empilhar por cima —
// `BROWSER_MAX_DENSITY` teta o fator TOTAL (scaleFactor × supersample),
// não só o supersample sozinho.
const BROWSER_SUPERSAMPLE = 3;
const BROWSER_MAX_DENSITY = 2;

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
  // Achado ao vivo (2026-09-01) — bug real de clique impreciso sempre que
  // o content size real da BrowserWindow offscreen diverge do tamanho de
  // mundo do rect (o único caso hoje: `scaleFactor` != 1, Item 6 abaixo).
  // `toCanvasPoint` media a fração do clique dentro do retângulo REAL na
  // tela (`box`, já pós-transform de zoom do `.world`) e multiplicava por
  // `rect.w`/`h` — o tamanho de mundo, sem scaleFactor — mas o espaço de
  // coordenadas que `sendInputEvent` espera é o content size REAL da
  // BrowserWindow offscreen. Mantém o tamanho real aplicado (o que
  // `browser-registry.ts`'s `resize()` realmente setou) num ref,
  // atualizado toda vez que um resize real é disparado — não recalcula a
  // partir de `scaleFactorRef` puro aqui porque o valor "vivo" e o
  // realmente aplicado no offscreen podem divergir brevemente entre o
  // disparo do resize e o próximo frame.
  const contentSizeRef = useRef({ w: rect.w, h: rect.h });
  // Item 6 (Trilha B) — resolved once from `browser:create`'s response
  // (`browser-registry.ts`'s `resize()` doc comment has the full story on
  // why this can't be true HiDPI supersampling and what it trades off).
  // Starts at 1 (no-op) until the async `create()` call below resolves —
  // an early resize before then just uses standard density; the next
  // real resize corrects it, same bootstrapping gap `contentSizeRef`
  // itself already has.
  const scaleFactorRef = useRef(1);
  // Achado ao vivo (2026-09-02, escrevendo o teste do item de troca de
  // monitor) — espelha `rect.w`/`rect.h` atuais pro efeito de
  // `onScaleFactorChanged` abaixo poder ler o valor ATUAL sem precisar
  // dele nas próprias deps (o que forçaria remover/recriar o listener de
  // IPC a cada tick de resize — uma pequena janela onde NENHUM listener
  // está registrado, e um evento real chegando bem nessa hora seria
  // perdido de vez, nunca reagido; confirmado ao vivo com um teste
  // isolado antes deste fix — o evento chegava no processo do renderer
  // mas `BrowserCard.tsx` nunca disparava o resize). Mesmo espírito de
  // `scaleFactorRef`/`contentSizeRef` acima: um ref evita que a IDENTIDADE
  // do valor entre nas deps de um efeito que precisa ficar estável (aqui,
  // "só recriar quando o card muda de verdade"). Zoom não faz mais parte
  // disto (decoupled a pedido do usuário — ver `applyResize` acima).
  const rectRef = useRef({ w: rect.w, h: rect.h });
  rectRef.current = { w: rect.w, h: rect.h };
  const [menuOpen, setMenuOpen] = useState(false);
  // Pendentes #188 ("hover não responsivo"/"textarea não responde") —
  // relato ao vivo confirmado pelo usuário como sendo dentro da PÁGINA
  // carregada, não na UI do Stellar. Medido ao vivo: `isFocused` (abaixo)
  // é só "sou o card mais no topo do z-order" — 2 browser cards lado a
  // lado, sem se sobrepor, o que NÃO é topmost pinta a 8fps
  // (`UNFOCUSED_FRAME_RATE`, browser-registry.ts) mesmo recebendo hover
  // real e contínuo (mousemove é sempre forwardado, sem gate de foco —
  // `onCanvasPointerMove` abaixo). Um cursor/tooltip/dropdown que segue o
  // mouse na página embutida travava visivelmente a ~125ms por frame,
  // exatamente o sintoma relatado. `hovering` cobre esse caso sem mexer
  // no z-order/raise real: enquanto o ponteiro está fisicamente sobre o
  // canvas, a página pinta em taxa cheia, esteja ou não no topo da pilha.
  const [hovering, setHovering] = useState(false);
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

  // Pendentes #188 — menu de contexto nativo do Chromium embutido. O
  // botão direito real já chega na página via `onCanvasPointerDown`'s
  // forward normal de mouse (mouseButtonName cobre "right"); o Chromium
  // da página offscreen dispara `context-menu` sozinho, main process
  // reencaminha aqui. `params.x/y` chegam no espaço de CONTEÚDO
  // (`contentSizeRef`, mesmo de `toCanvasPoint`) — a conversão inversa
  // abaixo (conteúdo → tela real) é o que `Menu.popup({window,x,y})`
  // precisa, já que ele posiciona relativo à janela real do app, não ao
  // webContents offscreen (que nunca teve posição de tela nenhuma).
  useEffect(() => {
    const offMenu = window.browser.onContextMenu((menuId, params) => {
      if (menuId !== id) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const { w: contentW, h: contentH } = contentSizeRef.current;
      const screenX = box.left + (params.x / contentW) * box.width;
      const screenY = box.top + (params.y / contentH) * box.height;
      void window.browser.showContextMenu(id, screenX, screenY, params);
    });
    return () => {
      offMenu();
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
  // topmost card instead of always painting at full 30fps. `hovering`
  // (see its own doc comment above) overrides the throttle while the
  // pointer is physically over this card, regardless of z-order.
  useEffect(() => {
    void window.browser.setFocused(id, isFocused || hovering);
  }, [id, isFocused, hovering]);

  // Trilha A do navegador (browser-registry.ts's `resize` doc comment)
  // originalmente também acompanhava o zoom do board, não só o tamanho de
  // mundo do card — revertido a pedido explícito do usuário (2026-09-02:
  // "o navegador não precisa ser afetado pelo efeito do zoom aumentar ou
  // diminuir a fonte"). `factor` é `scaleFactorRef.current × BROWSER_
  // SUPERSAMPLE` (densidade real do monitor × supersample fixo, ver
  // browser-registry.ts's `resize` pro porquê do supersample precisar de
  // `setZoomFactor` combinado, não só `setContentSize`) — nenhum dos dois
  // depende do zoom do board. Um resize genuíno de rect (arraste da alça,
  // já throttled por rAF no CardFrame) dispara na hora; zoom puro do board
  // não dispara mais NADA aqui (nem debounce, nem re-render da página
  // embutida) — o card só fica visualmente maior/menor na tela via o
  // `scale(zoom)` do `.world`/projeção de tela, exatamente como qualquer
  // outro card, sem recodificar um JPEG novo a cada passo de zoom.
  function applyResize(w: number, h: number) {
    const factor = Math.min(scaleFactorRef.current * BROWSER_SUPERSAMPLE, BROWSER_MAX_DENSITY);
    contentSizeRef.current = {
      w: Math.max(1, Math.round(w * factor)),
      h: Math.max(1, Math.round(h * factor)),
    };
    void window.browser.resize(id, w, h);
  }

  useEffect(() => {
    const w = Math.round(rect.w);
    const h = Math.round(rect.h);
    if (lastSizeRef.current.w === w && lastSizeRef.current.h === h) return;
    lastSizeRef.current = { w, h };
    applyResize(w, h);
  }, [id, rect.w, rect.h]);

  // Achado ao vivo (2026-09-02, pedido explícito: "não apenas monitor
  // 4K") — browser-registry.ts's `refreshScaleFactor` doc comment tem a
  // história completa. `scaleFactorRef` (linha ~177) era só um espelho
  // local do valor resolvido na CRIAÇÃO do card (`browser:create`'s
  // retorno) — nunca atualizava depois, então mesmo com o processo
  // principal já sabendo do novo monitor, este card continuava calculando
  // `applyResize`'s `factor` com o scaleFactor ANTIGO. Atualiza o espelho
  // E dispara um resize de verdade com o rect ATUAL (mesma função que o
  // efeito de resize acima já usa) — sem isso o valor certo chegaria no
  // main process mas nunca voltaria a afetar ESTE card já criado. Deps só
  // `[id]` (igual ao efeito de `onFrame` acima) — lê o rect ATUAL via
  // `rectRef`, não como closure direta, propositalmente: ver o comentário
  // de `rectRef` pro porquê (achado ao vivo real, não hipotético — um
  // teste isolado pegou o listener perdendo o evento com a versão
  // anterior, que tinha rect.w/rect.h nas deps).
  useEffect(() => {
    const off = window.browser.onScaleFactorChanged((changedId, scaleFactor) => {
      if (changedId !== id) return;
      scaleFactorRef.current = scaleFactor;
      const { w, h } = rectRef.current;
      applyResize(Math.round(w), Math.round(h));
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function toCanvasPoint(e: React.PointerEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    // The embedded page's own coordinate space is `contentSizeRef.current`
    // (logical CSS px — what `resize()` REALLY set the offscreen window's
    // content size to, post-scaleFactor), NOT `rect.w`/`rect.h` (the
    // card's world-space size) and not `canvas.width`/`height` (the raw
    // JPEG's device-pixel size) either. Bug found live (2026-09-01): using
    // `rect.w`/`rect.h` here was only correct at scaleFactor=1 by
    // coincidence — `resize()` scales the real offscreen content by the
    // monitor's real density, so on a HiDPI monitor a click was landing at
    // a fraction of its intended position inside the embedded page.
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
  // Companion to `onCanvasPointerLeave` below — see `hovering`'s own doc
  // comment (near its useState) for why this exists. Not gated by
  // `interactionMode`: a card should paint at full rate while the
  // pointer is over it regardless of which tool is active.
  function onCanvasPointerEnter() {
    setHovering(true);
  }
  // Achado ao vivo (2026-08-31) — sem isso, qualquer `:hover`/tooltip/
  // dropdown que a página embutida abriu ao passar o mouse nunca fecha
  // quando o cursor sai do canvas (nada aqui nunca disparava um sinal
  // de "saiu"). x/y não importam pro tipo `mouseLeave` em si.
  function onCanvasPointerLeave() {
    setHovering(false);
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
    // insertText/paste/copy/cut doc comment), so the actual data movement
    // goes through the dedicated Electron API below.
    //
    // Achado ao vivo (2026-09-02, bug reportado pelo usuário — "o ato de
    // copiar, copia 3 vezes a mesma coisa"): o comentário original aqui
    // dizia que ALÉM de chamar o método dedicado, encaminhar o keyDown
    // cru "também" era inofensivo. Não é — confirmado ao vivo com
    // `smoke-browser-keyboard-gaps.mjs` contra um campo editável real:
    // um Ctrl+V colava o texto do clipboard DUAS vezes, não uma. O
    // `sendKey` cru abaixo, quando também alcança um elemento focado de
    // verdade no WebContents offscreen, dispara o comando de edição
    // NATIVO do próprio Chromium pra Ctrl+V/C/X (rotina interna de
    // atalho-pra-comando-de-edição, separada de qualquer listener JS de
    // 'keydown' da página) — a MESMA ação do método dedicado
    // (`webContents.paste()`/`.copy()`/`.cut()`), disparando duas vezes
    // pro mesmo evento físico. `return` cedo aqui evita esse segundo
    // disparo: o método dedicado já é o caminho correto e completo (é
    // exatamente por isso que ele existe, ver doc comment do
    // browser-registry.ts), o encaminhamento cru nunca era necessário
    // pra copy/paste/cut especificamente (diferente de um atalho
    // arbitrário de página tipo Ctrl+S, que continua sendo encaminhado
    // normalmente abaixo).
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      void window.browser.paste(id);
      return;
    }
    if (mod && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      void window.browser.copy(id);
      return;
    }
    if (mod && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      void window.browser.cut(id);
      return;
    }

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
      className={styles.browserCard}
      kind="browser"
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
        <div className={styles.browserCardAddress} data-role="browser-address">
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
              className={styles.browserCardOwner}
              data-role="browser-owner"
              title={`aberto por card #${ownerCardId} — clique pra ir até lá`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onFocusOwner}
            >
              #{ownerCardId}
            </button>
          )}
          {consoleBadgeCount > 0 && (
            <span
              className={styles.browserCardConsoleBadge}
              data-role="browser-console-badge"
              data-severity={consoleCounts.error > 0 ? "error" : "warning"}
              title={`${consoleCounts.error} erro(s), ${consoleCounts.warning} aviso(s) no console`}
            >
              {consoleBadgeCount}
            </span>
          )}
          <button
            ref={favBtnRef}
            className={styles.browserCardFavoriteBtn}
            data-role="browser-favorite-btn"
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
        className={styles.browserCardBody}
        data-role="browser-body"
        tabIndex={0}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerEnter={onCanvasPointerEnter}
        onPointerUp={onCanvasPointerUp}
        onPointerLeave={onCanvasPointerLeave}
        onWheel={onCanvasWheel}
        onKeyDown={onCanvasKeyDown}
        onKeyUp={onCanvasKeyUp}
        onCompositionEnd={onCanvasCompositionEnd}
        // O menu de verdade chega assíncrono, via `onContextMenu` do
        // `window.browser` acima (a página embutida é quem decide os
        // itens) — este handler só evita que o botão direito também
        // dispare algo do PRÓPRIO app (radial menu do board, menu OS
        // default) por cima/embaixo do menu real.
        onContextMenu={(e) => e.preventDefault()}
      />
      <Popover anchorRef={menuBtnRef} open={menuOpen} onClose={() => setMenuOpen(false)} className={styles.browserCardMenu} dataRole="browser-menu">
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
          <div className={styles.browserCardMenuInfo} data-severity={consoleCounts.error > 0 ? "error" : "warning"}>
            {consoleCounts.error} erro(s), {consoleCounts.warning} aviso(s) no console
          </div>
        )}
        {(ownerCardId || consoleBadgeCount > 0) && <div className={styles.browserCardFavDivider} />}
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
      <Popover anchorRef={favBtnRef} open={favMenuOpen} onClose={() => setFavMenuOpen(false)} className={`${styles.browserCardMenu} ${styles.browserCardFavoritesMenu}`} dataRole="browser-favorites-menu">
        <button onClick={toggleFavorite}>
          <Icon name="favorite" size={14} />
          {isFavorited ? "Remover dos favoritos" : "Favoritar esta página"}
        </button>
        {favorites.length > 0 && (
          <>
            <div className={styles.browserCardFavDivider} />
            <div className={styles.browserCardFavList}>
              {favorites.map((fav) => (
                <div key={fav.url} className={styles.browserCardFavRow} data-role="browser-fav-row" onClick={() => goToFavorite(fav.url)}>
                  <span className={styles.browserCardFavTitle} title={fav.url}>
                    {fav.title || fav.url}
                  </span>
                  <button className={styles.browserCardFavRemove} data-role="browser-fav-remove" title="Remover" onClick={(e) => void removeFavoriteRow(fav.url, e)}>
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
