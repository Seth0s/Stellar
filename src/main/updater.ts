import { app, ipcMain, type BrowserWindow } from "electron";
import { decideUpdateFeed } from "./update-feed-decision";
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
 * FEED (2026-09-15): o projeto saiu do GitHub para um GitLab próprio e o
 * `release.yml` que publicava o feed foi junto. Enquanto a VPS de
 * distribuição não existe, `build.publish` fica vazio e
 * `decideUpdateFeed` devolve "sem feed" — um estado DECLARADO, que a UI
 * mostra, em vez de um "sem novidades" que seria mentira. Quando a VPS
 * subir, basta devolver `publish` ao package.json.
 */
/** `build.publish` do package.json embutido. Vazio enquanto a
 * distribuição por VPS não existe (saída do GitHub, 2026-09-15). */
const FEED_PUBLISH_CONFIG: unknown = undefined;

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
    // Sem feed configurado não há o que checar, e dizer isso é o ponto —
    // ver update-feed-decision.ts.
    const feed = decideUpdateFeed(FEED_PUBLISH_CONFIG);
    if (!feed.configured) return { checked: false, unavailable: feed.message };
    try {
      await autoUpdater.checkForUpdates();
      return { checked: true };
    } catch (err) {
      console.warn("[updater] check failed:", err);
      // Achado ao vivo (2026-09-03): repo de publish (`Seth0s/Stellar`) é
      // privado por decisão do usuário — toda checagem sem token dá 404
      // no feed `releases.atom`, sempre, não é uma falha transitória.
      // electron-updater devolve isso como `HttpError` (statusCode 404)
      // com uma mensagem que embute o corpo/headers crus da resposta e um
      // texto genérico de "confira seu token de autenticação" — enganoso
      // aqui (não existe token nenhum embutido no app pra conferir) e
      // feio o bastante pra assustar quem só está usando o app. Tratado
      // como "sem checagem disponível" (mesmo formato de sucesso sem
      // update, sem `error`) em vez de virar `checkError` visível — repo
      // privado não é um estado de erro pro usuário, é a configuração
      // atual. Qualquer OUTRA falha (rede, rate-limit, etc.) continua
      // surfaceando normalmente.
      if (err instanceof Error && "statusCode" in err && (err as { statusCode?: number }).statusCode === 404) {
        return { checked: false };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { checked: false, error: message };
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
