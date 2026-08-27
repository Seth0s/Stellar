import { useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import type { Rect } from "./board-model";

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

export function BrowserCard({
  id,
  rect,
  zoom,
  zIndex,
  visible,
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
  onClose,
  onCloseAnimationEnd,
  onConnectorStart,
  onSelectStart,
}: {
  id: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  visible: boolean;
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
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const [bar, setBar] = useState(url);
  const createdRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastSizeRef = useRef({ w: 0, h: 0 });

  useEffect(() => {
    if (!createdRef.current) {
      createdRef.current = true;
      void window.browser.create(id, url);
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
      if (navId === id) setBar(navUrl);
    });
    return () => {
      offNav();
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

  useEffect(() => {
    const w = Math.round(rect.w);
    const h = Math.round(rect.h);
    if (lastSizeRef.current.w === w && lastSizeRef.current.h === h) return;
    lastSizeRef.current = { w, h };
    void window.browser.resize(id, w, h);
  }, [id, rect.w, rect.h]);

  function toCanvasPoint(e: React.PointerEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    // The embedded page's own coordinate space is `rect.w`×`rect.h`
    // (logical CSS px — what `resize()` sets the offscreen window's
    // content size to), not necessarily `canvas.width`/`height` — mapping
    // through the canvas's own pixel size assumes those always match,
    // which happened to hold before but isn't guaranteed by anything.
    return {
      x: ((e.clientX - box.left) / box.width) * rect.w,
      y: ((e.clientY - box.top) / box.height) * rect.h,
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
    // insertText/paste/copy/cut doc comment). Still forward the raw keyDown
    // below too (harmless, matches what a page's own shortcut-handling
    // keydown listener would see in a real browser), but do the actual
    // data movement through the dedicated Electron API.
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "v" || e.key === "V")) void window.browser.paste(id);
    else if (mod && (e.key === "c" || e.key === "C")) void window.browser.copy(id);
    else if (mod && (e.key === "x" || e.key === "X")) void window.browser.cut(id);

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

  return (
    <CardFrame
      className="browser-card"
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
      headerContent={
        <div className="browser-card-address">
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
            <span className="browser-card-owner" title={`aberto por card #${ownerCardId}`}>
              #{ownerCardId}
            </span>
          )}
          <button onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>
      }
    >
      <canvas
        ref={canvasRef}
        className="browser-card-body"
        tabIndex={0}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onWheel={onCanvasWheel}
        onKeyDown={onCanvasKeyDown}
        onKeyUp={onCanvasKeyUp}
        onCompositionEnd={onCanvasCompositionEnd}
      />
    </CardFrame>
  );
}
