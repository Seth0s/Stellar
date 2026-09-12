import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import { Icon } from "./icons";
import { StellarMark } from "./StellarMark";
import { useUpdateStatus } from "./useUpdateStatus";

// Header nativo do Mac (2026-09-08) — `main/index.ts`'s `titleBarStyle:
// "hidden"` só existe no darwin (`frame:false` nas outras plataformas,
// window chrome 100% custom como sempre foi). Lido no module scope (não
// num useEffect) porque precisa valer já no primeiro render, antes de
// qualquer pintura — o preload já rodou e populou `window.system` antes
// deste módulo carregar, então não há corrida. `data-platform` no
// `<html>` é o hook que `layout.css` usa pra abrir espaço pros traffic
// lights nativos sem duplicar essa checagem em CSS-in-JS.
const isMac = window.system.platform === "darwin";
document.documentElement.dataset.platform = window.system.platform;

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
  const { version: updateVersion, checking: updateChecking, checkError: updateCheckError, undismiss, checkNow } = useUpdateStatus();

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
        <button
          className={`titlebar-update-check${updateChecking ? " is-checking" : ""}${updateCheckError ? " has-error" : ""}`}
          title={
            updateChecking
              ? t("titlebar.checkingUpdate")
              : updateCheckError
                ? t("titlebar.checkUpdateFail", { error: updateCheckError })
                : t("titlebar.checkUpdate")
          }
          onClick={checkNow}
        >
          <Icon name="reload" size={14} />
        </button>
        {updateVersion && (
          <button
            className="titlebar-update-dot"
            title={t("titlebar.updateAvailable", { version: updateVersion })}
            onClick={undismiss}
          >
            <span className="titlebar-update-dot-mark" />
          </button>
        )}
        {/* No darwin, os 3 abaixo somem — o traffic-light cluster nativo
            do `titleBarStyle: "hidden"` (main/index.ts) já minimiza/
            maximiza/fecha, desenhado pelo próprio macOS no canto superior
            esquerdo (por isso o espaço reservado em `.titlebar-drag`,
            layout.css). Duplicar aqui só daria dois jeitos de fazer a
            mesma coisa, um deles falso (estes não são os controles reais
            da janela no Mac). */}
        {!isMac && (
          <>
            <button title={t("titlebar.minimize")} onClick={() => window.winControls.minimize()}>
              <Icon name="winMinimize" size={14} />
            </button>
            <button title={maximized ? t("titlebar.restore") : t("titlebar.maximize")} onClick={() => window.winControls.toggleMaximize()}>
              <Icon name={maximized ? "winRestore" : "winMaximize"} size={14} />
            </button>
            <button className="titlebar-close" title={t("titlebar.close")} onClick={() => window.winControls.close()}>
              <Icon name="close" size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
