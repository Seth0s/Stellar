import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { StellarMark } from "./StellarMark";
import { useUpdateStatus } from "./useUpdateStatus";

/** Thin custom titlebar for the frameless window — replaces the OS chrome
 * with something that matches the app's own dark theme.
 *
 * DESIGN-BACKLOG.md item 12, achado 2 — F11/`win:toggle-fullscreen` (main/
 * index.ts) already did real OS fullscreen correctly (confirmed live via
 * CDP: window resizes to the full screen dimensions, `isFullscreen()`
 * flips true) — the bug was purely visual: this component never reacted
 * to that state at all, so the custom titlebar (with minimize/maximize
 * buttons that don't even make sense once already fullscreen) just sat
 * there taking up space regardless, which reads as "fullscreen doesn't
 * really work". Fixed by actually hiding it — real fullscreen now means
 * the header disappears, F11 (or the same shortcut) brings it back. The
 * dedicated fullscreen button is gone too (redundant with F11, and it's
 * what needed hiding in the first place). */
export function Titlebar() {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const { version: updateVersion, undismiss } = useUpdateStatus();

  useEffect(() => {
    window.winControls.isMaximized().then(setMaximized);
    const off = window.winControls.onMaximizedChange(setMaximized);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    window.winControls.isFullscreen().then(setFullscreen);
    const off = window.winControls.onFullscreenChange(setFullscreen);
    return () => {
      off();
    };
  }, []);

  // Every other floating element (Rail, Topbar's home button/breadcrumb)
  // positions itself off `--titlebar-h` in CSS — collapsing it to 0 here
  // is what lets them slide up and actually use the freed space instead
  // of leaving a blank gap where the titlebar used to be.
  useEffect(() => {
    document.documentElement.style.setProperty("--titlebar-h", fullscreen ? "0px" : "34px");
  }, [fullscreen]);

  if (fullscreen) return null;

  return (
    <div className="titlebar">
      <span className="titlebar-drag">
        <span className="titlebar-title">
          <StellarMark size={15} />
          Stellar
        </span>
      </span>
      <div className="titlebar-controls">
        {updateVersion && (
          <button
            className="titlebar-update-dot"
            title={`Atualização v${updateVersion} disponível — clique pra ver`}
            onClick={undismiss}
          >
            <span className="titlebar-update-dot-mark" />
          </button>
        )}
        <button title="Minimizar" onClick={() => window.winControls.minimize()}>
          <Icon name="winMinimize" size={14} />
        </button>
        <button title={maximized ? "Restaurar" : "Maximizar"} onClick={() => window.winControls.toggleMaximize()}>
          <Icon name={maximized ? "winRestore" : "winMaximize"} size={14} />
        </button>
        <button className="titlebar-close" title="Fechar" onClick={() => window.winControls.close()}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}
