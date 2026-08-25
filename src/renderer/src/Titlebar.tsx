import { useEffect, useState } from "react";
import { Icon } from "./icons";

/** Thin custom titlebar for the frameless window — replaces the OS chrome
 * with something that matches the app's own dark theme. */
export function Titlebar() {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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

  return (
    <div className="titlebar">
      <span className="titlebar-drag">
        <span className="titlebar-title">agent-canvas</span>
      </span>
      <div className="titlebar-controls">
        <button
          title={fullscreen ? "Sair da tela cheia (F11)" : "Tela cheia (F11)"}
          onClick={() => window.winControls.toggleFullscreen()}
        >
          <Icon name={fullscreen ? "fullscreenExit" : "fullscreenEnter"} size={14} />
        </button>
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
