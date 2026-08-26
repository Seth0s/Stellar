import { app, ipcMain, type BrowserWindow } from "electron";
// `electron-updater` is CommonJS with no static `exports.autoUpdater` a
// named ESM import can see — the bundled main process (ESM output,
// electron-vite) crashed the whole app on boot with "Named export
// 'autoUpdater' not found" until this went through the default export
// instead (confirmed live, the exact fix Node's own error message
// suggests).
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;

/**
 * In-app updater (DESIGN-BACKLOG.md item 13, "updater e padronizar
 * organização do pacote") — same product-behavior contract CentralByte's
 * own updater already ships (see its docs/packaging.md §6.2), ported to
 * `electron-updater`/GitHub Releases since this app is Electron, not
 * Tauri:
 *
 * - Check once at boot, silently — no toast/UI if there's no update, no
 *   network, or no publish feed configured yet (just `console.warn`).
 * - Never auto-download or auto-install. `checkForUpdates()` only learns
 *   whether one exists; downloading and restarting only happen from an
 *   explicit `install()` call, itself only reachable from the user
 *   clicking the update pill in the UI (`UpdateBanner.tsx`).
 * - Any failure (network, signature, no feed) surfaces to the renderer as
 *   a plain error string instead of installing anything.
 *
 * PENDENTE (see docs/packaging.md): no `publish` block in package.json
 * yet — this repo's real GitHub remote is still unresolved (see
 * DESIGN-BACKLOG.md item 13's write-up), so `checkForUpdates()` will
 * reliably fail with "no publish configured" until that's filled in.
 * That's expected, not a bug in this file — the code is ready the same
 * way CentralByte's was before its own GitHub secret landed.
 */
export function registerUpdater(win: BrowserWindow) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  function send(channel: string, ...args: unknown[]) {
    if (win.isDestroyed()) return;
    win.webContents.send(channel, ...args);
  }

  autoUpdater.on("update-available", (info) =>
    // `info.releaseNotes` can be a string (GitHub provider — the release
    // body, as written) or an array of per-version note objects
    // depending on provider/update path; only the plain-string shape is
    // rendered (item 6 addendum — no markdown parser pulled back in just
    // for this, `UpdateBanner` shows it as preformatted text).
    send("updater:available", info.version, typeof info.releaseNotes === "string" ? info.releaseNotes : null),
  );
  autoUpdater.on("error", (err) => console.warn("[updater]", err.message));
  autoUpdater.on("update-downloaded", () => send("updater:downloaded"));

  ipcMain.handle("updater:check", async () => {
    // Never in dev — electron-updater throws synchronously ("only
    // intended to run in a packaged app") instead of failing soft, which
    // would crash `npm run dev` on every boot.
    if (!app.isPackaged) return { checked: false };
    try {
      await autoUpdater.checkForUpdates();
      return { checked: true };
    } catch (err) {
      console.warn("[updater] check failed:", err);
      return { checked: false };
    }
  });

  // Test-only trigger (item 17's E2E coverage) — `update-available` only
  // ever fires for real from a packaged build with a working publish feed
  // (see the PENDENTE note above), so there's no way to exercise the
  // renderer UI (banner/changelog/dot) against the real event in dev.
  // Guarded the same way every other updater IPC handler already is
  // (`app.isPackaged`) — inert, a no-op, in any real build a user runs.
  ipcMain.handle("updater:test-emit-available", (_e, version: string, releaseNotes: string | null) => {
    if (app.isPackaged) return;
    send("updater:available", version, releaseNotes);
  });

  ipcMain.handle("updater:install", async () => {
    if (!app.isPackaged) return { ok: false, error: "dev build" };
    try {
      await autoUpdater.downloadUpdate();
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
