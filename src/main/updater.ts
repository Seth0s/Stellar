import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { app, ipcMain, type BrowserWindow } from "electron";
import {
  UPDATE_FEED_FILENAME,
  UPDATE_FEED_OVERRIDE_ENV,
  decideUpdateFeed,
  type UpdateFeedState,
} from "./update-feed-decision";
import { decideUpdateInstall, type UpdateInstallState } from "./update-install-decision";
import { parseReleaseNotes } from "../shared/release-notes";
import { readUpdatePrefs, writeRemindLaterVersion } from "./update-prefs";
import {
  MAC_SWAP_LOG_FILENAME,
  bundlePathFromExe,
  macSwapNodeIo,
  performMacSwap,
  pickMacZipSha512,
} from "./mac-update-swap";
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
/**
 * OS FATOS que decidem o feed, lidos do PACOTE EM EXECUÇÃO — nunca de um
 * literal TypeScript (task 5fb0c21b: uma fonte só, `build.publish` →
 * `resources/app-update.yml`).
 */
function readFeedFacts(): { appUpdateYmlPresent: boolean; overrideUrl: string | null } {
  const override = process.env[UPDATE_FEED_OVERRIDE_ENV];
  return {
    appUpdateYmlPresent: existsSync(join(process.resourcesPath, UPDATE_FEED_FILENAME)),
    overrideUrl: override === undefined || override.trim() === "" ? null : override.trim(),
  };
}

/** `resources/package-type` (escrito pelo target fpm do electron-builder) — é o
 *  que faz a lib escolher `RpmUpdater`/`DebUpdater` em vez do AppImageUpdater.
 *  Ausente = a lib DESLIGA o updater num Linux que não é AppImage (medido em
 *  `AppImageUpdater.isUpdaterActive`). */
function readPackageType(): string | null {
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim();
  } catch {
    return null;
  }
}

/** A URL da release mais recente, quando a identidade do feed esta no
 * `app-update.yml` que o build gerou — a MESMA fonte do feed, nao um segundo
 * literal. Com override (verificacao) nao ha release para linkar. */
function releaseUrlFor(source: "app-update.yml" | "override"): string | null {
  if (source === "override") return null;
  try {
    const yml = readFileSync(join(process.resourcesPath, UPDATE_FEED_FILENAME), "utf8");
    const owner = /^owner:\s*(.+)$/m.exec(yml)?.[1]?.trim();
    const repo = /^repo:\s*(.+)$/m.exec(yml)?.[1]?.trim();
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo}/releases/latest`;
  } catch {
    return null;
  }
}

function installState(): UpdateInstallState {
  return decideUpdateInstall({
    platform: process.platform,
    isPackaged: app.isPackaged,
    appImageEnv: process.env.APPIMAGE !== undefined && process.env.APPIMAGE !== "",
    packageType: readPackageType(),
  });
}

/** O sha512 do zip do mac, guardado pelo último check (o feed é quem declara). */
let lastMacZipSha512: string | null = null;

/**
 * Onde a troca no mac escreve cada passo. O caminho é DITO na UI (`swapLogPath`
 * na resposta do install) — é o arquivo que o testador do Mac manda se algo
 * falhar. Nada de credencial nem de caminho pessoal além do userData.
 */
const macSwapLogPath = (): string => join(app.getPath("userData"), MAC_SWAP_LOG_FILENAME);

export function registerUpdater(win: BrowserWindow) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  function send(channel: string, ...args: unknown[]) {
    if (win.isDestroyed()) return;
    win.webContents.send(channel, ...args);
  }

  autoUpdater.on("update-available", (info) => {
    // A LINHA QUE A PROVA LÊ (task 5fb0c21b): o evento REAL do
    // electron-updater, com a versão que o feed ofereceu — o registro do lado
    // do MAIN que o smoke do feed local confere (o renderer tem o seu, via
    // CDP). É diagnóstico honesto: em uso normal ela sai uma vez por boot no
    // primeiro aviso.
    console.info(
      `[updater] update-available ${info.version} (feed: ${readFeedFacts().overrideUrl ?? UPDATE_FEED_FILENAME})`,
    );
    // `info.releaseNotes` can be a string (GitHub provider — the release
    // body, as written) or an array of per-version note objects depending on
    // provider/update path. O CORPO é o caso do provider GitHub e é ele que
    // traz a seção de commits (ver `shared/release-notes.ts`); o formato de
    // array não é interpretado aqui — sem lista, o dropdown simplesmente não
    // aparece, em vez de inventar commit.
    const notes = parseReleaseNotes(
      typeof info.releaseNotes === "string" ? info.releaseNotes : null,
    );
    send("updater:available", info.version, notes.changelog, notes.commits);
  });
  autoUpdater.on("error", (err) => console.warn("[updater]", err.message));
  autoUpdater.on("update-downloaded", () => send("updater:downloaded"));

  ipcMain.handle("updater:check", async () => {
    // Never in dev — electron-updater throws synchronously ("only
    // intended to run in a packaged app") instead of failing soft, which
    // would crash `npm run dev` on every boot.
    if (!app.isPackaged) return { checked: false };
    // Sem feed configurado não há o que checar, e dizer isso é o ponto —
    // ver update-feed-decision.ts.
    const facts = readFeedFacts();
    const feed: UpdateFeedState = decideUpdateFeed(facts);
    if (!feed.configured) {
      return {
        checked: false,
        unavailable: feed.message,
        feed,
        install: installState(),
        releaseUrl: null,
      };
    }
    // O OVERRIDE (verificação) aponta a lib para outro feed sem tocar no
    // pacote: `setFeedURL` é o caminho público do electron-updater para isso.
    if (feed.source === "override" && facts.overrideUrl !== null) {
      autoUpdater.setFeedURL({ provider: "generic", url: facts.overrideUrl });
    }
    try {
      const check = await autoUpdater.checkForUpdates();
      // O sha512 do ZIP do mac, declarado pelo feed — é ele que a troca confere
      // ANTES de usar o pacote (o `MacUpdater` escolhe o zip do mesmo jeito:
      // `findFile(files, "zip", ["pkg", "dmg"])`).
      lastMacZipSha512 = pickMacZipSha512(check?.updateInfo?.files ?? []);
      return {
        checked: true,
        feed,
        install: installState(),
        releaseUrl: releaseUrlFor(feed.source),
        currentVersion: app.getVersion(),
        remindLaterVersion: readUpdatePrefs(app.getPath("userData")).remindLaterVersion,
      };
    } catch (err) {
      console.warn("[updater] check failed:", err);
      // O 404 ERA ENGOLIDO, e isso deixou de valer (task 5fb0c21b): o
      // tratamento antigo (2026-09-03) existia porque o repo de publish era
      // PRIVADO e toda checagem sem token dava 404 — "configuração atual", não
      // erro. Com o repo PÚBLICO (`Seth0s/Stellar`, releases com
      // `latest-linux.yml`), 404 significa que o feed NÃO ESTÁ no lugar: release
      // sem o asset, tag apagada, feed quebrado. Engolir isso devolveria o
      // mesmo formato de "checou e não há novidade" — a mentira que
      // `update-feed-decision.ts` existe para não repetir. Então 404 vira ERRO
      // com uma mensagem que diz o que provavelmente aconteceu.
      if (
        err instanceof Error &&
        "statusCode" in err &&
        (err as { statusCode?: number }).statusCode === 404
      ) {
        return {
          checked: false,
          error:
            "O feed de atualização respondeu 404 — a release mais recente provavelmente está sem o arquivo `latest-linux.yml`.",
          feed,
          install: installState(),
          releaseUrl: null,
          currentVersion: app.getVersion(),
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        checked: false,
        error: message,
        feed,
        install: installState(),
        releaseUrl: releaseUrlFor(feed.source),
        currentVersion: app.getVersion(),
      };
    }
  });

  // Test-only trigger (item 17's E2E coverage) — `update-available` only
  // ever fires for real from a packaged build with a working publish feed
  // (see the PENDENTE note above), so there's no way to exercise the
  // renderer UI (banner/changelog/dot) against the real event in dev.
  // Guarded the same way every other updater IPC handler already is
  // (`app.isPackaged`) — inert, a no-op, in any real build a user runs.
  /** "Lembrar mais tarde" PERSISTIDO (task 5fb0c21b, item 5): o renderer diz
   *  qual versão adiar e o main grava. `null` limpa (o usuário voltou atrás). */
  ipcMain.handle("updater:remind-later", (_e, version: string | null) => {
    const next = writeRemindLaterVersion(app.getPath("userData"), version);
    return { ok: true, remindLaterVersion: next.remindLaterVersion };
  });

  ipcMain.handle(
    "updater:test-emit-available",
    (_e, version: string, releaseNotes: string | null) => {
      if (app.isPackaged) return;
      send("updater:available", version, releaseNotes);
    },
  );

  ipcMain.handle("updater:install", async () => {
    if (!app.isPackaged) return { ok: false, error: "dev build" };
    // A VERDADE ANTES DA TENTATIVA (task 5fb0c21b, item 2): no formato que o
    // dono usa (rpm sem `package-type`) a lib nem chega a instalar — dizer
    // "baixe o rpm" é melhor que um botão que baixa e falha no meio.
    const install = installState();
    if (!install.canInstall) return { ok: false, error: install.message, install };

    // ---- MAC: A TROCA É NOSSA (task d0fef4e7) ----
    // A lib NÃO instala aqui (Squirrel/ShipIt exige bundle assinado); o que ela
    // faz é baixar o zip. Depois disso quem troca é o script de
    // `mac-update-swap.ts`, fora deste processo.
    if (install.how === "mac-swap") {
      const bundle = bundlePathFromExe(app.getPath("exe"));
      if (bundle === null) {
        return {
          ok: false,
          error:
            "Não consegui identificar o bundle .app em execução — baixe a versão nova pela release.",
          install,
        };
      }
      try {
        await autoUpdater.downloadUpdate();
        const downloaded = (
          autoUpdater as unknown as { downloadedUpdateHelper?: { file?: string } }
        ).downloadedUpdateHelper;
        const zipPath = downloaded?.file;
        if (typeof zipPath !== "string" || !existsSync(zipPath)) {
          return {
            ok: false,
            error:
              "O electron-updater não disse onde baixou o pacote — baixe a versão nova pela release.",
            install,
            swapLogPath: macSwapLogPath(),
          };
        }
        const expected = lastMacZipSha512 ?? "";
        if (expected === "") {
          return {
            ok: false,
            error: "A checagem não deixou o sha512 do pacote — não vou instalar sem conferir.",
            install,
            swapLogPath: macSwapLogPath(),
          };
        }
        const workDir = mkdtempSync(join(tmpdir(), "stellar-swap-"));
        const result = await performMacSwap(
          {
            zipPath,
            expectedSha512: expected,
            currentBundle: bundle,
            newVersion: autoUpdater.currentVersion.version,
            logPath: macSwapLogPath(),
            workDir,
          },
          macSwapNodeIo,
        );
        if (!result.ok) {
          return {
            ok: false,
            error: `${result.error} (passo: ${result.failedStep})`,
            install,
            swapLogPath: macSwapLogPath(),
          };
        }
        // A resposta do IPC precisa SAIR antes do quit, senão o renderer não
        // mostra nada e o usuário fica sem saber o que aconteceu.
        setTimeout(() => app.quit(), 600);
        return {
          ok: true,
          install,
          swapLogPath: macSwapLogPath(),
          swap: {
            newBundle: result.newBundle,
            needsElevation: result.needsElevation,
            steps: result.steps,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          install,
          swapLogPath: macSwapLogPath(),
        };
      }
    }

    try {
      await autoUpdater.downloadUpdate();
      autoUpdater.quitAndInstall();
      return { ok: true, install };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), install };
    }
  });
}
