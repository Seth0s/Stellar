import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const ZOOM_MOUSE_EVENT_TYPES = ["mousedown", "mouseup", "mousemove", "wheel"] as const;

/**
 * Splits PTY lifecycle from the xterm renderer on purpose: the PTY (a real
 * process, the actual conversation state) must survive a card leaving the
 * viewport, but xterm/WebGL — the expensive part — shouldn't exist for
 * cards nobody can see. `visible` only gates the second effect below.
 *
 * Known limitation: node-pty keeps no backlog. Whatever the process wrote
 * while `visible` was false is not replayed when it becomes true again —
 * only the process and its own state survive, not the on-screen history of
 * that interval.
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
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Effect 1: PTY lifecycle. Independent of the container/visible — spawns
  // once per identity and keeps running regardless of on-screen visibility.
  useEffect(() => {
    let disposed = false;
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
  }, [id, providerId, cwd, resumeId, continueLast, model, systemPrompt]);

  // Effect 2: xterm renderer. Only exists while visible — this is the part
  // viewport culling is for. Never touches the PTY.
  useEffect(() => {
    if (!visible) return;
    const el = containerRef.current;
    if (!el || !ptyId) return;

    function buildTerminal(withWebgl: boolean) {
      const t = new Terminal({ fontSize: 15, cursorBlink: true });
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

    let { t: term, f: fit } = buildTerminal(true);
    try {
      term.open(el);
    } catch {
      // Confirmed on this machine: an ANGLE/libGLESv2 crash surfaced here,
      // not above — WebglAddon's context creation happens lazily during
      // open(), not loadAddon(). The terminal instance may be left
      // half-initialized after that; start over clean with the plain
      // canvas2d renderer instead of trying to recover it in place.
      term.dispose();
      ({ t: term, f: fit } = buildTerminal(false));
      term.open(el);
    }
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    void window.pty.resize(ptyId, term.cols, term.rows);

    const onTermData = term.onData((data) => {
      void window.pty.write(ptyId, data);
    });

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
      const rect = el!.getBoundingClientRect();
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

    return () => {
      for (const type of ZOOM_MOUSE_EVENT_TYPES) {
        el!.removeEventListener(type, correctZoomCoords, { capture: true });
      }
      onTermData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [containerRef, visible, ptyId]);

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
