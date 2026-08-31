import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { toast } from "./useToast";
import { registerTerminal, unregisterTerminal } from "./terminal-registry";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const ZOOM_MOUSE_EVENT_TYPES = ["mousedown", "mouseup", "mousemove"] as const;

const BASE_FONT_SIZE = 15;
// DESIGN-BACKLOG.md item 57 ponto 10, revisado (SCREEN_SPACE_PROJECTION_
// PLAN.md, Trilha A) — "fonte que acompanha o zoom" começou com influência
// PARCIAL (15%, só pra terminais com agente) porque a motivação original
// era "levemente mais nítido nos extremos", não uma correção completa. O
// blur real foi confirmado ao vivo depois (2026-08-31): o card inteiro já
// escala opticamente via `transform: scale()` (App.tsx) — isso sozinho
// deixa o glifo pequeno-renderizado-e-esticado borrado em zooms altos, já
// que o canvas WebGL do xterm.js continua rasterizando no mesmo tamanho de
// fonte físico independente do zoom, e só 15% do delta de zoom estava
// sendo compensado; os outros 85% continuavam vindo do `scale()` que
// borra. Influência = 1.0 fecha o gap inteiro (fontSize real acompanha o
// zoom 1:1, dentro do clamp abaixo) em vez de só atenuá-lo, sem precisar
// do rewrite completo de screen-space projection — mesmo princípio da
// Fase 3.1 daquele plano, só que já em produção. Em zoom=1 continua dando
// exatamente `BASE_FONT_SIZE` (sem regressão no caso comum, influência
// não muda esse ponto de ancoragem).
const FONT_ZOOM_INFLUENCE = 1.0;
const FONT_SIZE_MIN = 11;
const FONT_SIZE_MAX = 22;
function fontSizeForZoom(zoom: number): number {
  const raw = BASE_FONT_SIZE * (1 - FONT_ZOOM_INFLUENCE + zoom * FONT_ZOOM_INFLUENCE);
  return Math.round(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, raw)));
}

/**
 * Custom FitAddon that uses the entire container width without reserving
 * an empty 14px scrollbar gutter. Default FitAddon subtracts 14px unconditionally
 * whenever scrollback > 0, which leaves an empty vertical gap on the right.
 */
class FullWidthFitAddon extends FitAddon {
  proposeDimensions(): { cols: number; rows: number } | undefined {
    const term = (this as any)._terminal as Terminal | undefined;
    if (!term || !term.element || !term.element.parentElement) return undefined;
    const dims = (term as any)._core?._renderService?.dimensions;
    if (!dims || dims.css.cell.width === 0 || dims.css.cell.height === 0) return undefined;
    const parentStyle = window.getComputedStyle(term.element.parentElement);
    const parentHeight = parseInt(parentStyle.getPropertyValue("height"), 10) || 0;
    const parentWidth = Math.max(0, parseInt(parentStyle.getPropertyValue("width"), 10) || 0);
    const elStyle = window.getComputedStyle(term.element);
    const padding = {
      top: parseInt(elStyle.getPropertyValue("padding-top"), 10) || 0,
      bottom: parseInt(elStyle.getPropertyValue("padding-bottom"), 10) || 0,
      right: parseInt(elStyle.getPropertyValue("padding-right"), 10) || 0,
      left: parseInt(elStyle.getPropertyValue("padding-left"), 10) || 0,
    };
    const availableHeight = parentHeight - (padding.top + padding.bottom);
    const availableWidth = parentWidth - (padding.right + padding.left);
    return {
      cols: Math.max(2, Math.floor(availableWidth / dims.css.cell.width)),
      rows: Math.max(1, Math.floor(availableHeight / dims.css.cell.height)),
    };
  }
}

/**
 * DESIGN-BACKLOG.md item 36 (2/2) — vendoring the Nerd Font glyphs alone
 * (`main.tsx`'s `@azurity/pure-nerd-font` CSS import + the `fontFamily`
 * fallback below) wasn't enough on its own — confirmed live via CDP:
 * `@xterm/addon-webgl` builds its own glyph texture atlas from canvas
 * measurements the FIRST time a character is drawn; if that first draw
 * happens before the browser has actually finished loading the font file,
 * it rasterizes tofu into the atlas — and never redraws it later even
 * once the font finishes loading (re-printing the exact same character
 * confirmed still tofu, `document.fonts.check()` reporting `true` by
 * then didn't matter — the atlas entry was already cached wrong). Module
 * level (not per-card) — this is one shared font, requested once for the
 * whole app's lifetime, not once per terminal. `attach()` below awaits
 * this before ever calling `term.open()`, so the atlas's first-ever draw
 * of any glyph always happens after the font is genuinely ready.
 * `.catch()` — a failed font load must never block a terminal from
 * opening, worst case is falling back to tofu/monospace-default, not "no
 * terminal at all".
 */
const nerdFontReady: Promise<unknown> = document.fonts.load('16px "PureNerdFont"').catch(() => {});

/**
 * DESIGN-BACKLOG.md item 39 — `new Terminal()` never had a `theme`, so
 * xterm.js fell back to its own bundled default palette (pure `#000`
 * background, stock Tango-derived ANSI colors) — confirmed live via pixel
 * sampling to be an exact, unmodified match to the library default, not a
 * subtle drift. It read as "estranho" precisely because it clashes with
 * Stellar's own muted dark tokens (`tokens.css`) everywhere else in the
 * app's chrome. Mapped here to the same hue family — `--danger`/`--good`/
 * `--signal`/`--violet`/`--foam` cover 5 of the 8 base ANSI roles
 * directly; blue and a true cyan/white don't have a dedicated token, so
 * they're new colors chosen to sit in the same muted-cool-dark family
 * (checked against `tokens.css`'s existing hues, not picked freestyle).
 * `cards.css`'s `.terminal-card-body` background must stay in sync with
 * `background` below (same reasoning as its own comment: the DOM
 * container's color has to match the canvas's own background color to
 * hide the fractional-row seam, `theme` alone doesn't reach that div).
 */
const TERMINAL_THEME = {
  background: "#1a1d24", // --panel
  foreground: "#e6e8ec", // --text
  cursor: "#45c8ff", // --foam
  cursorAccent: "#04141c", // --on-accent
  selectionBackground: "rgba(69, 200, 255, 0.25)", // --foam @ 25%
  black: "#1a1d24", // --panel
  red: "#ef6b6b", // --danger
  green: "#4ad87a", // --good
  yellow: "#e8c547", // --signal
  blue: "#5b8dee",
  magenta: "#8f7bff", // --violet
  cyan: "#45c8ff", // --foam
  white: "#b8bfcb",
  brightBlack: "#8b93a1", // --muted
  brightRed: "#ff8787",
  brightGreen: "#6fe89a",
  brightYellow: "#f3d873",
  brightBlue: "#7ea6f5",
  brightMagenta: "#ab9bff",
  brightCyan: "#6fd8ff",
  brightWhite: "#e6e8ec", // --text
};

/**
 * Splits PTY lifecycle from the xterm renderer on purpose: the PTY (a real
 * process, the actual conversation state) must survive a card leaving the
 * viewport.
 *
 * DESIGN-BACKLOG.md item 34 — reported live ("o terminal quebra depois de
 * sair dela ou tirar o foco"), reproduced via CDP: panning a terminal card
 * out of the viewport and back turned it fully blank, even though the
 * underlying process was confirmed still alive (a fresh command typed
 * after the cycle still echoed correctly). Root cause was HERE — Effect 2
 * used to be keyed on `visible` and fully `dispose()`d the xterm.js
 * `Terminal` (including its own internal scrollback buffer, not just the
 * DOM) every time a card left the viewport, then built a brand new one on
 * return. node-pty itself keeps no backlog, so nothing the process wrote
 * during that gap was ever replayed either — the combination is what
 * produced a genuinely empty terminal, not a rendering glitch.
 *
 * Fixed by splitting terminal-instance creation (Effect 2, keyed only on
 * `ptyId` — happens once, cheap, no DOM/GPU involved yet: `new Terminal()`
 * plus `loadAddon()` just allocates buffer/addon state) from attaching it
 * to the DOM and loading the real renderer (Effect 3, gated on `visible`
 * — this is where WebGL context creation actually happens, confirmed by
 * the existing fallback catch below). Effect 3's `openedRef` guard makes
 * that attachment happen at most ONCE per card lifetime: a card that has
 * been viewed once keeps its live instance (and buffer) for as long as it
 * exists on the board, instead of being torn down and rebuilt on every
 * pan cycle. A card that's never been looked at still never pays for a
 * renderer/WebGL context at all — the resource-saving intent behind the
 * original split survives, just scoped to "ever visible" instead of
 * "currently visible".
 */
function handleTerminalWheel(t: Terminal, e: WheelEvent): boolean {
  if (t.buffer.active !== t.buffer.normal) {
    return true;
  }
  if (t.buffer.active.baseY === 0) {
    return false;
  }
  const lines = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 30));
  t.scrollLines(lines);
  return false;
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  id: string,
  providerId: string,
  cwd: string,
  resumeId: string | null,
  continueLast: boolean,
  model: string | null,
  systemPrompt: string | null,
  /** DESIGN-BACKLOG.md item 57 ponto 13 — one-shot text typed into the PTY
   * right after a successful spawn, never executed on its own (no `\r`
   * appended here) — the human still presses Enter. Same "one-shot,
   * never persisted" spirit as `continueLast` (see card-types.ts):
   * created once by `openInstallTerminal` (App.tsx) for a pre-filled
   * install-command terminal, always null for a card restored from the
   * store. */
  initialInput: string | null,
  visible: boolean,
  zoom: number,
) {
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [installHint, setInstallHint] = useState<{ providerId: string; command: string } | null>(null);
  const [discoveredResumeId, setDiscoveredResumeId] = useState<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FullWidthFitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  // Item 34 — guards Effect 3 so the DOM/GPU attachment (`term.open()`)
  // happens at most once per Terminal instance, not once per visibility
  // flip. Reset only when Effect 2 tears the instance down for real.
  const openedRef = useRef(false);
  // Item 34 — lets Effect 4 (reacts to `visible` becoming true) trigger
  // Effect 3's attach function without Effect 3 itself depending on
  // `visible` (which would tear its DOM listeners down on every flip —
  // see the doc comment above Effect 3).
  const attachRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Pedido ao vivo (2026-08-31) — "no claude aparece o path da imagem,
  // quero mascarado (visual só)". `writeImagePathToPty` (registerDomListeners
  // abaixo) escreve o path absoluto real no PTY — a CLI rodando ali
  // precisa dele pra ler o arquivo, então o que É ENVIADO nunca muda.
  // O que MUDA é só o que aparece na TELA: o eco do próprio path (o TTY
  // ecoa de volta o que recebeu, é isso que o usuário via "impresso" no
  // terminal) é interceptado aqui e reescrito ANTES de chegar em
  // `term.write()`, no handler de `pty:data` (Effeito 1 abaixo) — a única
  // coisa que muda é a RENDERIZAÇÃO no xterm.js, o processo real do
  // outro lado do PTY nunca vê nada diferente do que sempre viu.
  const pendingMaskRef = useRef<{ needle: string; replacement: string } | null>(null);
  const maskBufferRef = useRef("");
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Spawn-time-only options, read via ref instead of effect deps below — see
  // the comment on Effect 1's dependency array for why.
  const spawnOptsRef = useRef({ resumeId, continueLast, model, systemPrompt, initialInput });
  spawnOptsRef.current = { resumeId, continueLast, model, systemPrompt, initialInput };

  // Effect 1: PTY lifecycle. Independent of the container/visible — spawns
  // once per identity and keeps running regardless of on-screen visibility.
  useEffect(() => {
    let disposed = false;
    const { resumeId, continueLast, model, systemPrompt, initialInput } = spawnOptsRef.current;
    const spawnOpts = {
      resumeId: resumeId ?? undefined,
      continueLast,
      model: model ?? undefined,
      systemPrompt: systemPrompt ?? undefined,
    };
    window.pty.spawn(id, providerId, cwd, DEFAULT_COLS, DEFAULT_ROWS, spawnOpts).then((result) => {
      if (disposed) return;
      if ("error" in result) {
        setSpawnError(
          result.error === "binary_not_found"
            ? `"${providerId}" não encontrado no PATH`
            : `falha ao iniciar "${providerId}"`,
        );
        if (result.error === "binary_not_found" && result.installCommand) {
          setInstallHint({ providerId, command: result.installCommand });
        }
        return;
      }
      ptyIdRef.current = result.id;
      if (initialInput) void window.pty.write(id, initialInput);
      setPtyId(result.id);
    });

    // Achado ao vivo escrevendo isto: o eco de um path colado pode chegar
    // partido em mais de um chunk de `pty:data` (o TTY não garante um
    // chunk por escrita) — por isso bufferiza em vez de checar `data`
    // isolado. Desiste (flush cru) se o buffer já passou do tamanho do
    // needle sem achar o match — evita segurar output real de verdade
    // indefinidamente se o eco não vier byte-a-byte igual por algum
    // motivo (ex.: o processo rodando ali não tem echo local ligado).
    function writeMasked(data: string) {
      const pending = pendingMaskRef.current;
      if (!pending) {
        termRef.current?.write(data);
        return;
      }
      maskBufferRef.current += data;
      const idx = maskBufferRef.current.indexOf(pending.needle);
      if (idx !== -1) {
        const before = maskBufferRef.current.slice(0, idx);
        const after = maskBufferRef.current.slice(idx + pending.needle.length);
        termRef.current?.write(before + pending.replacement + after);
        pendingMaskRef.current = null;
        maskBufferRef.current = "";
        return;
      }
      if (maskBufferRef.current.length >= pending.needle.length) {
        termRef.current?.write(maskBufferRef.current);
        pendingMaskRef.current = null;
        maskBufferRef.current = "";
      }
    }

    const offData = window.pty.onData((id, data) => {
      if (id === ptyIdRef.current) writeMasked(data);
    });
    const offExit = window.pty.onExit((id, code) => {
      if (id === ptyIdRef.current) setExitCode(code);
    });
    const offSessionFound = window.pty.onSessionFound((id, sessionId) => {
      if (id === ptyIdRef.current) setDiscoveredResumeId(sessionId);
    });

    return () => {
      disposed = true;
      offData();
      offExit();
      offSessionFound();
      if (ptyIdRef.current) void window.pty.kill(ptyIdRef.current);
      ptyIdRef.current = null;
      setPtyId(null);
    };
    // resumeId/continueLast/model/systemPrompt are deliberately NOT deps.
    // Confirmed via CDP: App.tsx's resumeIdDiscovered() writes a freshly
    // *discovered* session id back into this same live card's `resumeId`
    // prop (so a future app restart can resume it) — with these in the dep
    // array, that write immediately re-ran this whole effect, killing the
    // just-spawned, still-starting process and respawning it with
    // `--resume <id>` on a session barely a few hundred ms old. cursor-agent
    // in particular exits(0) right away when asked to resume that; other
    // providers likely tolerate it more quietly, but it's wrong for all of
    // them — none of these four should ever force a respawn of an already
    // running session. They're spawn-time-only options (see spawnOptsRef
    // above), not identity: only id/providerId/cwd changing means "this is
    // actually a different session, tear down and start over."
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, providerId, cwd]);

  // Effect 2: creates the xterm.js Terminal instance itself — cheap, no
  // DOM/GPU involved yet (`new Terminal()` + `loadAddon()` just allocate
  // buffer/addon state; see Effect 3's doc comment for where the real
  // renderer gets attached). Keyed ONLY on `ptyId`, not `visible` — item
  // 34: this used to be entangled with the DOM-attach effect and torn
  // down/rebuilt on every visibility flip, destroying the buffer along
  // with it. Runs once per real PTY identity; `window.pty.onData` (Effect
  // 1 above) writes into `termRef.current` unconditionally, so the buffer
  // keeps accumulating even while the card is off-screen.
  useEffect(() => {
    if (!ptyId) return;
    function buildTerminal(withWebgl: boolean) {
      const t = new Terminal({ fontSize: BASE_FONT_SIZE, cursorBlink: true, fontFamily: '"JetBrains Mono", "PureNerdFont", monospace', theme: TERMINAL_THEME });
      const f = new FullWidthFitAddon();
      t.loadAddon(f);
      if (withWebgl) {
        try {
          t.loadAddon(new WebglAddon());
        } catch {
          // Some GPU/driver combinations report WebGL2 as available here but
          // only actually fail later, inside open() below — this check still
          // catches the common case for free.
        }
      }
      t.attachCustomWheelEventHandler((e) => handleTerminalWheel(t, e));
      return { t, f };
    }
    const { t: term, f: fit } = buildTerminal(true);
    termRef.current = term;
    fitRef.current = fit;
    registerTerminal(id, term);
    const onTermData = term.onData((data) => {
      if (ptyIdRef.current) void window.pty.write(ptyIdRef.current, data);
    });
    return () => {
      unregisterTerminal(id);
      onTermData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      openedRef.current = false;
    };
  }, [ptyId]);

  // Effect 3: attaches the (already-created) Terminal to its persistent
  // DOM container and loads the real renderer — the actually-expensive
  // part (WebGL context creation happens lazily inside `open()`, not
  // `loadAddon()` above, confirmed by the fallback catch below). Keyed
  // on `[containerRef, ptyId]` — deliberately NOT `visible` — so this
  // attachment (and its DOM listeners) happens AT MOST ONCE per Terminal
  // instance (`openedRef` guard) and is torn down only on a real identity
  // change, never merely because the card panned out of view. `visible`
  // still gates WHEN the attach happens (Effect 4 below calls `attach()`
  // the first time it turns true) — a card never looked at still never
  // pays for a renderer/WebGL context, preserving the original
  // resource-saving intent, just scoped to "ever visible" instead of
  // "currently visible".
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ptyId) return;

    async function attach() {
      if (openedRef.current) return;
      let term = termRef.current;
      let fit = fitRef.current;
      if (!term || !fit || !el) return;
      // Set synchronously, BEFORE the await below — a second attach()
      // call racing in during the await must still see this and bail,
      // same at-most-once guarantee as before this item.
      openedRef.current = true;
      await nerdFontReady;
      // Re-check after the await: the containing effect could have been
      // cleaned up (card closed/identity changed) while we were waiting.
      if (!containerRef.current || termRef.current !== term) return;
      try {
        term.open(el);
      } catch {
        // Confirmed on this machine: an ANGLE/libGLESv2 crash surfaced here,
        // not above — WebglAddon's context creation happens lazily during
        // open(), not loadAddon(). The terminal instance may be left
        // half-initialized after that; start over clean with the plain
        // canvas2d renderer instead of trying to recover it in place. A
        // one-time rebuild here (unlike the rest of this hook) is fine —
        // it only ever happens on the very first attach, before any real
        // content exists yet.
        term.dispose();
        const rebuilt = buildTerminalNoWebgl();
        term = rebuilt.t;
        fit = rebuilt.f;
        termRef.current = term;
        fitRef.current = fit;
        term.open(el);
      }
      fit.fit();
      if (ptyIdRef.current) void window.pty.resize(ptyIdRef.current, term.cols, term.rows);
      registerDomListeners(term, fit, el);
    }
    function buildTerminalNoWebgl() {
      const t = new Terminal({ fontSize: BASE_FONT_SIZE, cursorBlink: true, fontFamily: '"JetBrains Mono", "PureNerdFont", monospace', theme: TERMINAL_THEME });
      const f = new FullWidthFitAddon();
      t.loadAddon(f);
      t.attachCustomWheelEventHandler((e) => handleTerminalWheel(t, e));
      return { t, f };
    }

    function registerDomListeners(term: Terminal, _fit: FullWidthFitAddon, el: HTMLDivElement) {
      // "não consigo mandar foto pelo terminal" (2026-08-27) — xterm.js's
      // own default paste handler only ever reads `text/plain`; an image on
      // the clipboard silently produced nothing. Capture-phase listener on
      // `el` (the container), so this runs BEFORE xterm's own listener on
      // its internal hidden textarea sees the event — same technique
      // `correctZoomCoords` below already uses for the same reason. A
      // plain-text paste (no image/* item present) is left untouched —
      // `preventDefault`/`stopImmediatePropagation` only fire once an image
      // is actually found, so xterm's normal text-paste path is unaffected.
      // Debounce shared by both paths below so a single physical paste
      // never writes the path twice into the PTY (item 32 finding: a real
      // Ctrl+(Shift+)V keystroke can trigger BOTH a `keydown` and a
      // `paste` DOM event for the same action; without this guard an
      // image caught by one path could get written again by the other).
      let lastHandledAt = 0;
      let pastedImageCount = 0;
      function writeImagePathToPty() {
        lastHandledAt = Date.now();
        void window.clipboardImage.save().then((result) => {
          if (!result.ok) {
            toast(`falha ao colar imagem: ${result.error}`);
            return;
          }
          // Caminho absoluto, entre aspas (evita quebrar em espaço), com um
          // espaço à direita pra o usuário continuar digitando — mesma
          // convenção de um drag-and-drop de arquivo pro terminal. O que
          // dá pra garantir aqui termina no texto chegando certo no PTY;
          // se a CLI rodando ali de fato trata isso como anexo de imagem
          // depende dela (ver main/clipboard-image.ts).
          // `ptyIdRef.current!` — este listener só existe depois de attach(),
          // que só roda com um `ptyId` real (guard no topo do efeito); a
          // ref (não a variável fechada) é usada porque este listener
          // sobrevive além de qualquer re-render, mesmo sem se re-registrar.
          const typed = `"${result.path}" `;
          // Pedido ao vivo (2026-08-31) — máscara só visual: o que é
          // ENVIADO pro PTY continua sendo o path real (`typed`, sem essa
          // linha o comportamento é idêntico ao de antes); o que o
          // usuário VÊ na tela vira "[imagem #N]" — o eco desse mesmo
          // `typed` é interceptado e reescrito no handler de `pty:data`
          // (Effeito 1, `writeMasked`), armado aqui logo antes de
          // escrever.
          pastedImageCount++;
          pendingMaskRef.current = { needle: typed, replacement: `[imagem #${pastedImageCount}] ` };
          maskBufferRef.current = "";
          void window.pty.write(ptyIdRef.current!, typed);
          toast("imagem colada — caminho inserido no terminal");
        });
      }

      function onPaste(e: ClipboardEvent) {
        const items = e.clipboardData?.items;
        if (!items) return;
        const hasImage = Array.from(items).some((item) => item.type.startsWith("image/"));
        if (!hasImage) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (Date.now() - lastHandledAt < 500) return;
        writeImagePathToPty();
      }
      el.addEventListener("paste", onPaste, { capture: true });

      // item 32 — Ctrl+Shift+V (o atalho de colar de verdade em terminal no
      // Linux; Ctrl+V sozinho costuma estar reservado por readline/outra
      // coisa) mapeia, no Chromium, pro comando nativo "paste and match
      // style" — que é deliberadamente só-texto: com a área de
      // transferência contendo só uma imagem (sem fallback text/plain), o
      // `paste` DOM event que ele dispara chega com `clipboardData.types`
      // VAZIO (confirmado ao vivo via CDP, não assumido) — `onPaste` acima
      // nunca via a imagem. A Clipboard API assíncrona (`navigator.
      // clipboard.read()`) não tem essa limitação (lê qualquer MIME real
      // da área de transferência, confirmado ao vivo também).
      //
      // `preventDefault`/`stopImmediatePropagation` chamados DEPOIS de um
      // `await` não suprimem mais nada — o navegador já processou a ação
      // padrão da tecla antes da Promise resolver (isso não é opcional,
      // é a spec de eventos DOM). Por isso os dois são chamados aqui de
      // forma SÍNCRONA, assim que a combinação é reconhecida, tomando
      // conta do Ctrl+(Shift+)V por inteiro; o caso de texto (a grande
      // maioria dos pastes) é replicado chamando `term.paste()` — o mesmo
      // método que o handler nativo do próprio xterm.js usaria por baixo
      // dos panos — pra não perder bracketed-paste-mode nem qualquer outra
      // normalização que ele já faz.
      function onKeyDown(e: KeyboardEvent) {
        // Pedido ao vivo (2026-08-31) — "não consigo copiar textos".
        // xterm.js renderiza em canvas/WebGL — não existe seleção de
        // texto real do DOM/navegador ali, só a seleção LÓGICA que o
        // próprio xterm rastreia (`term.getSelection()`); sem esse
        // handler não existia NENHUM jeito de tirar texto selecionado do
        // terminal. Ctrl+Shift+C (não Ctrl+C sozinho) — convenção de
        // todo terminal Linux de verdade (GNOME Terminal, Konsole,
        // xterm), já que Ctrl+C sozinho continua reservado pro SIGINT
        // (`interrupt()` abaixo, também o botão "Ctrl+C" do header) —
        // sobrecarregar Ctrl+C pra copiar quando há seleção mudaria esse
        // comportamento já estabelecido, arriscado sem necessidade.
        if (e.ctrlKey && e.shiftKey && (e.key === "c" || e.key === "C")) {
          const selection = term.getSelection();
          if (selection) {
            e.preventDefault();
            e.stopImmediatePropagation();
            void navigator.clipboard.writeText(selection).then(() => toast("copiado"));
          }
          return;
        }
        if (!e.ctrlKey || (e.key !== "v" && e.key !== "V")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void (async () => {
          try {
            const items = await navigator.clipboard.read();
            const hasImage = items.some((item) => item.types.some((t) => t.startsWith("image/")));
            if (hasImage) {
              if (Date.now() - lastHandledAt < 500) return;
              writeImagePathToPty();
              return;
            }
          } catch {
            // sem permissão/API pra `read()` — ainda tenta o fallback de texto abaixo
          }
          try {
            const text = await navigator.clipboard.readText();
            if (text) term.paste(text);
          } catch {
            // clipboard genuinely inacessível aqui — nada mais a fazer
          }
        })();
      }
      el.addEventListener("keydown", onKeyDown, { capture: true });

      // xterm measures its own cell size from canvas font metrics (or
      // offsetWidth as a DOM fallback) — both ignore the `.world` ancestor's
      // CSS `transform: scale()` used for optical zoom (App.tsx). The click
      // position it reads via getBoundingClientRect() DOES reflect that scale.
      // Under zoom != 1 this mismatches the units xterm divides by, so every
      // click/drag (text selection and any mouse-tracking-protocol report
      // alike) lands on the wrong cell, off by roughly the zoom factor —
      // confirmed empirically via CDP, not assumed (see AGENTS.md). Fix:
      // intercept in the capture phase, before xterm's own listeners on this
      // same element see the event, and re-dispatch a corrected copy with
      // clientX/Y scaled back into the 1:1 space xterm's cell math expects.
      // Known gap: a drag that leaves this element's bounds while zoomed
      // (xterm tracks that continuation on `document`, which this listener
      // doesn't reach) stays uncorrected — narrow edge case, documented rather
      // than chased further.
      //
      // A wheel event ALSO needs interception at zoom 1 — pedido ao vivo
      // (2026-08-30): scrolling the terminal's own scrollback moved
      // backwards (wheel down scrolled UP). Root-caused to xterm's
      // vendored VS Code scrollbar code
      // (@xterm/xterm/src/vs/base/browser/mouseEvent.ts,
      // `StandardWheelEvent`): for a modern pixel-mode wheel event it
      // computes `this.deltaY = -e.deltaY / 40`, a deliberate sign flip
      // baked into that vendored code — correct for the platforms VS
      // Code itself was tuned against, but it nets out backwards against
      // real wheel events in this app's actual Electron+Wayland
      // environment (confirmed live via CDP `Input.dispatchMouseEvent`
      // with a real `mouseWheel` type — not a plain synthetic
      // `WheelEvent`, which doesn't reproduce this). Negating `deltaY` a
      // second time here cancels that out before xterm's own listener
      // ever sees it — the same shape of fix already applied once in
      // this app for the BrowserCard's own wheel forwarding
      // (`sendInputEvent`'s delta sign, browser-registry.ts).
      function correctZoomCoords(e: Event) {
        const z = zoomRef.current;
        if (z === 1) return;
        if ((e as any).__zoomCorrected) return;
        const me = e as MouseEvent;
        e.stopImmediatePropagation();
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + (me.clientX - rect.left) / z;
        const clientY = rect.top + (me.clientY - rect.top) / z;
        const init: MouseEventInit = {
          bubbles: me.bubbles,
          cancelable: me.cancelable,
          composed: me.composed,
          clientX,
          clientY,
          button: me.button,
          buttons: me.buttons,
          detail: me.detail,
          ctrlKey: me.ctrlKey,
          shiftKey: me.shiftKey,
          altKey: me.altKey,
          metaKey: me.metaKey,
          relatedTarget: me.relatedTarget,
          view: window,
        };
        const corrected = new MouseEvent(e.type, init);
        (corrected as any).__zoomCorrected = true;
        (e.target as EventTarget | null)?.dispatchEvent(corrected);
      }
      for (const type of ZOOM_MOUSE_EVENT_TYPES) {
        el.addEventListener(type, correctZoomCoords, { capture: true });
      }

      removeDomListeners = () => {
        for (const type of ZOOM_MOUSE_EVENT_TYPES) {
          el.removeEventListener(type, correctZoomCoords, { capture: true });
        }
        el.removeEventListener("paste", onPaste, { capture: true });
        el.removeEventListener("keydown", onKeyDown, { capture: true });
      };
    }

    let removeDomListeners: (() => void) | null = null;
    attachRef.current = attach;
    if (visibleRef.current) attach();

    return () => {
      attachRef.current = null;
      removeDomListeners?.();
    };
  }, [containerRef, ptyId]);

  // Effect 4: reacts to `visible` becoming true and triggers Effect 3's
  // attach function (item 34) — kept as its own tiny effect so Effect 3
  // itself doesn't need `visible` in its dependency array (which would
  // tear its DOM listeners down on every pan-out/pan-in, defeating the
  // whole fix). No cleanup needed: this effect doesn't register anything
  // of its own, it only ever calls a function Effect 3 owns.
  useEffect(() => {
    if (visible) attachRef.current?.();
  }, [visible]);

  // Effect 5 (item 57 ponto 10, Trilha A) — every terminal now, `bash`
  // included (see `FONT_ZOOM_INFLUENCE`'s own comment — the exclusion
  // existed only because the fix used to be a small "levemente mais
  // nítido" nudge, not a real anti-blur fix; now that it closes the whole
  // gap, there's no reason a plain shell should stay blurry while an
  // agent terminal doesn't). Reruns on every zoom tick during a drag-zoom
  // gesture, but the expensive part (mutating `fontSize` — reallocates
  // xterm's WebGL glyph atlas — plus a real `fit()`/PTY resize) only
  // happens when the ROUNDED-to-0.1 zoom step actually changed since the
  // last time this fired, via `lastFontZoomStepRef`; every other rerun is
  // a single ref comparison.
  const lastFontZoomStepRef = useRef<number | null>(null);
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const step = Math.round(zoom * 10) / 10;
    if (lastFontZoomStepRef.current === step) return;
    lastFontZoomStepRef.current = step;
    const newSize = fontSizeForZoom(step);
    if (term.options.fontSize === newSize) return;
    term.options.fontSize = newSize;
    fit.fit();
    if (ptyIdRef.current) void window.pty.resize(ptyIdRef.current, term.cols, term.rows);
  }, [zoom]);

  function fitNow() {
    const fit = fitRef.current;
    const term = termRef.current;
    const id = ptyIdRef.current;
    if (!fit || !term) return;
    fit.fit();
    if (id) void window.pty.resize(id, term.cols, term.rows);
  }

  function interrupt() {
    if (ptyIdRef.current) void window.pty.interrupt(ptyIdRef.current);
  }

  return { ptyId, exitCode, spawnError, installHint, discoveredResumeId, fitNow, interrupt };
}
