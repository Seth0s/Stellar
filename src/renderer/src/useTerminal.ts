import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { toast } from "./useToast";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const ZOOM_MOUSE_EVENT_TYPES = ["mousedown", "mouseup", "mousemove", "wheel"] as const;

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
export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  id: string,
  providerId: string,
  cwd: string,
  resumeId: string | null,
  continueLast: boolean,
  model: string | null,
  systemPrompt: string | null,
  visible: boolean,
  zoom: number,
) {
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [discoveredResumeId, setDiscoveredResumeId] = useState<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Spawn-time-only options, read via ref instead of effect deps below — see
  // the comment on Effect 1's dependency array for why.
  const spawnOptsRef = useRef({ resumeId, continueLast, model, systemPrompt });
  spawnOptsRef.current = { resumeId, continueLast, model, systemPrompt };

  // Effect 1: PTY lifecycle. Independent of the container/visible — spawns
  // once per identity and keeps running regardless of on-screen visibility.
  useEffect(() => {
    let disposed = false;
    const { resumeId, continueLast, model, systemPrompt } = spawnOptsRef.current;
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
        return;
      }
      ptyIdRef.current = result.id;
      setPtyId(result.id);
    });

    const offData = window.pty.onData((id, data) => {
      if (id === ptyIdRef.current) termRef.current?.write(data);
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
      const t = new Terminal({ fontSize: 15, cursorBlink: true, fontFamily: '"JetBrains Mono", monospace' });
      const f = new FitAddon();
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
      return { t, f };
    }
    const { t: term, f: fit } = buildTerminal(true);
    termRef.current = term;
    fitRef.current = fit;
    const onTermData = term.onData((data) => {
      if (ptyIdRef.current) void window.pty.write(ptyIdRef.current, data);
    });
    return () => {
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

    function attach() {
      if (openedRef.current) return;
      let term = termRef.current;
      let fit = fitRef.current;
      if (!term || !fit || !el) return;
      openedRef.current = true;
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
      const t = new Terminal({ fontSize: 15, cursorBlink: true, fontFamily: '"JetBrains Mono", monospace' });
      const f = new FitAddon();
      t.loadAddon(f);
      return { t, f };
    }

    function registerDomListeners(term: Terminal, _fit: FitAddon, el: HTMLDivElement) {
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
          void window.pty.write(ptyIdRef.current!, `"${result.path}" `);
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
      function correctZoomCoords(e: Event) {
        const z = zoomRef.current;
        if (z === 1 || (e as any).__zoomCorrected) return;
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
        const corrected =
          e.type === "wheel"
            ? new WheelEvent("wheel", {
                ...init,
                deltaX: (e as WheelEvent).deltaX,
                deltaY: (e as WheelEvent).deltaY,
                deltaZ: (e as WheelEvent).deltaZ,
                deltaMode: (e as WheelEvent).deltaMode,
              })
            : new MouseEvent(e.type, init);
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

  return { ptyId, exitCode, spawnError, discoveredResumeId, fitNow, interrupt };
}
