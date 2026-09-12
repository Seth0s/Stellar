import { memo, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import type { Rect } from "./board-model";
import { keyEventToKeysym } from "./keysyms";
import styles from "./RemoteWindowCard.module.css";

type Phase = "idle" | "requesting" | "live" | "error";

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function RemoteWindowCardInner({
  rect,
  zoom,
  zIndex,
  interactionMode,
  selected,
  reflowing,
  closing,
  displayName,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onConnectorStart,
  onSelectStart,
  screenProjected,
  panX,
  panY,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  displayName: string;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through, same pattern the other migrated kinds use. The
   * relative pointer/keyboard forwarding below (`onVideoPointerMove` etc.,
   * `e.movementX/Y`) never touches board zoom/pan math at all, so unlike
   * Terminal there's no coordinate-correction concern here. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [controlling, setControlling] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    setPhase("requesting");
    setError("");
    try {
      // No custom source picker here — the earlier finding (see
      // DESIGN-BACKLOG.md item 3) was that `desktopCapturer.getSources()`
      // can't enumerate real windows on this Wayland/GNOME session (one
      // generic empty-name source, no thumbnails). `getDisplayMedia()`
      // sidesteps that entirely: main's `setDisplayMediaRequestHandler`
      // hands the request to the OS's own xdg-desktop-portal ScreenCast
      // picker, which enumerates windows/screens itself, outside anything
      // Electron (or this app) has to know about.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setPhase("idle");
        setControlling(false);
        streamRef.current = null;
      });
      setPhase("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function toggleControl() {
    if (controlling) {
      setControlling(false);
      return;
    }
    // The one call that can show a real GNOME consent dialog (RemoteDesktop
    // portal's Start()) — see remote-input.ts. Shared across every card,
    // so after the first grant this resolves instantly.
    const res = await window.remoteInput.ensure();
    if (!res.granted) {
      setError(res.error);
      return;
    }
    setControlling(true);
  }

  // Relative/trackpad-style motion, deliberately not click-exact: this
  // reads a *movement delta* on the captured video element and forwards it
  // as a relative pointer move, same as picking up a trackpad and putting
  // it back down. Absolute/click-exact positioning would need to correlate
  // a click's pixel with a position in the real PipeWire video frame —
  // a different, higher-risk mechanism (see remote-input.ts's doc comment)
  // not built here; nothing below assumes it can't be added later.
  function onVideoPointerMove(e: React.PointerEvent<HTMLVideoElement>) {
    if (!controlling) return;
    window.remoteInput.move(e.movementX, e.movementY);
  }
  function onVideoPointerDown(e: React.PointerEvent<HTMLVideoElement>) {
    if (!controlling) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    window.remoteInput.button(e.button, true);
  }
  function onVideoPointerUp(e: React.PointerEvent<HTMLVideoElement>) {
    if (!controlling) return;
    window.remoteInput.button(e.button, false);
  }
  function onVideoWheel(e: React.WheelEvent<HTMLVideoElement>) {
    if (!controlling) return;
    e.preventDefault();
    window.remoteInput.scroll(e.deltaX, e.deltaY);
  }
  function onVideoKeyDown(e: React.KeyboardEvent<HTMLVideoElement>) {
    if (!controlling) return;
    const keysym = keyEventToKeysym(e.key);
    if (keysym === null) return;
    e.preventDefault();
    window.remoteInput.keysym(keysym, true);
  }
  function onVideoKeyUp(e: React.KeyboardEvent<HTMLVideoElement>) {
    if (!controlling) return;
    const keysym = keyEventToKeysym(e.key);
    if (keysym === null) return;
    e.preventDefault();
    window.remoteInput.keysym(keysym, false);
  }

  return (
    <CardFrame
      className=""
      kind="remote-window"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      displayName={displayName}
      onRename={onRename}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      interactionMode={interactionMode}
      selected={selected}
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
        <>
          <span className="card-head-label">
            <Icon name="remoteWindow" size={14} />
          </span>
          {phase === "live" && (
            <button
              className={controlling ? "active" : ""}
              title={controlling ? t("remote.stopControl") : t("remote.startControl")}
              onClick={toggleControl}
            >
              <Icon name={controlling ? "controlOn" : "controlOff"} size={12} />
            </button>
          )}
          <button onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </>
      }
    >
      <div className={styles.remoteWindowBody}>
        {phase !== "live" && (
          <div className={styles.remoteWindowPlaceholder}>
            {phase === "error" ? (
              <>
                <span className={styles.remoteWindowError}>{error || t("remote.captureFail")}</span>
                <button className="primary" onClick={start}>
                  {t("remote.tryAgain")}
                </button>
              </>
            ) : (
              <button className="primary" onClick={start} disabled={phase === "requesting"}>
                {phase === "requesting" ? t("remote.awaitingChoice") : t("remote.chooseWindow")}
              </button>
            )}
          </div>
        )}
        <video
          ref={videoRef}
          className={`${styles.remoteWindowVideo}${phase === "live" ? "" : ` ${styles.hidden}`}${controlling ? ` ${styles.controlling}` : ""}`}
          autoPlay
          muted
          tabIndex={controlling ? 0 : -1}
          onPointerMove={onVideoPointerMove}
          onPointerDown={onVideoPointerDown}
          onPointerUp={onVideoPointerUp}
          onWheel={onVideoWheel}
          onKeyDown={onVideoKeyDown}
          onKeyUp={onVideoKeyUp}
        />
        {phase === "live" && !controlling && <div className={styles.remoteWindowHint}>{t("remote.clickToControl")}</div>}
      </div>
    </CardFrame>
  );
}

export const RemoteWindowCard = memo(RemoteWindowCardInner);
